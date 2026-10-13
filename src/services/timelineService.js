const ConnectionLog = require('../models/ConnectionLog');
const { heartbeatTimeoutMs } = require('../config/env');

// A disconnect followed by a reconnect within this window counts as one
// unbroken "connected" period when the device ended the session on purpose
// (its 5-minute anti-freeze reboot) or the server bounced — neither is a
// power cut. Long enough for boot + WiFi + auth.
const RECONNECT_GRACE_MS = 60_000;
const BENIGN_END_REASONS = new Set(['planned_restart', 'replaced', 'server_restart']);

// 'timeout' sessions are only closed heartbeatTimeoutMs after the last
// message, so the device really went dark that much earlier.
function effectiveEnd(log) {
  const end = log.disconnectedAt.getTime();
  if (log.endReason !== 'timeout') return end;
  return Math.max(log.connectedAt.getTime(), end - heartbeatTimeoutMs);
}

/**
 * Turns the raw per-socket connection logs into alternating
 * 'connected' / 'power_cut' periods, oldest first. The last period is open
 * (endedAt null) — it's what the dashboard's live timer counts.
 */
function buildSegments(logs, now = Date.now()) {
  const segments = [];
  let current = null; // the 'connected' period being accumulated

  function closeCurrent() {
    segments.push({
      state: 'connected',
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      endReason: current.endReason,
      sessions: current.sessions,
    });
  }

  for (const log of logs) {
    const start = log.connectedAt.getTime();
    const end = log.disconnectedAt ? effectiveEnd(log) : null;

    if (!current) {
      current = { startedAt: start, endedAt: end, endReason: log.endReason, sessions: 1 };
      continue;
    }

    const overlaps = current.endedAt === null || start <= current.endedAt;
    const quickReconnect =
      BENIGN_END_REASONS.has(current.endReason) && start - current.endedAt <= RECONNECT_GRACE_MS;

    if (overlaps || quickReconnect) {
      // Newer session is the authoritative one for how the period ends.
      if (current.endedAt === null || end === null || end > current.endedAt) {
        current.endedAt = end;
        current.endReason = log.endReason;
      }
      current.sessions += 1;
      continue;
    }

    closeCurrent();
    segments.push({ state: 'power_cut', startedAt: current.endedAt, endedAt: start });
    current = { startedAt: start, endedAt: end, endReason: log.endReason, sessions: 1 };
  }

  if (current) {
    const awaitingReconnect =
      current.endedAt !== null &&
      BENIGN_END_REASONS.has(current.endReason) &&
      now - current.endedAt <= RECONNECT_GRACE_MS;

    if (current.endedAt === null || awaitingReconnect) {
      current.endedAt = null;
      current.endReason = null;
      closeCurrent();
    } else {
      closeCurrent();
      segments.push({ state: 'power_cut', startedAt: current.endedAt, endedAt: null });
    }
  }

  return segments.map((s) => ({
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
  const summary = {
    connectedMs: 0,
    powerCutMs: 0,
    connectedCount: 0,
    powerCutCount: 0,
    longestConnectedMs: 0,
    longestPowerCutMs: 0,
  };

  for (const segment of segments) {
    const ms = overlapMs(segment, from, to, now);
    if (segment.state === 'connected') {
      summary.connectedMs += ms;
      summary.connectedCount += 1;
      summary.longestConnectedMs = Math.max(summary.longestConnectedMs, ms);
    } else {
      summary.powerCutMs += ms;
      summary.powerCutCount += 1;
      summary.longestPowerCutMs = Math.max(summary.longestPowerCutMs, ms);
    }
  }
  return summary;
}

/**
 * from/to: optional Date bounds. Segments overlapping the range are
 * returned whole; the summary only counts the time inside the range.
 */
async function getTimeline(device, { from, to, page = 1, limit = 20 } = {}) {
  // All logs, not just the range — a connected period can start long
  // before `from`, and merging needs its earlier sessions.
  const logs = await ConnectionLog.find({ device: device._id })
    .sort({ connectedAt: 1 })
    .select('connectedAt disconnectedAt endReason')
    .lean();

  const now = Date.now();
  const all = buildSegments(logs, now);
  const current = all.length ? all[all.length - 1] : null;

  const fromMs = from ? from.getTime() : -Infinity;
  const toMs = to ? to.getTime() : Infinity;
  const inRange = all.filter(
    (s) => s.startedAt.getTime() <= toMs && (s.endedAt ? s.endedAt.getTime() : now) >= fromMs
  );

  const newestFirst = inRange.slice().reverse();
  const items = newestFirst.slice((page - 1) * limit, page * limit);

  return {
    current: current && { state: current.state, since: current.startedAt },
    summary: summarize(inRange, fromMs, toMs, now),
    segments: items,
    total: newestFirst.length,
    page,
    limit,
  };
}

module.exports = { getTimeline, buildSegments, RECONNECT_GRACE_MS };
