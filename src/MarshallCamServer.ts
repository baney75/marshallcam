import http from 'node:http'
import { URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { WebSocket, type WebSocketServer } from 'ws'
import net from 'node:net'
import stream from 'node:stream'
import Speaker from 'speaker'
import { AccessToken } from 'livekit-server-sdk'

// Speaker module doesn't have proper types; declare what we use
type SpeakerInstance = InstanceType<typeof Speaker> & { on(event: 'close', listener: () => void): SpeakerInstance }

const HOME = process.env.HOME || '/Users/__USER__'
const ROOT = path.join(HOME, 'MarshallOS')
const PUBLIC = path.join(ROOT, 'public')
const LOG = path.join(ROOT, 'marshallcam.log')
const PORT = 3000
const IDLE_TIMEOUT_MS = 45_000
const PASSWORD = '__STATION_PIN__'
const MAX_PASSWORD = '__ADMIN_PASSWORD__'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 5_000
const TV_IP = '__TV_IP__'
const ECP_PORT = 8060
const OPENCODE_PORT = 4096
const LAN_IP = '__SERVER_LAN_IP__'
const LIVEKIT_LOCAL = 'ws://127.0.0.1:7880'
const LIVEKIT_LAN = `ws://${LAN_IP}:7880`
const LIVEKIT_REMOTE = 'wss://livekit.example.com'
const LIVEKIT_API_KEY = '__LIVEKIT_API_KEY__'
const LIVEKIT_API_SECRET = '__LIVEKIT_API_SECRET__'


interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

function getIceServers(): IceServer[] {
  return [
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
}

function getLiveKitUrl(req: http.IncomingMessage): string {
  const host = req.headers.host || ''
  const forwarded = req.headers['x-forwarded-for'] as string | undefined
  const remoteAddr = req.socket.remoteAddress || ''
  if (host.includes('example.com') || forwarded) return LIVEKIT_REMOTE
  if (remoteAddr.includes('192.168.') || remoteAddr === LAN_IP) return LIVEKIT_LAN
  return LIVEKIT_LOCAL
}

// ── TYPES ───────────────────────────────────────────────────

type StreamType = 'dogcam' | 'family' | 'family_kiosk'

interface AuthedWS extends WebSocket {
  _stream: StreamType
  _kiosk?: boolean
}

// ── LOGGING ─────────────────────────────────────────────────

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const
const LOG_LEVEL = (process.env.LOG_LEVEL && process.env.LOG_LEVEL.toUpperCase() in LOG_LEVELS
  ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase() as keyof typeof LOG_LEVELS]
  : LOG_LEVELS.INFO) as number

let logSize = 0
const MAX_LOG_SIZE = 10 * 1024 * 1024

function log(msg: string, level: keyof typeof LOG_LEVELS = 'INFO'): void {
  if (LOG_LEVELS[level] < LOG_LEVEL) return
  const line = `[${new Date().toISOString()}] [${level}] [MarshallCam] ${msg}`
  try {
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
  const last = logThrottled._times.get(key) ?? 0
  if (now - last < intervalMs) return
  logThrottled._times.set(key, now)
  log(msg)
}
namespace logThrottled { export const _times = new Map<string, number>() }

process.on('uncaughtException', (err: Error) => {
  log(`UNCAUGHT_EXCEPTION: ${err.message}\n${err.stack ?? ''}`)
})

process.on('unhandledRejection', (reason: unknown) => {
  log(`UNHANDLED_REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`)
})

// ── TV ECP HELPERS ──────────────────────────────────────────────

async function ecpFetch(ecpPath: string): Promise<string> {
  const url = `http://${TV_IP}:${ECP_PORT}${ecpPath}`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  return res.text()
}

async function ecpPost(ecpPath: string): Promise<void> {
  const url = `http://${TV_IP}:${ECP_PORT}${ecpPath}`
  await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) })
}

function parseXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match && match[1] ? match[1] : null
}

// ── SESSIONS ────────────────────────────────────────────────

const sessions = new Map<string, number>()
const maxSessions = new Map<string, number>()
const SESSION_TTL = 24 * 60 * 60 * 1000

function pruneSessions(): void {
  const now = Date.now()
  for (const [k, t] of sessions) { if (now - t > SESSION_TTL) sessions.delete(k) }
  for (const [k, t] of maxSessions) { if (now - t > SESSION_TTL) maxSessions.delete(k) }
}
setInterval(pruneSessions, 60_000 * 5)

function addSession(token: string): void { sessions.set(token, Date.now()) }
function hasSession(token: string): boolean { const t = sessions.get(token); if (!t) return false; if (Date.now() - t > SESSION_TTL) { sessions.delete(token); return false } return true }

function addMaxSession(token: string): void { maxSessions.set(token, Date.now()) }
function hasMaxSession(token: string): boolean { const t = maxSessions.get(token); if (!t) return false; if (Date.now() - t > SESSION_TTL) { maxSessions.delete(token); return false } return true }

function extractCookie(req: http.IncomingMessage, name: string): string {
  const c = (req.headers.cookie ?? '').split(';').map(s => s.trim())
  const found = c.find(s => s.startsWith(name + '='))
  return found ? (found.split('=')[1] ?? '') : ''
}

