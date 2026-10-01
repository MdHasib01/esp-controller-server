const mongoose = require('mongoose');

// One row per authenticated device WebSocket session with the server.
const connectionLogSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },

    connectedAt: { type: Date, required: true },
    disconnectedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    // null while connected.
    // 'planned_restart' = device announced its scheduled reboot first
    // 'timeout'         = device went silent (power cut / network loss)
    // 'replaced'        = device reconnected before the old socket timed out
    // 'disconnected'    = socket closed for any other reason
    // 'server_restart'  = server process restarted while the session was open
    endReason: {
      type: String,
      enum: ['planned_restart', 'timeout', 'replaced', 'disconnected', 'server_restart'],
      default: null,
    },
    closeCode: { type: Number, default: null },

    // Reported by the firmware in its auth message.
    // resetReason: why the board last booted ('power_on', 'software', 'brownout', ...)
    // firstSinceBoot: true for the first session after that boot, false for reconnects
    // bootToConnectMs: time from boot to this connection being opened
    resetReason: { type: String, default: null },
    firstSinceBoot: { type: Boolean, default: null },
    bootToConnectMs: { type: Number, default: null },
    rssi: { type: Number, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

connectionLogSchema.index({ device: 1, connectedAt: -1 });
connectionLogSchema.index({ disconnectedAt: 1 });

module.exports = mongoose.model('ConnectionLog', connectionLogSchema);
