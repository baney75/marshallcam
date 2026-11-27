# Changelog

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
