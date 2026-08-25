# Backend — ESP32 Power Monitor API

Express + MongoDB REST API and WebSocket server. See [../BACKEND.md](../BACKEND.md)
for the full architecture/protocol spec this implements.

## Setup

```
npm install
cp .env.example .env   # edit MONGO_URI and JWT secrets
npm run seed:admin -- admin@example.com "SomeStrongPassword123"
npm run dev
```

Server starts on `http://localhost:4000`.

## Endpoints

- `POST /api/auth/login`, `/refresh`, `/logout`, `GET /api/auth/me`
- `GET/POST /api/devices`, `GET/PATCH /api/devices/:id`
- `POST /api/devices/:id/wake`
- `POST /api/devices/:id/checkup/start` / `/checkup/end`
- `GET /api/devices/:id/events`, `GET /api/devices/:id/stats?range=24h|7d|30d`

## WebSocket channels

- `ws://localhost:4000/ws/device?deviceId=<id>` — ESP32 connects, then sends
  `{"type":"auth","apiKey":"..."}` as its first message, then heartbeats
  every few seconds: `{"type":"heartbeat","mainsPower":true}`.
- `ws://localhost:4000/ws/dashboard?token=<accessToken>` — frontend connects
  with the JWT access token to receive live `device_status` / `power_event`
  / `wake_ack` pushes.

## Provisioning a device

`POST /api/devices` with `{ "deviceId": "esp32-livingroom", "name": "Living Room", "wakeTarget": { "mac": "AA:BB:CC:DD:EE:FF" } }`
returns the device plus a one-time `apiKey` — save it, it's not retrievable
again (only its bcrypt hash is stored).
