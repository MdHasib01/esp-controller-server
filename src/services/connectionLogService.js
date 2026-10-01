const ConnectionLog = require('../models/ConnectionLog');
const bus = require('../ws/bus');

async function openConnectionLog(device, info) {
  const log = await ConnectionLog.create({ device: device._id, connectedAt: new Date(), ...info });
  bus.emit('connection_event', log);
  return log._id;
}

async function closeConnectionLog(logId, { endReason, closeCode }) {
  const log = await ConnectionLog.findById(logId);
  if (!log || log.disconnectedAt) return;

  log.disconnectedAt = new Date();
  log.durationMs = log.disconnectedAt.getTime() - log.connectedAt.getTime();
  log.endReason = endReason;
  log.closeCode = closeCode ?? null;
  await log.save();
  bus.emit('connection_event', log);
}

// Sessions left open by a previous server process — their sockets died with
// it, and pm2 restarts within seconds, so "now" is a close-enough end time.
async function closeOrphanedConnectionLogs() {
  const open = await ConnectionLog.find({ disconnectedAt: null });
  const now = new Date();
  for (const log of open) {
    log.disconnectedAt = now;
    log.durationMs = now.getTime() - log.connectedAt.getTime();
    log.endReason = 'server_restart';
    await log.save();
  }
  return open.length;
}

module.exports = { openConnectionLog, closeConnectionLog, closeOrphanedConnectionLogs };
