const { verifyAccessToken } = require('../utils/tokens');
const liveStatus = require('../services/liveStatusService');
const bus = require('./bus');

// Browsers can't see protocol-level pings, so the keepalive is also sent as a
// JSON message — the dashboard reconnects when these stop arriving (a socket
// left behind by a sleeping laptop or a backgrounded phone tab can look open
// for minutes while receiving nothing).
const KEEPALIVE_INTERVAL_MS = 15_000;

const dashboardClients = new Set();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of dashboardClients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// Subscribed once at module load — deviceService/heartbeatSweep emit here,
// this is the only place that fans messages out to connected browsers.
bus.on('device_status', (device) => broadcast({ type: 'device_status', device }));
bus.on('power_event', (event) => broadcast({ type: 'power_event', event }));
bus.on('wake_ack', ({ deviceId, success }) => broadcast({ type: 'wake_ack', deviceId, success }));
bus.on('power_alert', (alert) => broadcast({ type: 'power_alert', alert }));
bus.on('connection_event', (connection) => broadcast({ type: 'connection_event', connection }));
bus.on('live_status', (status) => broadcast({ type: 'live_status', ...status }));

function onDashboardConnection(ws, req, token) {
  try {
    verifyAccessToken(token);
  } catch {
    return ws.close(4001, 'invalid token');
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  dashboardClients.add(ws);
  ws.on('close', () => dashboardClients.delete(ws));
  ws.on('error', () => {
    // 'close' still fires after 'error'; no extra handling needed here.
  });

  // Whatever changed while this browser was disconnected, its status and
  // timer are right from the first frame.
  for (const status of liveStatus.snapshot()) send(ws, { type: 'live_status', ...status });
}

function startDashboardKeepalive() {
  const timer = setInterval(() => {
    for (const ws of dashboardClients) {
      // No pong since the last round — the peer is gone without a FIN.
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
      send(ws, { type: 'ping' });
    }
  }, KEEPALIVE_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { onDashboardConnection, startDashboardKeepalive, dashboardClients };
