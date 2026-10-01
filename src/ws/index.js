const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { onDeviceConnection } = require('./deviceSocket');
const { onDashboardConnection } = require('./dashboardSocket');

function attachWebSocketServers(httpServer) {
  const deviceWss = new WebSocketServer({ noServer: true });
  const dashboardWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // Accept both /ws/* and /api/ws/* so the sockets work behind the same
    // /api reverse-proxy prefix as the REST routes.
    const pathname = url.pathname.replace(/^\/api(?=\/ws\/)/, '');

    if (pathname === '/ws/device') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) {
        socket.destroy();
        return;
      }
      deviceWss.handleUpgrade(req, socket, head, (ws) => {
        onDeviceConnection(ws, req, deviceId);
      });
      return;
    }

    if (pathname === '/ws/dashboard') {
      const token = url.searchParams.get('token');
      if (!token) {
        socket.destroy();
        return;
      }
      dashboardWss.handleUpgrade(req, socket, head, (ws) => {
        onDashboardConnection(ws, req, token);
      });
      return;
    }

    socket.destroy();
  });
}

module.exports = { attachWebSocketServers };
