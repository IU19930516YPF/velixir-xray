# velixir-xray

xray (VLESS + WebSocket + TLS) as a plain Node.js app, built for the
Velixir free plan. TLS is terminated at the Velixir edge, so xray itself
serves plain WebSocket on localhost; the Node wrapper only starts xray,
serves a status page, and relays WS upgrades to it.

No secrets in this repo. Set them as environment variables in the
Velixir dashboard:

- `UUID` — VLESS client UUID (required in production; a random one is
  generated if unset, but it changes on every cold start because the
  free-plan disk is scratch space)
- `WS_PATH` — WebSocket path, e.g. `/ws-xxxx` (default `/vless`)
- `XRAY_VERSION` — xray-core version to download (default `v26.3.27`)

Endpoints:

- `GET /` — status page with the subscription link and QR code
- `GET /health` — health probe for Velixir (`200 ok`)
- `GET /sub` — base64 subscription (one VLESS link) for clients
- `GET /qr` — QR code PNG of the VLESS link

The VLESS link is built from the incoming `Host` header, so the app
never needs to know its own domain in advance.
