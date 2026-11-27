import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './env'

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface AppConfig {
  rootDir: string
  port: number
  stationPin: string
  adminPassword: string | null
  livekitApiKey: string
  livekitApiSecret: string
  livekitUrlLocal: string
  livekitUrlLan: string | null
  livekitUrlPublic: string | null
  publicHostnames: string[]
  serverLanIp: string | null
  tvIp: string | null
  tvEcpPort: number
  adminAiUrl: string | null
  ffmpegPath: string
  dataDir: string
  logDir: string
  sessionSecret: string
  stationTokenTtlDays: number
  sessionTtlHours: number
  iceServers: IceServer[]
  appName: string
  appTagline: string
  listenHost: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

function resolveFfmpeg(env: NodeJS.ProcessEnv): string {
  const fromEnv = optional(env, 'FFMPEG_PATH')
  if (fromEnv) return fromEnv
  const homebrew = '/opt/homebrew/bin/ffmpeg'
  try {
    if (fs.existsSync(homebrew)) return homebrew
  } catch {
    /* ignore */
  }
  return 'ffmpeg'
}

function parseIceServers(env: NodeJS.ProcessEnv): IceServer[] {
  const raw = optional(env, 'ICE_SERVERS_JSON')
  if (!raw) return DEFAULT_ICE_SERVERS
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('ICE_SERVERS_JSON must be a non-empty JSON array')
    }
    return parsed as IceServer[]
  } catch (err) {
    throw new ConfigError(`ICE_SERVERS_JSON is invalid: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseHostnames(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function resolveSessionSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = optional(env, 'SESSION_SECRET')
  if (fromEnv) return fromEnv
  ensureDir(dataDir)
  const secretFile = path.join(dataDir, 'session-secret')
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim()
    if (existing) return existing
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  const generated = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(secretFile, 0o600)
  return generated
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = []
  const rootDir = projectRoot()
  const dataDir = optional(env, 'DATA_DIR') || path.join(rootDir, 'data')
  const logDir = optional(env, 'LOG_DIR') || path.join(rootDir, 'logs')

  const stationPin = optional(env, 'STATION_PIN')
  if (!stationPin) {
    errors.push('STATION_PIN is required (4-8 digits)')
  } else if (!/^\d{4,8}$/.test(stationPin)) {
    errors.push('STATION_PIN must be 4-8 digits')
  }

  const livekitApiKey = optional(env, 'LIVEKIT_API_KEY')
  if (!livekitApiKey) errors.push('LIVEKIT_API_KEY is required')

  const livekitApiSecret = optional(env, 'LIVEKIT_API_SECRET')
  if (!livekitApiSecret) errors.push('LIVEKIT_API_SECRET is required')

  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`)
  }

  const serverLanIp = optional(env, 'SERVER_LAN_IP')
  const livekitUrlLan = optional(env, 'LIVEKIT_URL_LAN')
    || (serverLanIp ? `ws://${serverLanIp}:7880` : null)

  ensureDir(dataDir)
  ensureDir(logDir)

  return {
    rootDir,
    port: integer(env, 'PORT', 3000),
    stationPin: stationPin as string,
    adminPassword: optional(env, 'ADMIN_PASSWORD'),
    livekitApiKey: livekitApiKey as string,
    livekitApiSecret: livekitApiSecret as string,
    livekitUrlLocal: optional(env, 'LIVEKIT_URL_LOCAL') || 'ws://127.0.0.1:7880',
    livekitUrlLan,
    livekitUrlPublic: optional(env, 'LIVEKIT_URL_PUBLIC'),
    publicHostnames: parseHostnames(optional(env, 'PUBLIC_HOSTNAMES')),
    serverLanIp,
    tvIp: optional(env, 'TV_IP'),
    tvEcpPort: integer(env, 'TV_ECP_PORT', 8060),
    adminAiUrl: optional(env, 'ADMIN_AI_URL'),
    ffmpegPath: resolveFfmpeg(env),
    dataDir,
    logDir,
    sessionSecret: resolveSessionSecret(env, dataDir),
    stationTokenTtlDays: integer(env, 'STATION_TOKEN_TTL_DAYS', 3650),
    sessionTtlHours: integer(env, 'SESSION_TTL_HOURS', 720),
    iceServers: parseIceServers(env),
    appName: optional(env, 'APP_NAME') || 'MarshallCam',
    appTagline: optional(env, 'APP_TAGLINE') || 'Two-way video intercom',
    listenHost: optional(env, 'LISTEN_HOST') || '0.0.0.0',
  }
}
