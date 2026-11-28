# Changelog

## 3.0.1

- Station LiveKit connect is a single-flight state machine: one attempt in flight, pending retry timers cancelled before a new one is scheduled, and `disconnected` events from superseded rooms are ignored.
- Old `Room` instances are disconnected before a new join. Camera/mic permission is acquired before connecting to LiveKit.
- Reconnect uses exponential backoff with jitter, capped at 60s. `DUPLICATE_IDENTITY` is treated as another session taking over and backs off instead of retrying immediately.
- Retries stop on page hide/unload and resume on `pageshow`.
- README screenshot placeholders live under `docs/screenshots/`.

## 3.0.0

- Configuration via a project-root `.env` file (`src/env.ts`, `src/config.ts`). Secrets are no longer compiled into the server.
- Persistent signed sessions (`src/auth.ts`). HMAC tokens survive server restarts; logout writes `jti` values to `DATA_DIR/revoked.json`.
- Long-lived station tokens (`STATION_TOKEN_TTL_DAYS`, default 3650) issued by `POST /station/session` for loopback kiosk requests only.
- Boot-race fix: the kiosk waits on `/healthz` with backoff and does not discard a saved token on network or 5xx errors. Tokens are cleared only on 401/403.
- Station auto-provisioning on localhost so the PIN pad is not required after a reboot.
- Camera and microphone are requested once per page load and reused across LiveKit reconnects.
- Packaged macOS installer, LaunchAgent templates, optional kiosk guard, LiveKit and Cloudflare Tunnel examples.
- GitHub Actions CI for typecheck, tests, client builds, and shellcheck.
- Admin dashboard branding (routes remain `/max` for compatibility).