function extractToken(req: http.IncomingMessage, param: string, cookie: string): string {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  return url.searchParams.get(param) || extractCookie(req, cookie)
}

function validateAuth(req: http.IncomingMessage): boolean {
  return hasSession(extractToken(req, 'token', 'marshall_token'))
}

// Local TV station (Web App on this Mac, start_url http://localhost:3000/): sessions are in-memory with a
// fixed 24h TTL, so a station that stays up >24h and then reconnects was locked out with 401 forever
// (2026-10-05..11). Trust only direct loopback requests addressed to localhost that carry no proxy
// headers; Cloudflare tunnel traffic (also from 127.0.0.1) always has Host=*.example.com + Cf-Connecting-Ip.
// Added 2026-10-11.
function isLocalStation(req: http.IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || ''
  if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') return false
  const h = req.headers
  if (h['x-forwarded-for'] || h['cf-connecting-ip'] || h['cf-ray'] || h['x-real-ip'] || h['forwarded']) return false
  const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1'
}

function validateMaxAuth(req: http.IncomingMessage): boolean {
  return hasMaxSession(extractToken(req, 'max_token', 'max_token'))
}

function createSession(): string {
  const t = crypto.randomBytes(32).toString('hex')
  addSession(t)
  return t
}

// ── STREAM STATE ─────────────────────────────────────────────

const intercomLoginAttempts = new Map<string, { count: number; firstAttempt: number }>()
const maxLoginAttempts = new Map<string, { count: number; firstAttempt: number }>()
const LOGIN_RATE_LIMIT = 5
const LOGIN_RATE_WINDOW = 60_000

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

// ── DOG CAM ─────────────────────────────────────────────────
// Video only — no audio. C922 mic would pick up HDMI speaker echo.

