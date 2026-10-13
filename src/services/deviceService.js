const Device = require('../models/Device');
const PowerEvent = require('../models/PowerEvent');
const ConnectionLog = require('../models/ConnectionLog');
const { heartbeatTimeoutMs } = require('../config/env');
const bus = require('../ws/bus');

// How long a device gets a pass on outage detection after announcing a
// planned restart — long enough to reboot and reconnect, short enough that
// a genuine outage starting right after is still caught quickly.
const PLANNED_RESTART_GRACE_MS = 30_000;

function publicDevice(device) {
  return {
    id: device._id,
    deviceId: device.deviceId,
    name: device.name,
    status: device.status,
    powerState: device.powerState,
    lastHeartbeatAt: device.lastHeartbeatAt,
    lastSeenOnlineAt: device.lastSeenOnlineAt,
    wakeTarget: device.wakeTarget,
    checkup: device.checkup,
    led: device.led,
    restart: device.restart,
  };
}

function broadcastDeviceStatus(device) {
  bus.emit('device_status', publicDevice(device));
}

function broadcastPowerEvent(event) {
  bus.emit('power_event', event);
}

/**
 * One alert per power transition — fans out to dashboard sound/toast and to
 * push notifications. kind: 'cut' | 'restored'.
 */
function emitPowerAlert(device, kind, fields) {
  bus.emit('power_alert', {
    kind,
    device: { id: device._id, deviceId: device.deviceId, name: device.name },
    ...fields,
  });
}

const OUTAGE_TYPES = ['outage', 'device_offline'];

/**
 * Called on every valid heartbeat/power_event message from a device's WebSocket.
 * mainsPower: true | false | undefined (undefined = firmware has no mains sensor)
 * led: true | false | undefined — the device's actual current blink state,
 *   reported so a reboot (which resets ledBlink to false on the firmware)
 *   is reflected on the dashboard instead of showing a stale "on".
 */
async function handleHeartbeat(device, { mainsPower, led } = {}) {
  const now = new Date();

  device.lastHeartbeatAt = now;
  device.lastSeenOnlineAt = now;
  device.status = 'online';
  if (led !== undefined) device.led.blinking = led;

  if (mainsPower === false) {
    await device.save();
    await triggerOutage(device, { reason: 'explicit' });
    return;
  }

  // Device is back and either confirmed power (mainsPower === true) or,
  // lacking a sensor, silence has ended so we assume power is back too.
  // Outage events are closed by query rather than by checking the (possibly
  // stale) in-memory powerState: the heartbeat sweep works on its own copy of
  // this device, and trusting either copy is what used to leave events open
  // forever with the dashboard counting from them.
  device.powerState = device.checkup.active ? 'checkup' : 'ok';
  // Written even when this copy already says ok/online — the stored value may not.
  device.markModified('powerState');
  device.markModified('status');
  await device.save();
  await resolveOutage(device, { automatic: true });
}

/**
 * reason: 'explicit' (device reported mainsPower:false while still connected)
 *       | 'timeout'  (heartbeat sweep found no signal for HEARTBEAT_TIMEOUT_MS)
 */
async function triggerOutage(device, { reason }) {
  const now = new Date();

  // Claim the ok -> power_cut transition atomically, re-checking every
  // condition against the stored document. A heartbeat that lands between
  // the sweep's read and this write makes the claim miss, so no outage is
  // opened for a device that is actually back.
  const filter = {
    _id: device._id,
    'checkup.active': false, // manual override suppresses detection
    powerState: { $ne: 'power_cut' }, // already open
    $or: [{ restartingUntil: null }, { restartingUntil: { $lte: now } }], // planned restart in progress
  };
  if (reason === 'timeout') {
    filter.lastHeartbeatAt = { $lt: new Date(now.getTime() - heartbeatTimeoutMs) };
  }
  const set = { powerState: 'power_cut' };
  if (reason === 'timeout') set.status = 'offline';

  const claimed = await Device.findOneAndUpdate(filter, { $set: set }, { new: true });
  if (!claimed) return;
  Object.assign(device, set);

  const event = await PowerEvent.create({
    device: device._id,
    type: reason === 'timeout' ? 'device_offline' : 'outage',
    startedAt: now,
  });

  broadcastDeviceStatus(claimed);
  broadcastPowerEvent(event);
  // The atomic claim above guarantees this fires once per outage.
  emitPowerAlert(claimed, 'cut', { eventType: event.type, at: now.toISOString() });
}

