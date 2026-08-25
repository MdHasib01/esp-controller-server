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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Device', deviceSchema);
