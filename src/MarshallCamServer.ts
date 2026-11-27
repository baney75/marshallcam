import http from 'node:http'
import { URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, exec, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import stream from 'node:stream'
import { WebSocket, type WebSocketServer } from 'ws'
import { AccessToken } from 'livekit-server-sdk'
import { loadEnvFile, projectRoot } from './env'
import { loadConfig, type AppConfig, type IceServer } from './config'
import {
  extractToken,
  issueToken,
  isLocalStation,
  kindTtlSeconds,
  RevocationStore,
  verifyToken,
  type TokenKind,
  type TokenPayload,
} from './auth'

type SpeakerInstance = {
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): SpeakerInstance
  close(flush?: boolean): void
}

type StreamType = 'dogcam' | 'family' | 'family_kiosk'

interface AuthedWS extends WebSocket {
  _stream: StreamType
  _kiosk?: boolean
}

export interface MarshallCamHandle {
  server: http.Server
  port: number
  config: AppConfig
  close: () => Promise<void>
}

const IDLE_TIMEOUT_MS = 45_000
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 5_000
const LOGIN_RATE_LIMIT = 5
const LOGIN_RATE_WINDOW = 60_000
const HEARTBEAT_STALE_MS = 45_000
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

const STATIC_FILES = [
  '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png',
  '/apple-touch-icon.png', '/favicon.svg', '/favicon.ico',
]

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parsePassword(body: string): string | undefined {
  try { return JSON.parse(body).password } catch {
    return new URLSearchParams(body).get('password') ?? undefined
  }
}

function hostName(req: http.IncomingMessage): string {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
}

function hasProxyHeaders(req: http.IncomingMessage): boolean {
  const h = req.headers
  return !!(h['x-forwarded-for'] || h['cf-connecting-ip'] || h['cf-ray'] || h['x-real-ip'] || h['forwarded'])
}

function getLiveKitUrl(req: http.IncomingMessage, config: AppConfig): string {
  const host = hostName(req)
  if (config.livekitUrlPublic && (config.publicHostnames.includes(host) || hasProxyHeaders(req))) {
    return config.livekitUrlPublic
  }
  const remoteAddr = req.socket.remoteAddress || ''
  if (config.livekitUrlLan) {
    if (remoteAddr.includes('192.168.') || remoteAddr.includes('10.') || (config.serverLanIp && remoteAddr.includes(config.serverLanIp))) {
      return config.livekitUrlLan
    }
  }
  return config.livekitUrlLocal
}

function cookieHeader(name: string, token: string, maxAge: number, cookiePath: string): string {
  return `${name}=${token}; HttpOnly; Path=${cookiePath}; SameSite=Strict; Max-Age=${maxAge}`
}

function clearCookie(name: string, cookiePath: string): string {
  return `${name}=; HttpOnly; Path=${cookiePath}; Max-Age=0`
}

