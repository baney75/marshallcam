# Contributing

Thanks for helping with MarshallCam.

## Development

```bash
cp .env.example .env   # set STATION_PIN, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
npm ci
npm --prefix client ci
npm --prefix client-max ci
npm run build
npm start
```

The intercom PWA is at `http://localhost:3000/`. Add `?role=station` for the kiosk view. The admin dashboard is at `http://localhost:3000/max/` when `ADMIN_PASSWORD` is set.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run lint:sh   # if shellcheck is installed
```

Please include tests for auth, config, or installer changes. Do not commit `.env`, real PINs, API keys, hostnames, or personal data.

## Pull requests

Open PRs against `main`. Keep diffs reviewable: prefer fixing the root cause over adding kiosk workarounds.
