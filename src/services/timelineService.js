const ConnectionLog = require('../models/ConnectionLog');
const { heartbeatTimeoutMs } = require('../config/env');

// A disconnect followed by a reconnect within this window counts as one
// unbroken "connected" period when the device ended the session on purpose
// (its 5-minute anti-freeze reboot) or the server bounced — neither is an
// outage. Long enough for boot + WiFi + auth.
const RECONNECT_GRACE_MS = 60_000;
const BENIGN_END_REASONS = new Set(['planned_restart', 'replaced', 'server_restart']);
const STATES = ['connected', 'unreachable', 'power_cut'];

// 'timeout' sessions are only closed heartbeatTimeoutMs after the last
// message, so the device really went dark that much earlier.
function effectiveEnd(log) {
  const end = log.disconnectedAt.getTime();
  if (log.endReason !== 'timeout') return end;
  return Math.max(log.connectedAt.getTime(), end - heartbeatTimeoutMs);
}

// The board itself lost power: the session after the gap is the first since
// a power-on/brownout boot. Anything else (WiFi drop, server unreachable,
// software reboot) is only "unreachable" — the cause can't be confirmed.
function isPowerLossBoot(log) {
  return log.firstSinceBoot === true && ['power_on', 'brownout'].includes(log.resetReason);
}

function bootAt(log) {
  const start = log.connectedAt.getTime();
  return Number.isFinite(log.bootToConnectMs) ? start - log.bootToConnectMs : start;
}

/**
 * Turns the raw per-socket connection logs into alternating periods, oldest
 * first:
 *   connected   — the device was online (scheduled reboots merged in)
 *   power_cut   — offline, and it came back from a power-on boot
 *   unreachable — offline for any other reason, or still offline now
 * The last period is open (endedAt null) — it's what the live timer counts.
 * ongoingGapState: what to call a gap that's still open — 'power_cut' once
 * the outage detector has flagged the device, otherwise 'unreachable'.
 */
function buildSegments(logs, now = Date.now(), { ongoingGapState = 'unreachable' } = {}) {
  const segments = [];
  let current = null; // the 'connected' period being accumulated

  function pushCurrent() {
    segments.push({
      state: 'connected',
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      endReason: current.endReason,
      sessions: current.sessions,
    });
  }

  function startFrom(log, end) {
    current = { startedAt: log.connectedAt.getTime(), endedAt: end, endReason: log.endReason, sessions: 1 };
  }

  for (const log of logs) {
    const start = log.connectedAt.getTime();
    const end = log.disconnectedAt ? effectiveEnd(log) : null;

    if (!current) {
      startFrom(log, end);
      continue;
    }

    const powerLoss = isPowerLossBoot(log);
    const overlaps = current.endedAt === null || start <= current.endedAt;
    const quickReconnect =
      BENIGN_END_REASONS.has(current.endReason) && start - current.endedAt <= RECONNECT_GRACE_MS;

    // A power-on boot always breaks the period, even when the new session
    // overlaps the old one (the old socket hadn't timed out yet).
    if (!powerLoss && (overlaps || quickReconnect)) {
      // Newer session is the authoritative one for how the period ends.
      if (current.endedAt === null || end === null || end > current.endedAt) {
        current.endedAt = end;
        current.endReason = log.endReason;
      }
      current.sessions += 1;
      continue;
    }

    // When the power came back is known (boot time); when it went is not
    // always — bound it by the boot so the gap is never negative.
    const gapStart = Math.max(
      current.startedAt,
      Math.min(current.endedAt ?? start, powerLoss ? bootAt(log) : start)
    );
    current.endedAt = gapStart;
    pushCurrent();
    segments.push({ state: powerLoss ? 'power_cut' : 'unreachable', startedAt: gapStart, endedAt: start });
    startFrom(log, end);
  }

  if (current) {
    const awaitingReconnect =
      current.endedAt !== null &&
      BENIGN_END_REASONS.has(current.endReason) &&
      now - current.endedAt <= RECONNECT_GRACE_MS;

    if (current.endedAt === null || awaitingReconnect) {
      current.endedAt = null;
      current.endReason = null;
      pushCurrent();
    } else {
      pushCurrent();
      // The cause isn't confirmed until the board reports how it booted, so
      // follow the outage detector: once it has called a power cut (the
      // dashboard already alerted "power cut"), the live timer says so too.
      // On reconnect the closed gap is re-classified from the boot reason.
      segments.push({ state: ongoingGapState, startedAt: current.endedAt, endedAt: null });
    }
  }

  return segments
    .filter((s) => s.endedAt === null || s.endedAt > s.startedAt)
    .map((s) => ({
      ...s,
      startedAt: new Date(s.startedAt),
      endedAt: s.endedAt === null ? null : new Date(s.endedAt),
      durationMs: (s.endedAt ?? now) - s.startedAt,
    }));
}

// Portion of a segment that falls inside [from, to].
function overlapMs(segment, from, to, now) {
  const start = Math.max(segment.startedAt.getTime(), from);
  const end = Math.min(segment.endedAt ? segment.endedAt.getTime() : now, to);
  return Math.max(0, end - start);
}

function summarize(segments, from, to, now) {
  const summary = {};
  for (const state of STATES) summary[state] = { ms: 0, count: 0, longestMs: 0 };

  for (const segment of segments) {
    const ms = overlapMs(segment, from, to, now);
    const bucket = summary[segment.state];
    bucket.ms += ms;
    bucket.count += 1;
    bucket.longestMs = Math.max(bucket.longestMs, ms);
  }
  return summary;
}

/**
 * from/to: optional Date bounds. Segments overlapping the range are
 * returned whole; the summary only counts the time inside the range.
 * limit: null returns every segment in range, oldest first (for charts);
 * otherwise a page of them, newest first.
 */
async function getTimeline(device, { from, to, page = 1, limit = 20 } = {}) {
  // All logs, not just the range — a connected period can start long
  // before `from`, and merging needs its earlier sessions.
  const logs = await ConnectionLog.find({ device: device._id })
    .sort({ connectedAt: 1 })
    .select('connectedAt disconnectedAt endReason resetReason firstSinceBoot bootToConnectMs')
    .lean();

  const now = Date.now();
  const all = buildSegments(logs, now, {
    ongoingGapState: device.powerState === 'power_cut' ? 'power_cut' : 'unreachable',
  });
  const current = all.length ? all[all.length - 1] : null;

  // Periods the user deleted from the history.
  const hidden = new Set((device.hiddenSegments || []).map((h) => `${h.state}:${h.startedAt.getTime()}`));

  const fromMs = from ? from.getTime() : -Infinity;
  const toMs = to ? to.getTime() : Infinity;
  const inRange = all.filter(
    (s) =>
      !hidden.has(`${s.state}:${s.startedAt.getTime()}`) &&
      s.startedAt.getTime() <= toMs &&
      (s.endedAt ? s.endedAt.getTime() : now) >= fromMs
  );

  const segments =
    limit === null
      ? inRange
      : inRange
          .slice()
          .reverse()
          .slice((page - 1) * limit, page * limit);

  return {
    current: current && { state: current.state, since: current.startedAt },
    summary: summarize(inRange, fromMs, toMs, now),
    segments,
    total: inRange.length,
    page,
    limit,
    serverNow: new Date(now),
  };
}

module.exports = { getTimeline, buildSegments, RECONNECT_GRACE_MS };
