const http = require('http');
const app = require('./src/app');
const { connectDb } = require('./src/config/db');
const { attachWebSocketServers } = require('./src/ws');
const { startHeartbeatSweep } = require('./src/ws/heartbeatSweep');
const { port } = require('./src/config/env');

async function main() {
  await connectDb();

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
