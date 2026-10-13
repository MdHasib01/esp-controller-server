const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const { vapid } = require('../config/env');
const bus = require('../ws/bus');

const enabled = Boolean(vapid.publicKey && vapid.privateKey);
if (enabled) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

// Power alerts are only worth delivering while they're still news; a phone
// that was off for a day doesn't need yesterday's "power cut" on wake-up.
const PUSH_TTL_SECONDS = 6 * 60 * 60;

/**
 * Sends one payload to every stored subscription. Subscriptions the push
 * service reports as gone (404/410 — browser data cleared, permission
 * revoked) are deleted so they aren't retried forever.
 */
async function sendToAll(payload) {
  if (!enabled) return { sent: 0, removed: 0 };
  const subscriptions = await PushSubscription.find();
  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          body,
          { TTL: PUSH_TTL_SECONDS, urgency: 'high' }
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sub.deleteOne();
          removed += 1;
        } else {
          console.error('[push] send failed', err.statusCode || '', err.body || err.message);
        }
      }
    })
  );
  return { sent, removed };
}

/**
 * Forwards every power_alert on the bus as a push notification. The payload
 * carries raw ISO timestamps; the service worker formats them in the
 * viewer's own locale and time zone.
 */
function startPushAlerts() {
  if (!enabled) {
    console.log('[push] VAPID keys not set — push notifications disabled');
    return;
  }
  bus.on('power_alert', (alert) => {
    sendToAll(alert).catch((err) => console.error('[push] power alert failed', err));
  });
  console.log('[push] power alerts enabled');
}

module.exports = { enabled, publicKey: vapid.publicKey, sendToAll, startPushAlerts };
