const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    apiKeyHash: { type: String, required: true },

    status: { type: String, enum: ['online', 'offline'], default: 'offline' },
    // 'unknown' = never connected / no signal yet, distinct from a confirmed power_cut
    powerState: {
      type: String,
      enum: ['unknown', 'ok', 'power_cut', 'checkup'],
      default: 'unknown',
    },

    lastHeartbeatAt: { type: Date, default: null },
    lastSeenOnlineAt: { type: Date, default: null },

    wakeTarget: {
      mac: { type: String, default: null },
      label: { type: String, default: null },
    },

    checkup: {
      active: { type: Boolean, default: false },
      startedAt: { type: Date, default: null },
      note: { type: String, default: null },
    },

    // On-board LED blink — a simple "is this specific unit actually
    // reachable" check independent of the power-monitoring state.
    led: {
      blinking: { type: Boolean, default: false },
    },

    // Periodic self-restart to avoid the firmware freezing over long
    // uptimes. null = disabled.
    restart: {
      intervalMinutes: { type: Number, default: null },
    },
    // Set right before a planned restart (device sends 'restarting') so the
    // heartbeat-timeout sweep doesn't log the resulting brief disconnect as
    // a real outage. Cleared on the device's next successful auth.
    restartingUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Device', deviceSchema);
