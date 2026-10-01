const http = require('http');
const app = require('./src/app');
const { connectDb } = require('./src/config/db');
const { attachWebSocketServers } = require('./src/ws');
const { startHeartbeatSweep } = require('./src/ws/heartbeatSweep');
const { closeOrphanedConnectionLogs } = require('./src/services/connectionLogService');
const { port } = require('./src/config/env');

// Log instead of crashing — one bad async handler shouldn't drop every
// connected device and dashboard.
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection', err);
});

async function main() {
  await connectDb();

  const orphaned = await closeOrphanedConnectionLogs();
  if (orphaned) console.log(`[server] closed ${orphaned} connection log(s) left open by the last run`);

  const server = http.createServer(app);
  attachWebSocketServers(server);
  startHeartbeatSweep();

  server.listen(port, () => {
    console.log(`[server] listening on :${port}`);
    console.log(`[ws] device channel   ws://localhost:${port}/ws/device`);
    console.log(`[ws] dashboard channel ws://localhost:${port}/ws/dashboard`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
