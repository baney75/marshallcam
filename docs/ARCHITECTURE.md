# Architecture

MarshallCam is a self-hosted two-way video intercom. A wall Mac runs a Safari Web App as the **station** (always-on camera + TV clock). Phones join as **remote** callers. LiveKit moves the media; a small Node server handles auth, static files, and optional TV/AI helpers.

```
  phone (remote PWA)
        |  HTTPS / WSS
        v
  [optional tunnel] ----> MarshallCam HTTP :3000
                                |  LiveKit token
                                v
                         livekit-server :7880
                                ^
                                |
                     station Web App (localhost)
```

## Processes (macOS kiosk)

| Process | Role |
| --- | --- |
| `tsx src/MarshallCamServer.ts` | Auth, PWA, LiveKit tokens, optional ECP/AI proxy |
| `livekit-server` | WebRTC rooms (`marshallcam`) |
| Safari Web App | Station UI; publishes camera/mic |
| Optional `cloudflared` | Public hostnames to localhost |
| Optional `kiosk-guard.sh` | Reopen the Web App; last-resort PIN |
| Optional `av-lock.sh` | Pin CoreAudio input/output devices |
| `caffeinate` | Keep the Mac awake |

## Auth

Tokens are `base64url(payload).base64url(HMAC-SHA256(secret, payload))` with `{v:1, kind, iat, exp, jti}`. Kinds: `user` (PIN), `station` (loopback auto-provision, long TTL), `admin` (`/max`). Logout appends `jti` to `DATA_DIR/revoked.json`.

The station never treats a failed `/status` fetch as logout unless the server returns 401/403. `/healthz` is unauthenticated so the Web App can wait for the server at boot.

## Station reconnect

The kiosk (`client/src/stationConnect.ts`) keeps a single LiveKit connect attempt in flight. It waits for camera permission, disconnects any previous `Room`, then joins with a stable `station-*` identity. A pending retry timer is cancelled before another is scheduled. `disconnected` from a superseded generation is ignored. Failures (including `DUPLICATE_IDENTITY`) use exponential backoff with jitter, capped at 60s. Page hide/unload stops retries so a suspended Web App cannot storm the room.