export async function startMarshallCam(options?: {
  config?: AppConfig
  env?: NodeJS.ProcessEnv
  loadDotEnv?: boolean
}): Promise<MarshallCamHandle> {
  if (options?.loadDotEnv !== false && !options?.config) {
    loadEnvFile(path.join(projectRoot(), '.env'), options?.env ?? process.env)
  }
  const config = options?.config ?? loadConfig(options?.env ?? process.env)
  const PUBLIC = path.join(config.rootDir, 'public')
  const CLIENT_DIR = path.join(PUBLIC, 'client')
  const LOG = path.join(config.logDir, 'marshallcam.log')
  const revokedPath = path.join(config.dataDir, 'revoked.json')
  const revocations = new RevocationStore(revokedPath)
  revocations.load()

  const logLevelName = (process.env.LOG_LEVEL || 'INFO').toUpperCase()
  const LOG_LEVEL = (logLevelName in LOG_LEVELS
    ? LOG_LEVELS[logLevelName as keyof typeof LOG_LEVELS]
    : LOG_LEVELS.INFO) as number

  let logSize = 0
  const MAX_LOG_SIZE = 10 * 1024 * 1024

  function log(msg: string, level: keyof typeof LOG_LEVELS = 'INFO'): void {
    if (LOG_LEVELS[level] < LOG_LEVEL) return
    const line = `[${new Date().toISOString()}] [${level}] [MarshallCam] ${msg}`
    try {
      fs.mkdirSync(config.logDir, { recursive: true })
      fs.appendFileSync(LOG, line + '\n')
      logSize += line.length + 1
      if (logSize > MAX_LOG_SIZE) {
        const content = fs.readFileSync(LOG, 'utf8').split('\n')
        const kept = content.slice(-5000).join('\n')
        fs.writeFileSync(LOG, kept)
        logSize = Buffer.byteLength(kept)
      }
    } catch { /* noop */ }
  }

  function logThrottled(key: string, msg: string, intervalMs = 30000): void {
    const now = Date.now()
    const last = logThrottledTimes.get(key) ?? 0
    if (now - last < intervalMs) return
    logThrottledTimes.set(key, now)
    log(msg)
  }
  const logThrottledTimes = new Map<string, number>()

  const timers: ReturnType<typeof setInterval>[] = []
  const timeouts: ReturnType<typeof setTimeout>[] = []

  function authenticate(req: http.IncomingMessage, kinds: TokenKind[], param: string, cookie: string): TokenPayload | null {
    const raw = extractToken(req, param, cookie)
    if (!raw) return null
    const payload = verifyToken(config.sessionSecret, raw)
    if (!payload) return null
    if (revocations.isRevoked(payload.jti)) return null
    if (!kinds.includes(payload.kind)) return null
    return payload
  }

  function validateAuth(req: http.IncomingMessage): boolean {
    return !!authenticate(req, ['user', 'station'], 'token', 'marshall_token')
  }

  function validateMaxAuth(req: http.IncomingMessage): boolean {
    return !!authenticate(req, ['admin'], 'max_token', 'max_token')
  }

  function authorizeIntercom(req: http.IncomingMessage): boolean {
    return validateAuth(req) || isLocalStation(req)
  }

  const intercomLoginAttempts = new Map<string, { count: number; firstAttempt: number }>()
  const maxLoginAttempts = new Map<string, { count: number; firstAttempt: number }>()

  let dogCamProcess: ChildProcess | null = null
  let streamInputServer: net.Server | null = null
  let streamInputPort = 0
  let wss: WebSocketServer | null = null
  const wsDogCamClients = new Set<AuthedWS>()
  const wsFamilyClients = new Set<AuthedWS>()
  const wsKioskClients = new Set<AuthedWS>()
  let isLive = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let ffmpegRestarts = 0
  let familyAudioDecoder: ChildProcess | null = null
  let familySpeaker: SpeakerInstance | null = null
  let familyAudioRestarts = 0
  let lastStationHeartbeat = 0
  let speakerCtor: (new (opts: { channels: number; bitDepth: number; sampleRate: number }) => SpeakerInstance) | null = null
  let speakerLoadAttempted = false

  async function ecpFetch(ecpPath: string): Promise<string> {
    if (!config.tvIp) throw new Error('TV_IP is not configured')
    const url = `http://${config.tvIp}:${config.tvEcpPort}${ecpPath}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return res.text()
  }

  async function ecpPost(ecpPath: string): Promise<void> {
    if (!config.tvIp) throw new Error('TV_IP is not configured')
    const url = `http://${config.tvIp}:${config.tvEcpPort}${ecpPath}`
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) })
  }

  function parseXmlField(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
    return match && match[1] ? match[1] : null
  }

  function startDogCam(): void {
    if (dogCamProcess) return
    log('DOGCAM: Starting video-only capture (no audio to prevent echo)...')
    const args = [
      '-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720',
      '-i', '0:0',
      '-c:v', 'mpeg1video', '-b:v', '1500k', '-bf', '0', '-q:v', '5',
      '-r', '30', '-g', '60',
      '-an',
      '-f', 'mpegts', '-muxdelay', '0.001',
      `tcp://127.0.0.1:${streamInputPort}`,
    ]
    const proc = spawn(config.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    dogCamProcess = proc

    proc.stderr?.on('data', (d: Buffer) => {
      const m = d.toString()
      if ((m.includes('Error') || m.includes('error') || m.includes('fail')) && !m.includes('falling back') && !m.includes('frame='))
        logThrottled('dogcam_err', `DOGCAM_ERR: ${m.trim().substring(0, 200)}`, 10000)
    })

    dogCamProcess.on('exit', (code: number | null) => {
      log(`DOGCAM_EXIT: code=${code}`)
      dogCamProcess = null
      if (wsDogCamClients.size > 0 && ffmpegRestarts < MAX_RESTARTS) {
        ffmpegRestarts++
        log(`DOGCAM: Restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${ffmpegRestarts}/${MAX_RESTARTS})`)
        timeouts.push(setTimeout(startDogCam, RESTART_DELAY_MS))
      } else {
        if (ffmpegRestarts >= MAX_RESTARTS) log('DOGCAM: Max restarts reached — camera may be unplugged')
        isLive = false
        ffmpegRestarts = 0
      }
    })

    isLive = true
    ffmpegRestarts = 0
    log('DOGCAM: Process started')
  }

  function stopDogCam(): void {
    if (!dogCamProcess) return
    log('DOGCAM: Stopping...')
    try { dogCamProcess.kill('SIGTERM') } catch { /* noop */ }
    const proc = dogCamProcess
    timeouts.push(setTimeout(() => { try { proc?.kill('SIGKILL') } catch { /* noop */ } dogCamProcess = null }, 3000))
  }

  async function loadSpeaker(): Promise<typeof speakerCtor> {
    if (speakerLoadAttempted) return speakerCtor
    speakerLoadAttempted = true
    try {
      // Native addon; missing on Linux CI. Lazy-load so import of this module stays side-effect free.
      const mod = await import('speaker')
      speakerCtor = mod.default as typeof speakerCtor
    } catch (err) {
      log(`SPEAKER: module unavailable (${err instanceof Error ? err.message : String(err)})`)
      speakerCtor = null
    }
    return speakerCtor
  }

  async function startFamilyAudio(): Promise<void> {
    if (familyAudioDecoder) return
    log('FAMILY_AUDIO: Starting PCM playback...')
    const Speaker = await loadSpeaker()
    if (Speaker) {
      familySpeaker = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 48000 })
      familySpeaker.on('error', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log(`FAMILY_AUDIO: Speaker error (non-fatal): ${message}`)
        try { familySpeaker?.close(false) } catch { /* noop */ }
        familySpeaker = null
      })
      familySpeaker.on('close', () => {
        log('FAMILY_AUDIO: Speaker closed')
        familySpeaker = null
      })
    }
    const proc = spawn(config.ffmpegPath, [
      '-i', 'pipe:0', '-vn',
      '-af', 'volume=0.6',
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-acodec', 'pcm_s16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    familyAudioDecoder = proc
    familyAudioRestarts = 0

    proc.stdout?.on('error', () => { /* pipe broken — ignore */ })
    if (familySpeaker && proc.stdout) proc.stdout.pipe(familySpeaker as unknown as NodeJS.WritableStream)

    proc.stderr?.on('data', (d: Buffer) => {
      const m = d.toString()
      if (m.includes('Error') || m.includes('error'))
        logThrottled('fam_audio_err', `FAMILY_AUDIO_ERR: ${m.trim().substring(0, 150)}`, 10000)
    })

    proc.on('exit', (code: number | null) => {
      log(`FAMILY_AUDIO_EXIT: code=${code}`)
      familyAudioDecoder = null
      if (familySpeaker) { try { familySpeaker.close(false) } catch { /* noop */ } familySpeaker = null }
      if (wsFamilyClients.size > 0 && familyAudioRestarts < MAX_RESTARTS) {
        familyAudioRestarts++
        log(`FAMILY_AUDIO: Restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${familyAudioRestarts}/${MAX_RESTARTS})`)
        timeouts.push(setTimeout(() => { void startFamilyAudio() }, RESTART_DELAY_MS))
      } else if (wsFamilyClients.size === 0) {
        log('FAMILY_AUDIO: No family clients — not restarting')
      } else if (familyAudioRestarts >= MAX_RESTARTS) {
        log('FAMILY_AUDIO: Max restarts reached — audio unavailable')
        for (const kc of wsKioskClients) {
          if (kc.readyState === WebSocket.OPEN)
            kc.send(JSON.stringify({ type: 'family_audio_failed' }))
        }
      }
    })
  }

  function writeFamilyAudio(buf: Buffer): void {
    if (!familyAudioDecoder || !familyAudioDecoder.stdin || !familyAudioDecoder.stdin.writable) return
    const ok = familyAudioDecoder.stdin.write(buf)
    if (!ok) {
      familyAudioDecoder.stdin.once('drain', () => {
        log('FAMILY_AUDIO: stdin drained — backpressure resolved')
      })
    }
  }

  function stopFamilyAudio(): void {
    if (!familyAudioDecoder) { log('FAMILY_AUDIO: Already stopped'); return }
    log('FAMILY_AUDIO: Stopping...')
    const proc = familyAudioDecoder
    try { proc.stdin?.end() } catch { /* noop */ }
    try { proc.kill('SIGTERM') } catch { /* noop */ }
    timeouts.push(setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } }, 3000))
  }

  function createStreamInputServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        log('DOGCAM: ffmpeg connected to relay')
        socket.on('data', (chunk: Buffer) => {
          for (const ws of wsDogCamClients) {
            if (ws.readyState === WebSocket.OPEN) try { ws.send(chunk) } catch { /* noop */ }
          }
        })
        socket.on('close', () => log('DOGCAM: relay disconnected'))
        socket.on('error', () => log('DOGCAM: relay error'))
      })
      srv.on('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo
        streamInputPort = addr.port
        streamInputServer = srv
        log(`RELAY: Listening on 127.0.0.1:${streamInputPort}`)
        resolve()
      })
    })
  }

  function loadPwaIndex(): string {
    try { return fs.readFileSync(path.join(PUBLIC, 'client', 'index.html'), 'utf8') } catch {
      log('WARN: PWA index.html not found')
      return ''
    }
  }

  let pwaIndex = loadPwaIndex()

  function kioskPage(token: string): string {
    const title = config.appName
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0c0c14">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0c0c14;color:#e8e8ef;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',system-ui,sans-serif;overflow:hidden;cursor:none;-webkit-user-select:none;user-select:none}
.standby{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;height:100dvh;text-align:center;position:absolute;inset:0;transition:opacity 1s ease,transform 1s ease}
.standby.hidden{opacity:0;transform:scale(0.95);pointer-events:none}
.clock{font-size:min(18vw,12rem);font-weight:100;color:#00d4ff;letter-spacing:0.02em;line-height:1}
.status-badge{margin-top:2.5rem;padding:0.6rem 2rem;border:1px solid rgba(0,96,128,0.3);border-radius:16px;color:#006080;font-size:0.9rem;font-weight:500;letter-spacing:0.1em}
.paw{margin-top:3rem;font-size:0.8rem;color:#1a1a28;letter-spacing:0.2em;text-transform:uppercase}
</style></head><body>
<div class="standby" id="standby">
  <div class="clock" id="clock"></div>
  <div class="status-badge">STANDBY</div>
  <div class="paw">${title.toUpperCase()}</div>
</div>
<script>
var TK=${JSON.stringify(token)};
</script></body></html>`
  }

  function issueAuth(kind: TokenKind): { token: string; maxAge: number } {
    const ttl = kindTtlSeconds(kind, config.sessionTtlHours, config.stationTokenTtlDays)
    const { token } = issueToken(config.sessionSecret, kind, ttl)
    return { token, maxAge: ttl }
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function rateLimited(map: Map<string, { count: number; firstAttempt: number }>, ip: string): boolean {
    const now = Date.now()
    const attempt = map.get(ip)
    return !!(attempt && attempt.count >= LOGIN_RATE_LIMIT && (now - attempt.firstAttempt) < LOGIN_RATE_WINDOW)
  }

  function recordFail(map: Map<string, { count: number; firstAttempt: number }>, ip: string): void {
    const now = Date.now()
    const existing = map.get(ip)
    map.set(ip, { count: (existing?.count ?? 0) + 1, firstAttempt: existing?.firstAttempt ?? now })
  }

  async function mintLiveKit(req: http.IncomingMessage, identityPrefix: string, body: string): Promise<{ token: string; url: string; iceServers: IceServer[] }> {
    const parsed = body ? JSON.parse(body) : {}
    const roomName = parsed.room ?? 'marshallcam'
    const identity = parsed.identity ?? `${identityPrefix}-${Date.now().toString(36)}`
    const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { identity })
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
    const token = await at.toJwt()
    return { token, url: getLiveKitUrl(req, config), iceServers: config.iceServers }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const method = req.method ?? 'GET'
    const startMs = Date.now()

    res.on('finish', () => {
      const ms = Date.now() - startMs
      if (url.pathname !== '/ws' && !url.pathname.startsWith('/assets/'))
        log(`${method} ${url.pathname} → ${res.statusCode} (${ms}ms)`, res.statusCode >= 400 ? 'WARN' : 'DEBUG')
    })

    if (url.pathname.startsWith('/assets/')) {
      const filePath = path.join(CLIENT_DIR, url.pathname)
      if (!filePath.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return }
      try {
        const data = fs.readFileSync(filePath)
        const ext = path.extname(filePath)
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' })
        res.end(data)
      } catch { res.writeHead(404); res.end() }
      return
    }

    if (STATIC_FILES.includes(url.pathname)) {
      const filePath = path.join(PUBLIC, path.basename(url.pathname))
      try {
        const data = fs.readFileSync(filePath)
        const ext = path.extname(filePath)
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.js' ? 'no-cache' : 'public, max-age=86400' })
        res.end(data)
      } catch { res.writeHead(404); res.end() }
      return
    }

    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true, uptime: process.uptime() })
      return
    }

    if (url.pathname === '/app') {
      json(res, 200, { name: config.appName, tagline: config.appTagline })
      return
    }

    if (url.pathname === '/station/session' && method === 'POST') {
      if (!isLocalStation(req)) { json(res, 403, { ok: false, error: 'Forbidden' }); return }
      const { token, maxAge } = issueAuth('station')
      log('STATION_SESSION')
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader('marshall_token', token, maxAge, '/'),
      })
      res.end(JSON.stringify({ ok: true, token }))
      return
    }

    if (url.pathname === '/station/heartbeat' && method === 'POST') {
      if (!isLocalStation(req)) { json(res, 403, { ok: false, error: 'Forbidden' }); return }
      lastStationHeartbeat = Date.now()
      json(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/station/health') {
      if (!isLocalStation(req)) { json(res, 403, { ok: false, error: 'Forbidden' }); return }
      const age = lastStationHeartbeat ? Math.round((Date.now() - lastStationHeartbeat) / 1000) : null
      json(res, 200, {
        stationConnected: lastStationHeartbeat > 0 && (Date.now() - lastStationHeartbeat) < HEARTBEAT_STALE_MS,
        lastHeartbeatAgeSec: age,
      })
      return
    }

    if (url.pathname === '/status') {
      if (!authorizeIntercom(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      json(res, 200, {
        status: isLive ? 'live' : (dogCamProcess ? 'starting' : 'idle'),
        viewers: wsDogCamClients.size,
        familyClients: wsFamilyClients.size,
        kioskClients: wsKioskClients.size,
        ffmpeg: dogCamProcess !== null,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        name: config.appName,
        tagline: config.appTagline,
      })
      return
    }

    if (url.pathname === '/debug') {
      if (!validateAuth(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return }
      const lines: string[] = []
      try { lines.push(...fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-50)) } catch { /* noop */ }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`${config.appName} ${isLive ? 'LIVE' : 'IDLE'} | Dog:${wsDogCamClients.size} Fam:${wsFamilyClients.size} Kiosk:${wsKioskClients.size} | FFmpeg:${dogCamProcess ? 'running' : 'stopped'}\n\n${lines.join('\n')}`)
      return
    }

    if (url.pathname === '/login' && method === 'POST') {
      const clientIp = req.socket.remoteAddress ?? 'unknown'
      if (rateLimited(intercomLoginAttempts, clientIp)) {
        json(res, 429, { ok: false, error: 'Too many attempts' })
        return
      }
      const body = await readBody(req)
      const pw = parsePassword(body)
      if (pw === config.stationPin) {
        intercomLoginAttempts.delete(clientIp)
        const { token, maxAge } = issueAuth('user')
        log('AUTH_OK')
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieHeader('marshall_token', token, maxAge, '/'),
        })
        res.end(JSON.stringify({ ok: true, token }))
      } else {
        recordFail(intercomLoginAttempts, clientIp)
        log('AUTH_FAIL')
        json(res, 401, { ok: false, error: 'Wrong password' })
      }
      return
    }

    if (url.pathname === '/logout' && method === 'POST') {
      const raw = extractToken(req, 'token', 'marshall_token')
      const payload = raw ? verifyToken(config.sessionSecret, raw) : null
      if (payload) revocations.revoke(payload.jti, payload.exp)
      log('AUTH_LOGOUT')
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie('marshall_token', '/'),
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/kiosk') {
      if (!authorizeIntercom(req)) { res.writeHead(302, { 'Location': '/' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(kioskPage(extractToken(req, 'token', 'marshall_token')))
      return
    }

    if (url.pathname === '/max/login' && method === 'POST') {
      if (!config.adminPassword) { json(res, 404, { error: 'Admin dashboard disabled' }); return }
      const clientIp = req.socket.remoteAddress ?? 'unknown'
      if (rateLimited(maxLoginAttempts, clientIp)) {
        json(res, 429, { ok: false, error: 'Too many attempts' })
        return
      }
      const body = await readBody(req)
      const pw = parsePassword(body)
      if (pw === config.adminPassword) {
        maxLoginAttempts.delete(clientIp)
        const { token, maxAge } = issueAuth('admin')
        log('ADMIN_AUTH_OK')
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieHeader('max_token', token, maxAge, '/max'),
        })
        res.end(JSON.stringify({ ok: true, token }))
      } else {
        recordFail(maxLoginAttempts, clientIp)
        log('ADMIN_AUTH_FAIL')
        json(res, 401, { ok: false, error: 'Wrong password' })
      }
      return
    }

    if (url.pathname === '/max/logout' && method === 'POST') {
      const raw = extractToken(req, 'max_token', 'max_token')
      const payload = raw ? verifyToken(config.sessionSecret, raw) : null
      if (payload) revocations.revoke(payload.jti, payload.exp)
      log('ADMIN_AUTH_LOGOUT')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie('max_token', '/max') })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/max/status') {
      if (!config.adminPassword) { json(res, 404, { error: 'Admin dashboard disabled' }); return }
      if (!validateMaxAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      const tvInfo = config.tvIp ? await ecpFetch('/query/device-info').catch(() => null) : null
      json(res, 200, {
        intercom: { status: isLive ? 'live' : (dogCamProcess ? 'starting' : 'idle'), viewers: wsDogCamClients.size, familyClients: wsFamilyClients.size, kioskClients: wsKioskClients.size, ffmpeg: dogCamProcess !== null },
        tv: config.tvIp
          ? (tvInfo ? { reachable: true, powerMode: parseXmlField(tvInfo, 'power-mode'), model: parseXmlField(tvInfo, 'model-name'), softwareVersion: parseXmlField(tvInfo, 'software-version') } : { reachable: false })
          : { reachable: false, disabled: true },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      })
      return
    }

    if (url.pathname.startsWith('/max/tv/')) {
      if (!config.adminPassword) { json(res, 404, { error: 'Admin dashboard disabled' }); return }
      if (!validateMaxAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      if (!config.tvIp) { json(res, 404, { error: 'TV control disabled' }); return }

      const tvPath = url.pathname.replace('/max/tv', '')
      try {
        if (tvPath === '/info') {
          const data = await ecpFetch('/query/device-info')
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(data)
        } else if (tvPath === '/apps') {
          const data = await ecpFetch('/query/apps')
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(data)
        } else if (tvPath === '/active') {
          const data = await ecpFetch('/query/active-app')
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(data)
        } else if (tvPath.startsWith('/power') && method === 'POST') {
          await ecpPost('/keypress/PowerOff')
          json(res, 200, { ok: true })
        } else if (tvPath.match(/^\/input\/[1-4]$/) && method === 'POST') {
          const n = tvPath.slice(-1)
          await ecpPost(`/keypress/InputHDMI${n}`)
          json(res, 200, { ok: true, input: `HDMI${n}` })
        } else if (tvPath === '/volume/up' && method === 'POST') {
          await ecpPost('/keypress/VolumeUp')
          json(res, 200, { ok: true })
        } else if (tvPath === '/volume/down' && method === 'POST') {
          await ecpPost('/keypress/VolumeDown')
          json(res, 200, { ok: true })
        } else if (tvPath === '/volume/mute' && method === 'POST') {
          await ecpPost('/keypress/VolumeMute')
          json(res, 200, { ok: true })
        } else if (tvPath.match(/^\/launch\/\d+$/) && method === 'POST') {
          const appId = tvPath.split('/').pop()!
          await ecpPost(`/launch/${appId}`)
          json(res, 200, { ok: true, appId })
        } else if (tvPath.match(/^\/keypress\/[\w]+$/) && method === 'POST') {
          const key = tvPath.split('/').pop()!
          await ecpPost(`/keypress/${key}`)
          json(res, 200, { ok: true, key })
        } else {
          json(res, 404, { error: 'Unknown TV command' })
        }
      } catch (e: unknown) {
        log(`ECP_ERR: ${e instanceof Error ? e.message : String(e)}`)
        json(res, 502, { error: 'TV unreachable' })
      }
      return
    }

    if (url.pathname === '/livekit-token' && method === 'POST') {
      if (!authorizeIntercom(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      try {
        const body = await readBody(req)
        const data = await mintLiveKit(req, 'family', body)
        json(res, 200, data)
      } catch (e: unknown) {
        log(`LIVEKIT_TOKEN_ERR: ${e instanceof Error ? e.message : String(e)}`)
        json(res, 500, { error: 'Failed to generate LiveKit token' })
      }
      return
    }

    if (url.pathname === '/max/livekit-token' && method === 'POST') {
      if (!config.adminPassword) { json(res, 404, { error: 'Admin dashboard disabled' }); return }
      if (!validateMaxAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      try {
        const body = await readBody(req)
        const data = await mintLiveKit(req, 'admin', body)
        json(res, 200, data)
      } catch (e: unknown) {
        log(`LIVEKIT_TOKEN_ERR: ${e instanceof Error ? e.message : String(e)}`)
        json(res, 500, { error: 'Failed to generate LiveKit token' })
      }
      return
    }

    if (url.pathname.startsWith('/max/api/')) {
      if (!config.adminPassword) { json(res, 404, { error: 'Admin dashboard disabled' }); return }
      if (!validateMaxAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return }
      if (!config.adminAiUrl) { json(res, 404, { error: 'AI proxy disabled' }); return }

      const apiPath = url.pathname.replace('/max/api', '')
      const targetUrl = `${config.adminAiUrl.replace(/\/$/, '')}${apiPath}${url.search}`
      try {
        const headers: Record<string, string> = { 'Content-Type': req.headers['content-type'] ?? 'application/json' }
        if (req.headers['accept']) headers['accept'] = req.headers['accept'] as string
        const bodyChunks: Buffer[] = []
        if (method !== 'GET' && method !== 'HEAD') {
          await new Promise<void>((resolve) => {
            req.on('data', (c: Buffer) => bodyChunks.push(c))
            req.on('end', () => resolve())
          })
        }
        const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined
        const apiRes = await fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(30_000) })
        const resBody = await apiRes.text()
        res.writeHead(apiRes.status, { 'Content-Type': apiRes.headers.get('content-type') ?? 'application/json' })
        res.end(resBody)
      } catch (e: unknown) {
        log(`AI_PROXY_ERR: ${e instanceof Error ? e.message : String(e)}`)
        json(res, 502, { error: 'AI backend unreachable' })
      }
      return
    }

    if ((url.pathname === '/max' || url.pathname === '/max/' || (url.pathname.startsWith('/max/') && !url.pathname.startsWith('/max/api/') && !url.pathname.startsWith('/max/tv/')))) {
      if (!config.adminPassword) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Admin dashboard disabled')
        return
      }
      const maxDir = path.join(PUBLIC, 'max')
      let filePath = path.join(maxDir, url.pathname.replace('/max', '') || 'index.html')
      if (!filePath.startsWith(maxDir)) { res.writeHead(403); res.end(); return }
      if (filePath.endsWith('/') || filePath === maxDir) filePath = path.join(maxDir, 'index.html')
      const isHtml = filePath.endsWith('.html')
      if (isHtml && !extractToken(req, 'max_token', 'max_token')) {
        res.writeHead(302, { 'Location': '/max/login' })
        res.end()
        return
      }
      const assetPath = filePath === path.join(maxDir, 'index.html') ? '' : url.pathname.replace('/max', '')
      const fullAssetPath = assetPath ? path.join(maxDir, assetPath) : path.join(maxDir, 'index.html')
      try {
        const data = fs.readFileSync(fullAssetPath)
        const ext = path.extname(fullAssetPath)
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' })
        res.end(data)
      } catch {
        try {
          const index = fs.readFileSync(path.join(maxDir, 'index.html'))
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
          res.end(index)
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body style="background:#0c0c14;color:#00d4ff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><h1>Admin dashboard not built yet</h1></body></html>')
        }
      }
      return
    }

    if (pwaIndex) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
      res.end(pwaIndex)
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('MarshallCam PWA not built. Run: npm run build')
    }
  })

  wss = new WebSocket.Server({ noServer: true })

  function scheduleIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (wsDogCamClients.size === 0 && wsFamilyClients.size === 0) {
        log('IDLE_TIMEOUT: Stopping all streams')
        stopDogCam()
        stopFamilyAudio()
        isLive = false
      }
    }, IDLE_TIMEOUT_MS)
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: stream.Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const token = url.searchParams.get('token') || ''
    const streamName = (url.searchParams.get('stream') ?? 'dogcam') as StreamType
    const payload = token ? verifyToken(config.sessionSecret, token) : null
    const tokenOk = !!(payload && (payload.kind === 'user' || payload.kind === 'station') && !revocations.isRevoked(payload.jti))
    if (!tokenOk && !isLocalStation(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const aws = ws as AuthedWS
      aws._stream = streamName

      if (streamName === 'dogcam') {
        wsDogCamClients.add(aws)
        log(`WS+ dogcam (${wsDogCamClients.size} total)`)
        if (!dogCamProcess) startDogCam()
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }

        aws.on('close', () => {
          wsDogCamClients.delete(aws)
          log(`WS- dogcam (${wsDogCamClients.size} total)`)
          for (const kc of wsKioskClients) {
            if (kc.readyState === WebSocket.OPEN) {
              kc.send(JSON.stringify({ type: 'viewers_changed', count: wsDogCamClients.size }))
            }
          }
          if (wsDogCamClients.size === 0) scheduleIdle()
        })
      } else if (streamName === 'family') {
        wsFamilyClients.add(aws)
        log(`WS+ family (${wsFamilyClients.size} total)`)
        if (!dogCamProcess) startDogCam()
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        if (!familyAudioDecoder) void startFamilyAudio()

        for (const kc of wsKioskClients) {
          if (kc.readyState === WebSocket.OPEN)
            kc.send(JSON.stringify({ type: 'family_connected' }))
        }

        let familyMsgCount = 0
        let familyBytes = 0
        aws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          familyMsgCount++
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          familyBytes += buf.length
          logThrottled('fam_data', `FAM_DATA: ${familyMsgCount} msgs / ${(familyBytes / 1024).toFixed(0)}KB total`, 60000)
          if (familyAudioDecoder && familyAudioDecoder.stdin && familyAudioDecoder.stdin.writable) {
            writeFamilyAudio(buf)
          }
          for (const kc of wsKioskClients) {
            if (kc.readyState === WebSocket.OPEN) {
              try { kc.send(buf) } catch { /* noop */ }
            }
          }
        })

        aws.on('close', () => {
          wsFamilyClients.delete(aws)
          log(`WS- family (${wsFamilyClients.size} total) after ${familyMsgCount} msgs / ${familyBytes} bytes`)
          if (wsFamilyClients.size === 0) {
            stopFamilyAudio()
            for (const kc of wsKioskClients) {
              if (kc.readyState === WebSocket.OPEN)
                kc.send(JSON.stringify({ type: 'family_disconnected' }))
            }
          }
        })
      } else if (streamName === 'family_kiosk') {
        aws._kiosk = true
        wsKioskClients.add(aws)
        log(`WS+ kiosk (${wsKioskClients.size} total)`)

        aws.send(JSON.stringify({ type: 'viewers_changed', count: wsDogCamClients.size }))
        if (wsFamilyClients.size > 0) {
          aws.send(JSON.stringify({ type: 'family_connected' }))
        }

        aws.on('close', () => {
          wsKioskClients.delete(aws)
          log(`WS- kiosk (${wsKioskClients.size} total)`)
        })
      }

      aws.on('error', () => {
        wsDogCamClients.delete(aws)
        wsFamilyClients.delete(aws)
        wsKioskClients.delete(aws)
      })
    })
  })

  timers.push(setInterval(() => { revocations.prune() }, 60_000 * 5))
  timers.push(setInterval(() => {
    const fresh = loadPwaIndex()
    if (fresh && fresh !== pwaIndex) { pwaIndex = fresh; log('PWA_INDEX: Auto-updated') }
  }, 60_000))

  if (process.platform === 'darwin') {
    timers.push(setInterval(() => {
      exec('osascript -e "set volume output volume 100"', () => { /* ignore */ })
    }, 60_000))
  }

  await createStreamInputServer()

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listenHost, () => {
      const addr = server.address()
      const bound = typeof addr === 'object' && addr ? addr.port : config.port
      log(`${config.appName} on http://${config.listenHost}:${bound} | Relay:${streamInputPort}`)
      resolve(bound)
    })
  })

  async function close(): Promise<void> {
    for (const t of timers) clearInterval(t)
    for (const t of timeouts) clearTimeout(t)
    if (idleTimer) clearTimeout(idleTimer)
    stopDogCam()
    stopFamilyAudio()
    if (wss) {
      for (const ws of wsDogCamClients) { try { ws.close() } catch { /* noop */ } }
      for (const ws of wsFamilyClients) { try { ws.close() } catch { /* noop */ } }
      for (const ws of wsKioskClients) { try { ws.close() } catch { /* noop */ } }
      await new Promise<void>((resolve) => { wss!.close(() => resolve()) })
    }
    if (streamInputServer) {
      await new Promise<void>((resolve) => { streamInputServer!.close(() => resolve()) })
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }

  return { server, port, config, close }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(__filename)
}

if (isMain()) {
  process.on('uncaughtException', (err: Error) => {
    try { fs.appendFileSync(path.join(projectRoot(), 'logs', 'marshallcam.log'), `UNCAUGHT_EXCEPTION: ${err.message}\n`) } catch { /* noop */ }
  })
  process.on('unhandledRejection', (reason: unknown) => {
    try { fs.appendFileSync(path.join(projectRoot(), 'logs', 'marshallcam.log'), `UNHANDLED_REJECTION: ${reason instanceof Error ? reason.message : String(reason)}\n`) } catch { /* noop */ }
  })

  startMarshallCam().then((handle) => {
    const shutdown = (signal: string) => {
      void handle.close().then(() => process.exit(0)).catch(() => process.exit(1))
      setTimeout(() => process.exit(1), 5000).unref()
      void signal
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
