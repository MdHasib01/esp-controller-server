const { verifyAccessToken } = require('../utils/tokens');
const bus = require('./bus');

const dashboardClients = new Set();

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

function onDashboardConnection(ws, req, token) {
  try {
    verifyAccessToken(token);
  } catch {
    return ws.close(4001, 'invalid token');
  }

  dashboardClients.add(ws);
  ws.on('close', () => dashboardClients.delete(ws));
}

module.exports = { onDashboardConnection, dashboardClients };
