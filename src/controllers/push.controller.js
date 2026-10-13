const { z } = require('zod');
const Device = require('../models/Device');
const PushSubscription = require('../models/PushSubscription');
const pushService = require('../services/pushService');
const bus = require('../ws/bus');

// Shape of PushSubscription.toJSON() in the browser.
const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url() });
const testSchema = z.object({ kind: z.enum(['cut', 'restored']).default('cut') });

async function publicKey(req, res) {
  res.json({ enabled: pushService.enabled, publicKey: pushService.publicKey || null });
}

async function subscribe(req, res) {
  if (!pushService.enabled) return res.status(503).json({ error: 'Push notifications are not configured' });
  const body = subscribeSchema.parse(req.body);

  // Upsert by endpoint: re-subscribing the same browser refreshes its keys
  // instead of creating a duplicate that would notify twice.
  await PushSubscription.findOneAndUpdate(
    { endpoint: body.endpoint },
    {
      $set: {
        user: req.user.id,
        keys: body.keys,
        userAgent: req.headers['user-agent'] || null,
      },
    },
    { upsert: true }
  );
  res.status(201).json({ ok: true });
}

async function unsubscribe(req, res) {
  const { endpoint } = unsubscribeSchema.parse(req.body);
  await PushSubscription.deleteOne({ endpoint });
  res.json({ ok: true });
}

/**
 * Fires a fake power alert through the same bus a real outage uses, so one
 * click exercises push delivery, the dashboard sound and the toast.
 */
async function test(req, res) {
  const { kind } = testSchema.parse(req.body || {});
  const device = await Device.findOne().sort({ createdAt: 1 });
  const now = new Date();
  const alert = {
    kind,
    test: true,
    device: device
      ? { id: device._id, deviceId: device.deviceId, name: device.name }
      : { id: null, deviceId: null, name: 'ESP32' },
    at: now.toISOString(),
  };
  if (kind === 'cut') {
    alert.eventType = 'device_offline';
  } else {
    alert.durationMs = 12 * 60 * 1000 + 47 * 1000;
    alert.startedAt = new Date(now.getTime() - alert.durationMs).toISOString();
  }

  bus.emit('power_alert', alert);
  const subscriptions = pushService.enabled ? await PushSubscription.countDocuments() : 0;
  res.json({ pushEnabled: pushService.enabled, subscriptions });
}

module.exports = { publicKey, subscribe, unsubscribe, test };
