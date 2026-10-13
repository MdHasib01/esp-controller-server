const Device = require('../models/Device');
const deviceService = require('../services/deviceService');
const { heartbeatTimeoutMs, sweepIntervalMs } = require('../config/env');

function startHeartbeatSweep() {
  // A slow database can make one sweep outlast the interval; overlapping
  // sweeps would race each other on the same devices.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweep();
    } catch (err) {
      console.error('[sweep]', err);
    } finally {
      running = false;
    }
  }, sweepIntervalMs);

  async function sweep() {
    const now = Date.now();
    const devices = await Device.find({
      'checkup.active': false,
      powerState: { $ne: 'power_cut' },
      lastHeartbeatAt: { $ne: null },
    });

    for (const device of devices) {
      const elapsed = now - device.lastHeartbeatAt.getTime();
      if (elapsed > heartbeatTimeoutMs) {
        await deviceService.triggerOutage(device, { reason: 'timeout' });
      }
    }
  }

  timer.unref();
  return timer;
}

module.exports = { startHeartbeatSweep };
