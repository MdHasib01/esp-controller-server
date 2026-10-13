const Device = require('../models/Device');
const bus = require('../ws/bus');
const {
  getTimeline,
  effectiveEnd,
  isPowerLossBoot,
  BENIGN_END_REASONS,
  RECONNECT_GRACE_MS,
} = require('./timelineService');

/**
 * The open end of each device's timeline — what the dashboard's big status
 * and timer show — kept in memory and pushed (`live_status`) the moment it
 * changes. Working it out from scratch means scanning every connection log,
 * which is what made the dashboard lag behind the LED toggle.
 *
 * The rules mirror timelineService.buildSegments for the last period. Any
 * full timeline computation (REST fetch) is fed back through reconcile(), so
 * a disagreement can only last until the next one.
 */

// deviceId -> {
//   current: { state, since } | null | undefined (undefined = not loaded yet)
//   openSessions: Set of connection log ids still open
//   pendingEnd: when the last session ended benignly (scheduled reboot),
//               while the reconnect grace runs
//   powerCut: the outage detector has flagged this device
//   changedAt: last time an event touched this entry
// }
const entries = new Map();

function entryFor(deviceId) {
  const key = String(deviceId);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      current: undefined,
      openSessions: new Set(),
      pendingEnd: null,
      powerCut: false,
      changedAt: 0,
      graceTimer: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

function sameCurrent(a, b) {
  if (!a || !b) return a === b;
  return a.state === b.state && new Date(a.since).getTime() === new Date(b.since).getTime();
}

function message(deviceId, current) {
  return {
    deviceId: String(deviceId),
    current: current && { state: current.state, since: new Date(current.since) },
    serverNow: new Date(),
  };
}

function setCurrent(deviceId, entry, current) {
  entry.current = current;
  bus.emit('live_status', message(deviceId, current));
}

function gapState(entry) {
  return entry.powerCut ? 'power_cut' : 'unreachable';
}

function clearGrace(entry) {
  clearTimeout(entry.graceTimer);
  entry.graceTimer = null;
}

// The board went dark without coming back — whatever the reason it gave.
function startGap(deviceId, entry, since) {
  clearGrace(entry);
  entry.pendingEnd = null;
  if (entry.current?.state !== 'connected') return;
  setCurrent(deviceId, entry, { state: gapState(entry), since: new Date(since) });
}

/** Recomputes from the database — for entries not loaded yet, or after history edits. */
async function refresh(deviceId) {
  const asOf = new Date();
  const device = await Device.findById(deviceId);
  if (!device) {
    entries.delete(String(deviceId));
    return;
  }
  const { current } = await getTimeline(device, { limit: 1, asOf });
  reconcile(deviceId, current, asOf);
}

function refreshInBackground(deviceId) {
  refresh(deviceId).catch((err) => console.error(`[live] refresh ${deviceId}:`, err));
}

/**
 * Adopts a freshly computed `current` unless an event landed after `asOf`
 * (the computation may not include it).
 */
function reconcile(deviceId, current, asOf) {
  const entry = entryFor(deviceId);
  if (entry.changedAt > new Date(asOf).getTime()) return;
  if (entry.current !== undefined && sameCurrent(entry.current, current)) return;
  setCurrent(deviceId, entry, current ?? null);
}

function sessionOpened(log) {
  const entry = entryFor(log.device);
  entry.changedAt = Date.now();
  entry.openSessions.add(String(log._id));
  clearGrace(entry);
  entry.pendingEnd = null;

  if (entry.current === undefined) return refreshInBackground(log.device);

  // A scheduled reboot reconnecting continues the same connected period;
  // a power-on boot always starts a new one.
  const continues = entry.current?.state === 'connected' && !isPowerLossBoot(log);
  if (!continues) setCurrent(log.device, entry, { state: 'connected', since: log.connectedAt });
}

function sessionClosed(log) {
  const entry = entryFor(log.device);
  entry.changedAt = Date.now();
  entry.openSessions.delete(String(log._id));

  if (entry.current === undefined) return refreshInBackground(log.device);
  if (entry.openSessions.size) return; // a newer session carries on

  const end = effectiveEnd(log);
  if (!BENIGN_END_REASONS.has(log.endReason) || entry.powerCut) {
    startGap(log.device, entry, end);
    return;
  }

  // Scheduled reboot: still "connected" while it gets a chance to come back.
  entry.pendingEnd = end;
  clearGrace(entry);
  entry.graceTimer = setTimeout(() => {
    entry.graceTimer = null;
    if (entry.openSessions.size || entry.pendingEnd === null) return;
    entry.changedAt = Date.now();
    startGap(log.device, entry, entry.pendingEnd);
  }, Math.max(0, end + RECONNECT_GRACE_MS - Date.now()) + 50);
  entry.graceTimer.unref?.();
}

/** Every device_status broadcast passes through — only powerState matters here. */
function deviceUpdated(device) {
  const entry = entryFor(device._id);
  const powerCut = device.powerState === 'power_cut';
  if (powerCut === entry.powerCut) return;
  entry.powerCut = powerCut;
  entry.changedAt = Date.now();
  if (!entry.current) return;

  if (entry.current.state !== 'connected') {
    setCurrent(device._id, entry, { state: gapState(entry), since: entry.current.since });
  } else if (powerCut && !entry.openSessions.size && entry.pendingEnd !== null) {
    // Flagged during a scheduled reboot's grace — it isn't coming back.
    startGap(device._id, entry, entry.pendingEnd);
  }
}

/** Loads every device once at startup, so the first events have a baseline. */
async function seedAll() {
  const devices = await Device.find().select('_id powerState');
  await Promise.all(
    devices.map(async (device) => {
      entryFor(device._id).powerCut = device.powerState === 'power_cut';
      await refresh(device._id);
    })
  );
}

/** Current state of every loaded device — sent to a dashboard as it connects. */
function snapshot() {
  const out = [];
  for (const [deviceId, entry] of entries) {
    if (entry.current !== undefined) out.push(message(deviceId, entry.current));
  }
  return out;
}

module.exports = {
  sessionOpened,
  sessionClosed,
  deviceUpdated,
  reconcile,
  refresh: refreshInBackground,
  seedAll,
  snapshot,
};
