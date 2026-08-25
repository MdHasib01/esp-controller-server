const Device = require('../models/Device');
const deviceService = require('../services/deviceService');
const { heartbeatTimeoutMs, sweepIntervalMs } = require('../config/env');

function startHeartbeatSweep() {
  const timer = setInterval(async () => {
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
  }, sweepIntervalMs);

  timer.unref();
  return timer;
}

module.exports = { startHeartbeatSweep };
