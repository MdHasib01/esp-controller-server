const mongoose = require('mongoose');

const powerEventSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    // 'outage' = ESP32 explicitly reported mains loss while still connected
    // 'device_offline' = heartbeat timed out; power loss is inferred, not confirmed
    // 'checkup' = manual maintenance window
    type: { type: String, enum: ['outage', 'device_offline', 'checkup'], required: true },

    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    // null while open, true if closed by the system, false if closed manually
    resolvedAutomatically: { type: Boolean, default: null },
    note: { type: String, default: null },
  },
  { timestamps: true }
);

powerEventSchema.index({ device: 1, startedAt: -1 });

module.exports = mongoose.model('PowerEvent', powerEventSchema);
