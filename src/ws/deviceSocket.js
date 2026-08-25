const Device = require('../models/Device');
const { compareApiKey } = require('../utils/apiKey');
const deviceService = require('../services/deviceService');
const bus = require('./bus');

const AUTH_TIMEOUT_MS = 5000;

// deviceId -> live WebSocket, used by the REST /wake endpoint to push commands
const deviceConnections = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function onDeviceConnection(ws, req, deviceId) {
  let authenticated = false;
  let device = null;

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, 'auth timeout');
  }, AUTH_TIMEOUT_MS);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    if (!authenticated) {
      if (msg.type !== 'auth' || typeof msg.apiKey !== 'string') return;

      device = await Device.findOne({ deviceId });
      if (!device) return ws.close(4004, 'unknown device');

      const valid = await compareApiKey(msg.apiKey, device.apiKeyHash);
      if (!valid) return ws.close(4003, 'invalid api key');

      authenticated = true;
      clearTimeout(authTimer);
      deviceConnections.set(deviceId, ws);

      device.status = 'online';
      device.lastHeartbeatAt = new Date();
      device.lastSeenOnlineAt = new Date();
      if (device.powerState === 'unknown') device.powerState = device.checkup.active ? 'checkup' : 'ok';
      await device.save();
      deviceService.broadcastDeviceStatus(device);

      send(ws, { type: 'auth_ok' });
      return;
    }

    switch (msg.type) {
      case 'heartbeat':
      case 'power_event':
        await deviceService.handleHeartbeat(device, { mainsPower: msg.mainsPower, led: msg.led });
        break;
      case 'wake_ack':
        bus.emit('wake_ack', { deviceId, success: Boolean(msg.success) });
        break;
      case 'led_ack':
        await deviceService.setLedState(device, Boolean(msg.value));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (authenticated && deviceConnections.get(deviceId) === ws) {
      deviceConnections.delete(deviceId);
    }
    // Deliberately not flagging power_cut here — a socket close can be a
    // benign reconnect. The heartbeat sweep is the single source of truth
    // for "silence has gone on long enough to call it an outage."
  });

  ws.on('error', () => {
    // 'close' still fires after 'error'; no extra handling needed here.
  });
}

module.exports = { onDeviceConnection, deviceConnections };
