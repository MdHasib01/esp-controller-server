const Device = require('../models/Device');
const PowerEvent = require('../models/PowerEvent');
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

async function findOpenEvent(deviceId) {
  return PowerEvent.findOne({ device: deviceId, endedAt: null }).sort({ startedAt: -1 });
}

/**
 * Called on every valid heartbeat/power_event message from a device's WebSocket.
 * mainsPower: true | false | undefined (undefined = firmware has no mains sensor)
 * led: true | false | undefined — the device's actual current blink state,
 *   reported so a reboot (which resets ledBlink to false on the firmware)
 *   is reflected on the dashboard instead of showing a stale "on".
 */
async function handleHeartbeat(device, { mainsPower, led } = {}) {
  const now = new Date();
  const wasPowerCut = device.powerState === 'power_cut';

  device.lastHeartbeatAt = now;
  device.lastSeenOnlineAt = now;
  device.status = 'online';
  if (led !== undefined) device.led.blinking = led;

  if (mainsPower === false) {
    await device.save();
    await triggerOutage(device, { reason: 'explicit' });
    return;
  }

  if (wasPowerCut) {
    // Device is back and either confirmed power (mainsPower === true) or,
    // lacking a sensor, silence has ended so we assume power is back too.
    device.powerState = device.checkup.active ? 'checkup' : 'ok';
    await device.save();
    await resolveOutage(device, { automatic: true });
    return;
  }

  device.powerState = device.checkup.active ? 'checkup' : 'ok';
  await device.save();
  broadcastDeviceStatus(device);
}

/**
 * reason: 'explicit' (device reported mainsPower:false while still connected)
 *       | 'timeout'  (heartbeat sweep found no signal for HEARTBEAT_TIMEOUT_MS)
 */
async function triggerOutage(device, { reason }) {
  if (device.checkup.active) return; // manual override suppresses detection
  if (device.powerState === 'power_cut') return; // already open
  if (device.restartingUntil && device.restartingUntil > new Date()) return; // planned restart in progress

  device.powerState = 'power_cut';
  if (reason === 'timeout') device.status = 'offline';
  await device.save();

  const event = await PowerEvent.create({
    device: device._id,
    type: reason === 'timeout' ? 'device_offline' : 'outage',
    startedAt: new Date(),
  });

  broadcastDeviceStatus(device);
  broadcastPowerEvent(event);
}

async function resolveOutage(device, { automatic }) {
  const openEvent = await findOpenEvent(device._id);
  if (openEvent) {
    openEvent.endedAt = new Date();
    openEvent.durationMs = openEvent.endedAt.getTime() - openEvent.startedAt.getTime();
    openEvent.resolvedAutomatically = automatic;
    await openEvent.save();
    broadcastPowerEvent(openEvent);
  }
  broadcastDeviceStatus(device);
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
};