// Closes every open outage, not just the newest — a duplicate left open
// would otherwise keep counting on the dashboard indefinitely.
async function resolveOutage(device, { automatic }) {
  const openEvents = await PowerEvent.find({
    device: device._id,
    type: { $in: OUTAGE_TYPES },
    endedAt: null,
  });
  const endedAt = new Date();
  const closed = [];
  for (const event of openEvents) {
    // Close only if still open, so two heartbeats racing through here can't
    // both count the same event (and both send a "power back" alert).
    const updated = await PowerEvent.findOneAndUpdate(
      { _id: event._id, endedAt: null },
      {
        $set: {
          endedAt,
          durationMs: endedAt.getTime() - event.startedAt.getTime(),
          resolvedAutomatically: automatic,
        },
      },
      { new: true }
    );
    if (!updated) continue;
    closed.push(updated);
    broadcastPowerEvent(updated);
  }
  broadcastDeviceStatus(device);

  if (closed.length) {
    const startedAt = new Date(Math.min(...closed.map((e) => e.startedAt.getTime())));
    emitPowerAlert(device, 'restored', {
      at: endedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
    });
  }
}

/**
 * One-off repair for outage events left open by the old stale-copy race.
 * Each is closed at the device's first reconnect after it started (that's
 * when it really ended); one still genuinely ongoing has no such reconnect
 * and stays open.
 */
async function repairStaleOutages() {
  const open = await PowerEvent.find({ type: { $in: OUTAGE_TYPES }, endedAt: null });
  let repaired = 0;
  for (const event of open) {
    const reconnect = await ConnectionLog.findOne({
      device: event.device,
      connectedAt: { $gt: event.startedAt },
    }).sort({ connectedAt: 1 });
    if (!reconnect) continue;
    event.endedAt = reconnect.connectedAt;
    event.durationMs = event.endedAt.getTime() - event.startedAt.getTime();
    event.resolvedAutomatically = true;
    event.note = event.note || 'Closed by repair: was left open by a detection race';
    await event.save();
    repaired += 1;
  }
  return repaired;
}

async function startCheckup(device, note) {
  device.checkup = { active: true, startedAt: new Date(), note: note || null };
  device.powerState = 'checkup';
  await device.save();

  const event = await PowerEvent.create({
    device: device._id,
    type: 'checkup',
    startedAt: device.checkup.startedAt,
    note: note || null,
  });

  broadcastDeviceStatus(device);
  broadcastPowerEvent(event);
  return event;
}

async function endCheckup(device) {
  device.checkup.active = false;
  device.powerState = device.status === 'online' ? 'ok' : 'unknown';
  await device.save();

  const openEvent = await PowerEvent.findOne({
    device: device._id,
    type: 'checkup',
    endedAt: null,
  }).sort({ startedAt: -1 });

  if (openEvent) {
    openEvent.endedAt = new Date();
    openEvent.durationMs = openEvent.endedAt.getTime() - openEvent.startedAt.getTime();
    openEvent.resolvedAutomatically = false;
    await openEvent.save();
    broadcastPowerEvent(openEvent);
  }
  broadcastDeviceStatus(device);
}

async function setLedState(device, blinking) {
  device.led.blinking = blinking;
  await device.save();
  broadcastDeviceStatus(device);
}

async function beginPlannedRestart(device) {
  device.restartingUntil = new Date(Date.now() + PLANNED_RESTART_GRACE_MS);
  await device.save();
}

module.exports = {
  publicDevice,
  broadcastDeviceStatus,
  handleHeartbeat,
  triggerOutage,
  resolveOutage,
  startCheckup,
  endCheckup,
  setLedState,
  beginPlannedRestart,
  repairStaleOutages,
};
