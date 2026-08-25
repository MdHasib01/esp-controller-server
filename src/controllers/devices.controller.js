const { z } = require('zod');
const Device = require('../models/Device');
const PowerEvent = require('../models/PowerEvent');
const deviceService = require('../services/deviceService');
const { generateApiKey, hashApiKey } = require('../utils/apiKey');
const { deviceConnections } = require('../ws/deviceSocket');

const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

const createDeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  wakeTarget: z
    .object({ mac: z.string().regex(macRegex).optional(), label: z.string().optional() })
    .optional(),
});

const updateDeviceSchema = z.object({
  name: z.string().min(1).optional(),
  wakeTarget: z
    .object({ mac: z.string().regex(macRegex).nullable().optional(), label: z.string().nullable().optional() })
    .optional(),
  restart: z
    .object({ intervalMinutes: z.number().int().min(1).max(1440).nullable() })
    .optional(),
});

const checkupStartSchema = z.object({ note: z.string().optional() });
const ledSchema = z.object({ value: z.boolean() });

async function list(req, res) {
  const devices = await Device.find().sort({ createdAt: 1 });
  res.json({ devices: devices.map(deviceService.publicDevice) });
}

async function getOne(req, res) {
  const device = await Device.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json({ device: deviceService.publicDevice(device) });
}

async function create(req, res, next) {
  try {
    const body = createDeviceSchema.parse(req.body);
    const rawApiKey = generateApiKey();
    const apiKeyHash = await hashApiKey(rawApiKey);

    const device = await Device.create({
      deviceId: body.deviceId,
      name: body.name,
      apiKeyHash,
      wakeTarget: body.wakeTarget || {},
    });

    // apiKey is only ever returned here — flash it to the client once.
    res.status(201).json({ device: deviceService.publicDevice(device), apiKey: rawApiKey });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'deviceId already exists' });
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const body = updateDeviceSchema.parse(req.body);
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    if (body.name) device.name = body.name;
    if (body.wakeTarget) {
      if (body.wakeTarget.mac !== undefined) device.wakeTarget.mac = body.wakeTarget.mac;
      if (body.wakeTarget.label !== undefined) device.wakeTarget.label = body.wakeTarget.label;
    }
    if (body.restart) {
      device.restart.intervalMinutes = body.restart.intervalMinutes;
    }
    await device.save();

    if (body.restart) {
      const conn = deviceConnections.get(device.deviceId);
      if (conn && conn.readyState === conn.OPEN) {
        conn.send(JSON.stringify({ type: 'restart_config', intervalMinutes: device.restart.intervalMinutes }));
      }
    }

    res.json({ device: deviceService.publicDevice(device) });
  } catch (err) {
    next(err);
  }
}

async function wake(req, res) {
  const device = await Device.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.wakeTarget?.mac) {
    return res.status(400).json({ error: 'Device has no wakeTarget.mac configured' });
  }

  const conn = deviceConnections.get(device.deviceId);
  if (!conn || conn.readyState !== conn.OPEN) {
    return res.status(409).json({ error: 'Device is not connected — cannot relay wake command' });
  }

  conn.send(JSON.stringify({ type: 'wake_pc', mac: device.wakeTarget.mac }));
  res.status(202).json({ message: 'Wake command sent' });
}

async function setLed(req, res, next) {
  try {
    const { value } = ledSchema.parse(req.body);
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const conn = deviceConnections.get(device.deviceId);
    if (!conn || conn.readyState !== conn.OPEN) {
      return res.status(409).json({ error: 'Device is not connected — cannot relay LED command' });
    }

    conn.send(JSON.stringify({ type: 'led', value }));
    // Optimistic — the device's led_ack (over WS) confirms/corrects this shortly after.
    await deviceService.setLedState(device, value);
    res.json({ device: deviceService.publicDevice(device) });
  } catch (err) {
    next(err);
  }
}

async function startCheckup(req, res, next) {
  try {
    const { note } = checkupStartSchema.parse(req.body);
    const device = await Device.findById(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.checkup.active) return res.status(409).json({ error: 'Checkup already active' });

    await deviceService.startCheckup(device, note);
    res.json({ device: deviceService.publicDevice(device) });
  } catch (err) {
    next(err);
  }
}

async function endCheckup(req, res) {
  const device = await Device.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.checkup.active) return res.status(409).json({ error: 'No checkup is active' });

  await deviceService.endCheckup(device);
  res.json({ device: deviceService.publicDevice(device) });
}

async function events(req, res) {
  const device = await Device.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const filter = { device: device._id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(req.query.to);
  }

  const [total, items] = await Promise.all([
    PowerEvent.countDocuments(filter),
    PowerEvent.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  res.json({ events: items, total, page, limit });
}

const RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

async function stats(req, res) {
  const device = await Device.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const range = RANGE_MS[req.query.range] ? req.query.range : '24h';
  const rangeMs = RANGE_MS[range];
  const rangeStart = new Date(Date.now() - rangeMs);

  const outages = await PowerEvent.find({
    device: device._id,
    type: { $in: ['outage', 'device_offline'] },
    startedAt: { $gte: rangeStart },
  });

  const now = Date.now();
  let totalDowntimeMs = 0;
  let longestOutageMs = 0;

  for (const event of outages) {
    const duration = event.durationMs ?? now - event.startedAt.getTime(); // still open
    totalDowntimeMs += duration;
    longestOutageMs = Math.max(longestOutageMs, duration);
  }

  const uptimePercent = Math.max(
    0,
    Math.min(100, ((rangeMs - totalDowntimeMs) / rangeMs) * 100)
  );

  res.json({
    range,
    outageCount: outages.length,
    totalDowntimeMs,
    longestOutageMs,
    uptimePercent: Number(uptimePercent.toFixed(2)),
  });
}

module.exports = { list, getOne, create, update, wake, setLed, startCheckup, endCheckup, events, stats };
