# Security

## Reporting

Please report vulnerabilities privately to the repository owner. Do not file public issues that include secrets, PINs, or access tokens.

## Notes for operators

- **Station trust is loopback-only.** `POST /station/session` and `/station/health` succeed only when the TCP peer is localhost, the Host header is `localhost` or `127.0.0.1`, and there are no proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`, `CF-Ray`, `X-Real-IP`, `Forwarded`). Traffic from a tunnel or reverse proxy never qualifies.
- Set a strong `STATION_PIN` (4–8 digits is a convenience lock, not a password) and a strong `ADMIN_PASSWORD`. Leave `ADMIN_PASSWORD` empty to disable `/max`.
- Never expose `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` or `SESSION_SECRET` to browsers or public config files. LiveKit client tokens are minted by the MarshallCam server after auth.
- Keep `.env` and `data/session-secret` mode `0600`. Do not commit them.
- Remote access should go through an identity-aware tunnel (Cloudflare Tunnel, Tailscale) rather than opening port 3000 or 7880 to the internet.
