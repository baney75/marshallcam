# Screenshots

Staged screenshots of the MarshallCam UI captured at 1280x720 against a throwaway local demo configuration (fake PIN, fake admin password, local LiveKit dev server, and synthetic video test patterns):

- `station.png`: TV/station standby clock view (`/?role=station`)
- `remote.png`: remote client in an active two-way LiveKit call with the station (`/?role=remote`)
- `admin.png`: optional admin dashboard Service Health view (`/max`)

## Reproducing

Build both clients, then run the capture script:

```bash
npm run build
node scripts/screenshots.mjs
```

The script starts a temporary LiveKit dev server (using a local `livekit-server` binary or Docker `livekit/livekit-server`), a local mock Roku ECP responder, and the MarshallCam server on `127.0.0.1:3000` with throwaway demo settings. It launches headless Chromium through Playwright with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream` (and `ffmpeg` synthetic test patterns when `ffmpeg` is available).

Optional environment overrides:

- `SCREENSHOT_PORT`: HTTP port for the temporary server (default `3000`)
- `SCREENSHOT_LIVEKIT_PORT`: LiveKit port (default `7880`)
- `PLAYWRIGHT_PATH`: path to Playwright's entry module if not installed in `node_modules`
- `CHROMIUM_PATH`: path to a Chromium executable
