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

## Deploying (Fly.io)

This app holds a persistent ESP32 WebSocket connection and runs an
in-process heartbeat sweep for power-cut detection — it needs an
always-on process, not a serverless/scale-to-zero platform. `Dockerfile`
and `fly.toml` are set up for that.

```bash
# one-time
brew install flyctl   # or see https://fly.io/docs/flyctl/install/
fly auth login

# from backend/
fly launch --no-deploy   # confirm/rename the app, pick a region; it'll detect fly.toml
fly secrets set \
  MONGO_URI="mongodb+srv://..." \
  JWT_ACCESS_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  JWT_REFRESH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  CORS_ORIGIN="https://your-frontend-domain"

fly deploy
```

Notes:
- `fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1`
  — without this, Fly would suspend the machine when idle, which drops the
  ESP32's WebSocket and stops the heartbeat sweep entirely.
- `/health` is wired up as Fly's health check and reports `503` when MongoDB
  isn't connected, so a bad DB connection surfaces as an unhealthy machine
  rather than a silently broken app.
- After deploying, update the ESP32 firmware's `wsServer` and the frontend's
  `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` to point at `https://<app>.fly.dev`
  / `wss://<app>.fly.dev`.
- Run `npm run seed:admin` once against the same `MONGO_URI` (locally, with
  `.env` pointed at the production database) to create the admin login —
  there's no seed step in the Docker image itself.