function startDogCam(): void {
  if (dogCamProcess) return
  log('DOGCAM: Starting C922 video-only capture (no audio to prevent echo)...')
  const args = [
    '-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720',
    '-i', '0:0',
    '-c:v', 'mpeg1video', '-b:v', '1500k', '-bf', '0', '-q:v', '5',
    '-r', '30', '-g', '60',
    '-an',
    '-f', 'mpegts', '-muxdelay', '0.001',
    `tcp://127.0.0.1:${streamInputPort}`,
  ]
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  dogCamProcess = proc

  proc.stderr!.on('data', (d: Buffer) => {
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
      setTimeout(startDogCam, RESTART_DELAY_MS)
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
  const proc2 = dogCamProcess
  setTimeout(() => { try { proc2?.kill('SIGKILL') } catch { /* noop */ } dogCamProcess = null }, 3000)
  setTimeout(() => { dogCamProcess = null }, 5000)
}

// ── FAMILY AUDIO PLAYBACK ───────────────────────────────────
// Decodes WebM/Opus → PCM → HDMI speakers (dogs hear family)
// Volume at 60% to reduce C922 mic pickup from speakers

function startFamilyAudio(): void {
  if (familyAudioDecoder) return
  log('FAMILY_AUDIO: Starting PCM playback to HDMI...')
  familySpeaker = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 48000 }) as SpeakerInstance
  familySpeaker.on('error', (err: Error) => {
    log(`FAMILY_AUDIO: Speaker error (non-fatal): ${err.message}`)
    try { familySpeaker?.close(false) } catch { /* noop */ }
    familySpeaker = null
  })
  const proc = spawn(FFMPEG, [
    '-i', 'pipe:0', '-vn',
    '-af', 'volume=0.6',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    '-acodec', 'pcm_s16le', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  familyAudioDecoder = proc
  familyAudioRestarts = 0

  proc.stdout!.on('error', () => { /* pipe broken — ignore */ })
  proc.stdout!.pipe(familySpeaker!)

  proc.stderr!.on('data', (d: Buffer) => {
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
      setTimeout(startFamilyAudio, RESTART_DELAY_MS)
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

  familySpeaker!.on('close', () => {
    log('FAMILY_AUDIO: Speaker closed')
    familySpeaker = null
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
  setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } }, 3000)
  // Let the exit handler clean up familyAudioDecoder and familySpeaker
}

// ── TCP RELAY ───────────────────────────────────────────────

function createStreamInputServer(): Promise<void> {
  return new Promise(resolve => {
    const srv = net.createServer(socket => {
      log('DOGCAM: ffmpeg connected to relay')
      socket.on('data', (chunk: Buffer) => {
        for (const ws of wsDogCamClients) {
          if (ws.readyState === WebSocket.OPEN) try { ws.send(chunk) } catch { /* noop */ }
        }
      })
      socket.on('close', () => log('DOGCAM: relay disconnected'))
      socket.on('error', () => log('DOGCAM: relay error'))
    })
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      streamInputPort = addr.port
      streamInputServer = srv
      log(`RELAY: Listening on 127.0.0.1:${streamInputPort}`)
      resolve()
    })
  })
}

// ── PWA INDEX ───────────────────────────────────────────────

function loadPwaIndex(): string {
  try { return fs.readFileSync(path.join(PUBLIC, 'client', 'index.html'), 'utf8') } catch {
    log('WARN: PWA index.html not found')
    return ''
  }
}

let pwaIndex = loadPwaIndex()
process.on('SIGHUP', () => { pwaIndex = loadPwaIndex(); log('PWA_INDEX: Reloaded') })
setInterval(() => { const fresh = loadPwaIndex(); if (fresh && fresh !== pwaIndex) { pwaIndex = fresh; log('PWA_INDEX: Auto-updated') } }, 60_000)

// ── KIOSK DISPLAY PAGE ──────────────────────────────────────

function kioskPage(token: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0c0c14">
<title>MarshallOS</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0c0c14;color:#e8e8ef;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',system-ui,sans-serif;overflow:hidden;cursor:none;-webkit-user-select:none;user-select:none}
.standby{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;height:100dvh;text-align:center;position:absolute;inset:0;transition:opacity 1s ease,transform 1s ease}
.standby.hidden{opacity:0;transform:scale(0.95);pointer-events:none}
.standby::before{content:'';position:absolute;top:25%;left:50%;transform:translate(-50%,-50%);width:600px;height:600px;border-radius:50%;background:#00d4ff;opacity:0.06;filter:blur(120px);pointer-events:none;animation:breathe 6s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:0.08}50%{opacity:0.18}}
.clock{font-size:min(18vw,12rem);font-weight:100;color:#00d4ff;letter-spacing:0.02em;line-height:1;text-shadow:0 0 120px rgba(0,212,255,0.25)}
.clock-secs{font-size:min(4vw,2.5rem);font-weight:200;color:#006080;margin-top:0.2rem}
.date{font-size:min(3vw,1.8rem);font-weight:300;color:#1a5a6a;margin-top:0.8rem;letter-spacing:0.1em;text-transform:uppercase}
.status-badge{margin-top:2.5rem;padding:0.6rem 2rem;border:1px solid rgba(0,96,128,0.3);border-radius:16px;color:#006080;font-size:0.9rem;font-weight:500;letter-spacing:0.1em;backdrop-filter:blur(16px);background:rgba(0,96,128,0.04);transition:all 0.5s ease}
.status-badge.online{border-color:rgba(0,200,100,0.3);color:#00a050;background:rgba(0,200,100,0.04)}
.paw{margin-top:3rem;font-size:0.8rem;color:#1a1a28;letter-spacing:0.2em;text-transform:uppercase}
.family-view{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0c0c14;opacity:0;pointer-events:none;transition:opacity 0.8s ease}
.family-view.active{opacity:1;pointer-events:auto}
#family-video{width:100%;height:100%;object-fit:contain;background:#0c0c14}
.top-bar{position:fixed;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:1.5rem 2rem;z-index:10;background:linear-gradient(180deg,rgba(12,12,20,0.9) 0%,rgba(12,12,20,0) 100%)}
.badge{display:flex;align-items:center;gap:0.6rem;padding:0.5rem 1.2rem;border-radius:12px;font-size:0.85rem;font-weight:600;backdrop-filter:blur(20px);letter-spacing:0.06em;transition:all 0.5s ease}
.badge.live{background:rgba(0,230,118,0.12);border:1px solid rgba(0,230,118,0.3);color:#00e676}
.badge.idle{background:rgba(0,96,128,0.08);border:1px solid rgba(0,96,128,0.2);color:#006080}
.dot{width:10px;height:10px;border-radius:50%;transition:all 0.3s ease}
.dot.pulse{animation:pulse-dot 1.5s ease-in-out infinite}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.7)}}
.time-display{color:rgba(0,212,255,0.5);font-size:1.3rem;font-weight:200;letter-spacing:0.08em;font-variant-numeric:tabular-nums}
.no-cam{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(12,12,20,0.97);z-index:30;opacity:0;pointer-events:none;transition:opacity 0.5s ease}
.no-cam.active{opacity:1;pointer-events:auto}
.no-cam-icon{width:80px;height:80px;border-radius:20px;background:rgba(255,59,43,0.08);border:1px solid rgba(255,59,43,0.2);display:flex;align-items:center;justify-content:center;margin-bottom:1.5rem}
.no-cam-icon svg{width:36px;height:36px;stroke:#ff3b3b;fill:none;stroke-width:1.5}
.no-cam-title{color:#ff6b6b;font-size:1.4rem;font-weight:400}
.no-cam-sub{color:#3a3a50;font-size:0.9rem;margin-top:0.5rem}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
</style></head><body>
<div class="standby" id="standby">
  <div class="clock" id="clock"></div>
  <div class="clock-secs" id="clock-secs"></div>
  <div class="date" id="date"></div>
  <div class="status-badge" id="status-badge">STANDBY</div>
  <div class="paw">MARSHALLCAM</div>
</div>
<div class="family-view" id="family-view">
  <video id="family-video" autoplay playsinline muted></video>
  <div class="top-bar">
    <div class="badge idle" id="badge"><div class="dot" id="dot" style="background:#006080"></div><span id="badge-text">CONNECTING</span></div>
    <div class="time-display" id="time-display"></div>
  </div>
</div>
<div class="no-cam" id="no-cam">
  <div class="no-cam-icon"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><line x1="1" y1="1" x2="23" y2="23"/></svg></div>
  <div class="no-cam-title">Camera Offline</div>
  <div class="no-cam-sub">Stream will resume when camera reconnects</div>
</div>
<script>
var TK='${token}';
var famWS=null,dogWS=null,familyActive=false,camOnline=false;
var mediaSource=null,sourceBuffer=null,appendQueue=[],msReady=false,firstChunkCodec=null;
var mseRetryCount=0,lastJumpTime=0,isSafari=/Safari/.test(navigator.userAgent)&&!/Chrome|Android/.test(navigator.userAgent);
var MSE_MAX_RETRIES=5,MAX_BUF_SEC=10,JUMP_THRESHOLD=3,COOLDOWN=5000,MAX_QUEUE=60;
function drainQueue(){if(!sourceBuffer||!mediaSource||mediaSource.readyState!=='open')return;while(appendQueue.length>0&&!sourceBuffer.updating){try{sourceBuffer.appendBuffer(appendQueue.shift());}catch(e){break;}}evictBuffer();}
function evictBuffer(){var sb=sourceBuffer,vid=elFamVideo;if(!sb||!vid||vid.buffered.length===0)return;var end=vid.buffered.end(vid.buffered.length-1)-15;var start=vid.buffered.start(0);if(end>start){try{sb.remove(start,end);}catch(e){}}}
function detectCodec(data){if(data.byteLength<8)return null;var v=new Uint8Array(data.slice(0,8));if(v[0]===0&&v[1]===0&&v[2]===0&&v[4]===0x66&&v[5]===0x74&&v[6]===0x79&&v[7]===0x70)return'mp4';if(v[0]===0x1a&&v[1]===0x45&&v[2]===0xdf&&v[3]===0xa3)return'webm';return null;}
function jumpToLive(){var vid=elFamVideo;if(!vid||vid.buffered.length===0)return;vid.currentTime=vid.buffered.end(vid.buffered.length-1)-0.75;lastJumpTime=Date.now();}
function onProgress(){var vid=elFamVideo;if(!vid||vid.buffered.length===0)return;var bt=vid.buffered.end(vid.buffered.length-1)-vid.currentTime;if(isSafari&&bt>JUMP_THRESHOLD&&Date.now()-lastJumpTime>COOLDOWN){jumpToLive();}else if(!isSafari&&vid.buffered.length>0){var rate=bt>3?Math.min(1+0.2*Math.exp(0.5*(bt-3)),2):1;if(vid.playbackRate!==rate)vid.playbackRate=rate;}if(bt>MAX_BUF_SEC)jumpToLive();}
function initSourceBuffer(codecGroup){if(!mediaSource||mediaSource.readyState!=='open'||sourceBuffer)return;var MMS=('ManagedMediaSource' in window)?window.ManagedMediaSource:null;var isTypeSupported=MMS?MMS.isTypeSupported:MediaSource.isTypeSupported;var codecs=codecGroup==='mp4'?['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4']:['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'];for(var i=0;i<codecs.length;i++){if(isTypeSupported(codecs[i])){try{sourceBuffer=mediaSource.addSourceBuffer(codecs[i]);sourceBuffer.mode='segments';sourceBuffer.addEventListener('error',function(){teardownMse();retryMse();});sourceBuffer.addEventListener('updateend',function(){drainQueue();});return true;}catch(e){if(e.name==='InvalidStateError'){teardownMse();retryMse();return false;}}}}try{sourceBuffer=mediaSource.addSourceBuffer('audio/webm;codecs=opus');sourceBuffer.mode='segments';sourceBuffer.addEventListener('error',function(){teardownMse();retryMse();});sourceBuffer.addEventListener('updateend',function(){drainQueue();});return true;}catch(e){return false;}}
function teardownMse(){if(sourceBuffer){try{mediaSource.removeSourceBuffer(sourceBuffer);}catch(e){}}sourceBuffer=null;if(mediaSource){try{if(mediaSource.readyState==='open')mediaSource.endOfStream();}catch(e){}}mediaSource=null;msReady=false;firstChunkCodec=null;appendQueue=[];if(isSafari){elFamVideo.srcObject=null;}else{elFamVideo.removeAttribute('src');}elFamVideo.load();}
function retryMse(){if(mseRetryCount>=MSE_MAX_RETRIES)return;mseRetryCount++;setTimeout(function(){if(familyActive)setupMediaSource();},2000);}
function setupMediaSource(){if(mediaSource)return;var MMS=('ManagedMediaSource' in window)?window.ManagedMediaSource:null;var MSConstructor=MMS||MediaSource;mediaSource=new MSConstructor();if(MMS){elFamVideo.disableRemotePlayback=true;elFamVideo.srcObject=mediaSource;}else{elFamVideo.src=URL.createObjectURL(mediaSource);}elFamVideo.play().catch(function(){});mediaSource.addEventListener('sourceopen',function(){if(!MMS)URL.revokeObjectURL(elFamVideo.src||'');msReady=true;if(firstChunkCodec)initSourceBuffer(firstChunkCodec);},{once:true});mediaSource.addEventListener('sourceclose',function(){msReady=false;teardownMse();});mediaSource.addEventListener('error',function(){teardownMse();retryMse();});}
elFamVideo.addEventListener('error',function(){if(elFamVideo.error){if(elFamVideo.error.code===MediaError.MEDIA_ERR_DECODE||elFamVideo.error.code===MediaError.MEDIA_ERR_NETWORK){teardownMse();retryMse();}}});
elFamVideo.addEventListener('pause',function(){if(familyActive)elFamVideo.play().catch(function(){});});
elFamVideo.addEventListener('progress',onProgress);
function connectFamilyKiosk(){var p=location.protocol==='https:'?'wss:':'ws:';try{famWS=new WebSocket(p+'//'+location.host+'/ws?token='+TK+'&stream=family_kiosk');}catch(e){setTimeout(connectFamilyKiosk,3000);return;}famWS.binaryType='arraybuffer';famWS.onopen=function(){};famWS.onmessage=function(e){if(typeof e.data==='string'){try{var m=JSON.parse(e.data);if(m.type==='family_connected'){familyActive=true;mseRetryCount=0;lastJumpTime=Date.now();setupMediaSource();elStandby.classList.add('hidden');elFamView.classList.add('active');elNoCam.classList.remove('active');elBadge.className='badge live';elDot.className='dot pulse';elDot.style.background='#00e676';elBadgeText.textContent='FAMILY CALL';goFullscreen();}if(m.type==='family_disconnected'){familyActive=false;elFamView.classList.remove('active');teardownMse();setTimeout(function(){if(!familyActive){elStandby.classList.remove('hidden');if(!camOnline)elNoCam.classList.add('active');}},800);elBadge.className='badge idle';elDot.className='dot';elDot.style.background='#006080';elBadgeText.textContent='STANDBY';}if(m.type==='viewers_changed'){}}catch(ex){}}else if(e.data instanceof ArrayBuffer&&e.data.byteLength>0){try{if(!firstChunkCodec){firstChunkCodec=detectCodec(e.data);if(firstChunkCodec&&msReady){initSourceBuffer(firstChunkCodec);}}if(mediaSource&&mediaSource.readyState==='open'&&sourceBuffer){if(appendQueue.length>MAX_QUEUE){appendQueue.splice(0,appendQueue.length-Math.floor(MAX_QUEUE/2));}if(sourceBuffer.updating){appendQueue.push(e.data);}else{try{sourceBuffer.appendBuffer(e.data);}catch(ex){appendQueue.push(e.data);}}drainQueue();}}catch(ex){}}};famWS.onclose=function(){famWS=null;setTimeout(connectFamilyKiosk,3000);};famWS.onerror=function(){if(famWS)famWS.close();};}
connectDogCam();connectFamilyKiosk();
setInterval(function(){if(famWS&&famWS.readyState===1)famWS.send('');if(dogWS&&dogWS.readyState===1)dogWS.send('');},30000);
</script></body></html>`
}

// ── HTTP SERVER ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

const CLIENT_DIR = path.join(PUBLIC, 'client')
const STATIC_FILES = ['/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.svg', '/favicon.ico']

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'
  const startMs = Date.now()

  res.on('finish', () => {
    const ms = Date.now() - startMs
    if (url.pathname !== '/ws' && !url.pathname.startsWith('/assets/'))
      log(`${method} ${url.pathname} → ${res.statusCode} (${ms}ms)`, res.statusCode >= 400 ? 'WARN' : 'DEBUG')
  })

  // ── Static assets ──
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

  // ── API routes ──

  // Status
  if (url.pathname === '/status') {
    if (!validateAuth(req) && !isLocalStation(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: isLive ? 'live' : (dogCamProcess ? 'starting' : 'idle'),
      viewers: wsDogCamClients.size,
      familyClients: wsFamilyClients.size,
      kioskClients: wsKioskClients.size,
      ffmpeg: dogCamProcess !== null,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }))
    return
  }

  // Debug
   if (url.pathname === '/debug') {
    if (!validateAuth(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return }
    const lines: string[] = []
    try { lines.push(...fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-50)) } catch { /* noop */ }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`MarshallCam ${isLive ? 'LIVE' : 'IDLE'} | Dog:${wsDogCamClients.size} Fam:${wsFamilyClients.size} Kiosk:${wsKioskClients.size} | FFmpeg:${dogCamProcess ? 'running' : 'stopped'}\n\n${lines.join('\n')}`)
    return
  }

  // Test/diagnostic page
  if (url.pathname === '/test') {
    if (!validateAuth(req)) { res.writeHead(302, { 'Location': '/' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!DOCTYPE html><html><head><title>MarshallOS Test</title><style>body{background:#111;color:#0f0;font-family:monospace;padding:20px;font-size:14px}h2{color:#0d4d4d}pre{background:#000;padding:10px;border:1px solid #333;overflow:auto;max-height:60vh}button{background:#00d4ff;color:#000;border:none;padding:8px 16px;font-size:14px;cursor:pointer;margin:4px}button:hover{background:#0099aa}.pass{color:#00e676}.fail{color:#ff3b3b}.warn{color:#ffab00}</style></head><body>
<h2>MarshallOS Codec Diagnostics</h2>
<div id="results"></div>
<h2>Family Stream Test</h2>
<button onclick="testFamily()">Connect as Family</button>
<button onclick="stopFamily()">Disconnect</button>
<pre id="famLog">Not connected</pre>
<script>
var TK='${extractToken(req, 'token', 'marshall_token')}';
var famLog=document.getElementById('famLog');
var famWs=null,famStream=null,famRec=null;
var r='';
function add(label,pass){r+='<div class="'+(pass?'pass':'fail')+'">'+label+': '+(pass?'YES':'NO')+'</div>';}
add('MediaSource video/mp4;codecs=avc1.42E01E,mp4a.40.2',MediaSource.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
add('MediaSource video/mp4',MediaSource.isTypeSupported('video/mp4'));
add('MediaSource video/webm;codecs=vp8,opus',MediaSource.isTypeSupported('video/webm;codecs=vp8,opus'));
add('MediaSource video/webm;codecs=vp9,opus',MediaSource.isTypeSupported('video/webm;codecs=vp9,opus'));
add('MediaRecorder video/mp4;codecs=avc1.42E01E,mp4a.40.2',MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
add('MediaRecorder video/mp4',MediaRecorder.isTypeSupported('video/mp4'));
add('MediaRecorder video/webm;codecs=vp8,opus',MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'));
add('MediaRecorder video/webm',MediaRecorder.isTypeSupported('video/webm'));
add('MediaRecorder audio/webm;codecs=opus',MediaRecorder.isTypeSupported('audio/webm;codecs=opus'));
r+='<div class="warn">UA: '+navigator.userAgent+'</div>';
document.getElementById('results').innerHTML=r;

function testFamily(){
  famLog.textContent='Requesting camera+mic...';
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:{width:{ideal:320},height:{ideal:240}}}).then(function(stream){
    famStream=stream;
    var tracks=stream.getTracks();
    var info=tracks.map(function(t){return t.kind+':'+t.label+'('+t.readyState+')'}).join(', ');
    famLog.textContent='Got stream: '+tracks.length+' tracks ['+info+']';
    var codecs=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm','audio/webm;codecs=opus','audio/webm'];
    var mime='';
    for(var i=0;i<codecs.length;i++){if(MediaRecorder.isTypeSupported(codecs[i])){mime=codecs[i];break;}}
    famLog.textContent+='\\nSelected codec: '+mime;
    var opts=mime?{mimeType:mime,audioBitsPerSecond:64000,videoBitsPerSecond:300000}:{audioBitsPerSecond:64000};
    try{famRec=mime?new MediaRecorder(stream,opts):new MediaRecorder(stream);}
    catch(e){famLog.textContent+='\\nERROR creating MediaRecorder: '+e.message;return;}
    var p=location.protocol==='https:'?'wss:':'ws:';
    famWs=new WebSocket(p+'//'+location.host+'/ws?token='+TK+'&stream=family');
    famWs.binaryType='arraybuffer';
    var count=0,totalBytes=0;
    famWs.onopen=function(){famLog.textContent+='\\nWS OPEN';};
    famRec.ondataavailable=function(e){
      if(e.data.size>0){
        count++;totalBytes+=e.data.size;
        var hex=Array.from(new Uint8Array(e.data.slice(0,16))).map(function(b){return b.toString(16).padStart(2,'0')}).join(' ');
        if(count<=10||count%50===0)famLog.textContent='msg#'+count+' type='+e.data.type+' size='+e.data.size+' total='+totalBytes+' hex='+hex;
        if(famWs&&famWs.readyState===1)famWs.send(e.data);
      }
    };
    famRec.start(100);
    famWs.onclose=function(){famLog.textContent+='\\nWS CLOSED after '+count+' msgs / '+totalBytes+' bytes';};
    famWs.onerror=function(){famLog.textContent+='\\nWS ERROR';};
  }).catch(function(e){famLog.textContent='ERROR: '+e.message;});
}
function stopFamily(){
  if(famRec&&famRec.state!=='inactive')famRec.stop();
  if(famWs)famWs.close();
  if(famStream)famStream.getTracks().forEach(function(t){t.stop();});
  famLog.textContent='Disconnected';
}
</script></body></html>`)
    return
  }

  // Login
  if (url.pathname === '/login' && method === 'POST') {
    const clientIp = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const attempt = intercomLoginAttempts.get(clientIp)
    if (attempt && attempt.count >= LOGIN_RATE_LIMIT && (now - attempt.firstAttempt) < LOGIN_RATE_WINDOW) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Too many attempts' }))
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      let pw: string | undefined
      try { pw = JSON.parse(body).password } catch { pw = new URLSearchParams(body).get('password') ?? undefined }
      if (pw === PASSWORD) {
        intercomLoginAttempts.delete(clientIp)
        const token = createSession()
        log('AUTH_OK')
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `marshall_token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
        })
        res.end(JSON.stringify({ ok: true, token }))
      } else {
        const existing = intercomLoginAttempts.get(clientIp)
        intercomLoginAttempts.set(clientIp, { count: (existing?.count ?? 0) + 1, firstAttempt: existing?.firstAttempt ?? now })
        log('AUTH_FAIL')
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Wrong password' }))
      }
    })
    return
  }

  // Logout
  if (url.pathname === '/logout' && method === 'POST') {
    const tk = extractToken(req, 'token', 'marshall_token')
    sessions.delete(tk)
    log('AUTH_LOGOUT')
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'marshall_token=; HttpOnly; Path=/; Max-Age=0',
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Kiosk page
  if (url.pathname === '/kiosk') {
    if (!validateAuth(req)) { res.writeHead(302, { 'Location': '/' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(kioskPage(extractToken(req, 'token', 'marshall_token')))
    return
  }

  // ── MAX DASHBOARD ──

  // Max login
  if (url.pathname === '/max/login' && method === 'POST') {
    const clientIp = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const attempt = maxLoginAttempts.get(clientIp)
    if (attempt && attempt.count >= LOGIN_RATE_LIMIT && (now - attempt.firstAttempt) < LOGIN_RATE_WINDOW) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Too many attempts' }))
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      let pw: string | undefined
      try { pw = JSON.parse(body).password } catch { pw = new URLSearchParams(body).get('password') ?? undefined }
      if (pw === MAX_PASSWORD) {
        maxLoginAttempts.delete(clientIp)
        const token = crypto.randomBytes(32).toString('hex')
        addMaxSession(token)
        log('MAX_AUTH_OK')
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `max_token=${token}; HttpOnly; Path=/max; SameSite=Strict; Max-Age=86400`,
        })
        res.end(JSON.stringify({ ok: true, token }))
      } else {
        const existing = maxLoginAttempts.get(clientIp)
        maxLoginAttempts.set(clientIp, { count: (existing?.count ?? 0) + 1, firstAttempt: existing?.firstAttempt ?? now })
        log('MAX_AUTH_FAIL')
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Wrong password' }))
      }
    })
    return
  }

  // Max logout
  if (url.pathname === '/max/logout' && method === 'POST') {
    const tk = extractCookie(req, 'max_token')
    maxSessions.delete(tk)
    log('MAX_AUTH_LOGOUT')
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'max_token=; HttpOnly; Path=/max; Max-Age=0' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Max status (auth-protected system health)
  if (url.pathname === '/max/status') {
    if (!validateMaxAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    const tvInfo = await ecpFetch('/query/device-info').catch(() => null)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      intercom: { status: isLive ? 'live' : (dogCamProcess ? 'starting' : 'idle'), viewers: wsDogCamClients.size, familyClients: wsFamilyClients.size, kioskClients: wsKioskClients.size, ffmpeg: dogCamProcess !== null },
      tv: tvInfo ? { reachable: true, powerMode: parseXmlField(tvInfo, 'power-mode'), model: parseXmlField(tvInfo, 'model-name'), softwareVersion: parseXmlField(tvInfo, 'software-version') } : { reachable: false },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }))
    return
  }

  // ── TV ECP PROXY ──

  if (url.pathname.startsWith('/max/tv/')) {
    if (!validateMaxAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }

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
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (tvPath.match(/^\/input\/[1-4]$/) && method === 'POST') {
        const n = tvPath.slice(-1)
        await ecpPost(`/keypress/InputHDMI${n}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, input: `HDMI${n}` }))
      } else if (tvPath === '/volume/up' && method === 'POST') {
        await ecpPost('/keypress/VolumeUp')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (tvPath === '/volume/down' && method === 'POST') {
        await ecpPost('/keypress/VolumeDown')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (tvPath === '/volume/mute' && method === 'POST') {
        await ecpPost('/keypress/VolumeMute')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (tvPath.match(/^\/launch\/\d+$/) && method === 'POST') {
        const appId = tvPath.split('/').pop()!
        await ecpPost(`/launch/${appId}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, appId }))
      } else if (tvPath.match(/^\/keypress\/[\w]+$/) && method === 'POST') {
        const key = tvPath.split('/').pop()!
        await ecpPost(`/keypress/${key}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, key }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown TV command' }))
      }
    } catch (e: unknown) {
      log(`ECP_ERR: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'TV unreachable', ip: TV_IP }))
    }
    return
  }

  // ── LIVEKIT TOKEN ──

  if (url.pathname === '/livekit-token' && method === 'POST') {
    if (!validateAuth(req) && !isLocalStation(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    try {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (c: Buffer) => { data += c.toString() })
        req.on('end', () => resolve(data))
      })
      const parsed = JSON.parse(body)
      const roomName = parsed.room ?? 'marshallcam'
      const identity = parsed.identity ?? `family-${Date.now().toString(36)}`
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity })
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
      const token = await at.toJwt()
      const livekitUrl = getLiveKitUrl(req)
      const iceServers = getIceServers()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token, url: livekitUrl, iceServers }))
    } catch (e: unknown) {
      log(`LIVEKIT_TOKEN_ERR: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to generate LiveKit token' }))
    }
    return
  }

  if (url.pathname === '/max/livekit-token' && method === 'POST') {
    if (!validateMaxAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    try {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (c: Buffer) => { data += c.toString() })
        req.on('end', () => resolve(data))
      })
      const parsed = JSON.parse(body)
      const roomName = parsed.room ?? 'marshallcam'
      const identity = parsed.identity ?? `max-${Date.now().toString(36)}`
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity })
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
      const token = await at.toJwt()
      const livekitUrl = getLiveKitUrl(req)
      const iceServers = getIceServers()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token, url: livekitUrl, iceServers }))
    } catch (e: unknown) {
      log(`LIVEKIT_TOKEN_ERR: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to generate LiveKit token' }))
    }
    return
  }

  // ── OPENCODE API PROXY ──

  if (url.pathname.startsWith('/max/api/')) {
    if (!validateMaxAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }

    const apiPath = url.pathname.replace('/max/api', '')
    const apiQuery = url.search
    const targetUrl = `http://127.0.0.1:${OPENCODE_PORT}${apiPath}${apiQuery}`
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
      res.writeHead(apiRes.status, { 'Content-Type': apiRes.headers.get('content-type') ?? 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(resBody)
    } catch (e: unknown) {
      log(`OPENCODE_PROXY_ERR: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'OpenCode serve unreachable', port: OPENCODE_PORT }))
    }
    return
  }

  // ── MAX DASHBOARD PWA ──

  if (url.pathname === '/max' || url.pathname === '/max/' || url.pathname.startsWith('/max/') && !url.pathname.startsWith('/max/api/') && !url.pathname.startsWith('/max/tv/')) {
    const maxDir = path.join(PUBLIC, 'max')
    let filePath = path.join(maxDir, url.pathname.replace('/max', '') || 'index.html')
    if (!filePath.startsWith(maxDir)) { res.writeHead(403); res.end(); return }
    if (filePath.endsWith('/') || filePath === maxDir) filePath = path.join(maxDir, 'index.html')
    const isHtml = filePath.endsWith('.html')
    if (isHtml && !extractCookie(req, 'max_token') && !url.searchParams.get('max_token')) {
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
        res.end('<html><body style="background:#0c0c14;color:#00d4ff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><h1>Max Dashboard not built yet</h1></body></html>')
      }
    }
    return
  }
  if (pwaIndex) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
    res.end(pwaIndex)
  } else {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('MarshallCam PWA not built. Run: cd client && bun run build')
  }
})

// ── WEBSOCKET ───────────────────────────────────────────────

wss = new WebSocket.Server({ noServer: true })

server.on('upgrade', (req: http.IncomingMessage, socket: stream.Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const token = url.searchParams.get('token')
  const stream = (url.searchParams.get('stream') ?? 'dogcam') as StreamType
  if (!token || !sessions.has(token)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    const aws = ws as AuthedWS
    aws._stream = stream

    // ── DOG CAM ──
    if (stream === 'dogcam') {
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

    // ── FAMILY ──
    } else if (stream === 'family') {
      wsFamilyClients.add(aws)
      log(`WS+ family (${wsFamilyClients.size} total)`)
      if (!dogCamProcess) startDogCam()
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      if (!familyAudioDecoder) startFamilyAudio()

      // Notify kiosk clients that family is streaming
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
        if (familyMsgCount <= 3) {
          log(`FAM_DATA: msg#${familyMsgCount} size=${buf.length} firstBytes=${buf.slice(0, 16).toString('hex')}`, 'DEBUG')
        }
        logThrottled('fam_data', `FAM_DATA: ${familyMsgCount} msgs / ${(familyBytes / 1024).toFixed(0)}KB total`, 60000)
        if (familyAudioDecoder && familyAudioDecoder.stdin && familyAudioDecoder.stdin.writable) {
          writeFamilyAudio(buf)
        }
        // Video+Audio → Kiosk clients (so dogs can SEE family on TV)
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

    // ── KIOSK ──
    } else if (stream === 'family_kiosk') {
      aws._kiosk = true
      wsKioskClients.add(aws)
      log(`WS+ kiosk (${wsKioskClients.size} total)`)

      // Send current state
      aws.send(JSON.stringify({ type: 'viewers_changed', count: wsDogCamClients.size }))
      if (wsFamilyClients.size > 0) {
        aws.send(JSON.stringify({ type: 'family_connected' }))
      }

      let kioskBinarCount = 0
      let kioskBinaryBytes = 0
      aws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (typeof data === 'string') return
        kioskBinarCount++
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        kioskBinaryBytes += buf.length
        if (kioskBinarCount <= 3) {
          log(`KIOSK_DATA: msg#${kioskBinarCount} size=${buf.length} firstBytes=${buf.slice(0, 16).toString('hex')}`, 'DEBUG')
        }
        logThrottled('kiosk_data', `KIOSK_DATA: ${kioskBinarCount} msgs / ${(kioskBinaryBytes / 1024).toFixed(0)}KB total`, 60000)
      })

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

// ── VOLUME ──────────────────────────────────────────────────

setInterval(() => {
  require('node:child_process').exec('osascript -e "set volume output volume 100"')
}, 60_000)

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────

function gracefulShutdown(signal: string): void {
  log(`SHUTDOWN: ${signal} received, cleaning up...`)
  stopDogCam()
  stopFamilyAudio()
  if (wss) {
    for (const ws of wsDogCamClients) { try { ws.close() } catch {} }
    for (const ws of wsFamilyClients) { try { ws.close() } catch {} }
    for (const ws of wsKioskClients) { try { ws.close() } catch {} }
    wss.close()
  }
  server.close(() => {
    log('SHUTDOWN: Server closed')
    process.exit(0)
  })
  setTimeout(() => { log('SHUTDOWN: Force exit after timeout'); process.exit(1) }, 5000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// ── BOOT ─────────────────────────────────────────────────────

;(async () => {
  await createStreamInputServer()
  server.listen(PORT, '0.0.0.0', () => {
    log(`MarshallCam on http://0.0.0.0:${PORT} | Relay:${streamInputPort}`)
    log('MarshallOS: LiveKit WebRTC + Legacy WS | Max Control Surface on /max/')
  })
})()