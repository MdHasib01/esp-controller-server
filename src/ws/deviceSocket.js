const Device = require('../models/Device');
const { compareApiKey } = require('../utils/apiKey');
const deviceService = require('../services/deviceService');
const connectionLogService = require('../services/connectionLogService');
const { heartbeatTimeoutMs } = require('../config/env');
const bus = require('./bus');

const AUTH_TIMEOUT_MS = 5000;

// deviceId -> live WebSocket, used by the REST /wake endpoint to push commands
const deviceConnections = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || null;
}

function onDeviceConnection(ws, req, deviceId) {
  let authenticated = false;
  let deviceObjectId = null;
  let logId = null;
  // ws.endReason is set by whoever first learns why this session will end
  // (planned restart, silence timeout, replaced by a newer connection).
  ws.endReason = null;

  // Messages are handled strictly one at a time per connection — each handler
  // does several awaited writes to the same Device, and overlapping them
  // throws ParallelSaveError (which used to crash the whole server).
  let queue = Promise.resolve();
  function enqueue(task) {
    queue = queue.then(task).catch((err) => console.error(`[ws/device] ${deviceId}:`, err));
  }

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, 'auth timeout');
  }, AUTH_TIMEOUT_MS);

  // A board that loses power never sends a TCP FIN, so without this its
  // socket (and connection log) would stay "open" until the OS gives up on it.
  let idleTimer = null;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ws.endReason = ws.endReason || 'timeout';
      ws.terminate();
    }, heartbeatTimeoutMs);
  }

  async function handleAuth(msg) {
    if (msg.type !== 'auth' || typeof msg.apiKey !== 'string') return;

    const device = await Device.findOne({ deviceId });
    if (!device) return ws.close(4004, 'unknown device');

    const valid = await compareApiKey(msg.apiKey, device.apiKeyHash);
    if (!valid) return ws.close(4003, 'invalid api key');
    if (ws.readyState !== ws.OPEN) return; // device gave up during the auth round-trip

    const connectedAt = new Date();
    authenticated = true;
    deviceObjectId = device._id;
    clearTimeout(authTimer);
    resetIdleTimer();

    // A rebooted board reconnects before its old socket times out — drop the
    // stale one right away so commands go to the live connection.
    const previous = deviceConnections.get(deviceId);
    if (previous && previous !== ws) {
      previous.endReason = previous.endReason || 'replaced';
      previous.terminate();
    }
    deviceConnections.set(deviceId, ws);

    send(ws, { type: 'auth_ok' });
    send(ws, { type: 'restart_config', intervalMinutes: device.restart.intervalMinutes });

    // A successful auth counts as the first heartbeat, so the dashboard flips
    // to online (and closes any open outage) without waiting for the next one.
    device.restartingUntil = null; // reconnected — any planned-restart grace window is over
    await deviceService.handleHeartbeat(device, {});

    logId = await connectionLogService.openConnectionLog(device, {
      connectedAt,
      resetReason: typeof msg.resetReason === 'string' ? msg.resetReason : null,
      firstSinceBoot: typeof msg.firstSinceBoot === 'boolean' ? msg.firstSinceBoot : null,
      bootToConnectMs: Number.isFinite(msg.bootMs) ? msg.bootMs : null,
      rssi: Number.isFinite(msg.rssi) ? msg.rssi : null,
      ip: clientIp(req),
    });
  }

  async function handleMessage(msg) {
    // Re-read every time: REST endpoints and the heartbeat sweep also write
    // this device, so a copy held since auth would be stale.
    const device = await Device.findById(deviceObjectId);
    if (!device) return ws.close(4004, 'unknown device');

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
      case 'restarting':
        ws.endReason = 'planned_restart';
        await deviceService.beginPlannedRestart(device);
        break;
      default:
        break;
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (authenticated) resetIdleTimer();
    enqueue(() => (authenticated ? handleMessage(msg) : handleAuth(msg)));
  });

  ws.on('close', (code) => {
    clearTimeout(authTimer);
    clearTimeout(idleTimer);
    if (authenticated && deviceConnections.get(deviceId) === ws) {
      deviceConnections.delete(deviceId);
    }
    // Queued so it runs after an in-flight auth has created the log.
    // Deliberately not flagging power_cut here — a socket close can be a
    // benign reconnect. The heartbeat sweep is the single source of truth
    // for "silence has gone on long enough to call it an outage."
    enqueue(async () => {
      if (!logId) return;
      await connectionLogService.closeConnectionLog(logId, {
        endReason: ws.endReason || 'disconnected',
        closeCode: code,
      });
    });
  });

  ws.on('error', () => {
    // 'close' still fires after 'error'; no extra handling needed here.
  });
}

module.exports = { onDeviceConnection, deviceConnections };
