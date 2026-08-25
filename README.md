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

## Deploying (Vercel) — REST API only

`vercel.json` + `api/index.js` deploy the Express REST API (`/health`,
`/api/auth/*`, `/api/devices/*`) as a Vercel serverless function.

**This does not include the WebSocket server or the heartbeat sweep.**
Vercel's serverless functions are stateless and short-lived — they can't
hold the ESP32's `/ws/device` connection open, serve `/ws/dashboard`, or
run the `setInterval`-based power-cut sweep in `src/ws/heartbeatSweep.js`.
Those still need an always-on process somewhere (a small Node host —
Render/Railway/Fly.io/a VPS — running the existing `server.js` as-is).
Point the ESP32 firmware and the frontend's `VITE_WS_BASE_URL` at that
host; only REST calls (`VITE_API_BASE_URL`) go to Vercel.

```bash
npm i -g vercel
vercel login

# from backend/
vercel link          # creates/links the Vercel project
vercel env add MONGO_URI production
vercel env add JWT_ACCESS_SECRET production
vercel env add JWT_REFRESH_SECRET production
vercel env add CORS_ORIGIN production   # your deployed frontend's origin

vercel --prod
```

Notes:
- `api/index.js` caches the Mongoose connection across warm invocations so
  concurrent requests don't each open a fresh MongoDB connection.
- `HEARTBEAT_TIMEOUT_MS` / `SWEEP_INTERVAL_MS` are irrelevant on this
  deployment — the sweep that reads them doesn't run here.
- Run `npm run seed:admin` once against the same `MONGO_URI` (locally, with
  `.env` pointed at the production database) to create the admin login.
