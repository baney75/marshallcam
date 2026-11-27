import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export type TokenKind = 'user' | 'station' | 'admin'

export interface TokenPayload {
  v: 1
  kind: TokenKind
  iat: number
  exp: number
  jti: string
}

function isTokenKind(value: unknown): value is TokenKind {
  return value === 'user' || value === 'station' || value === 'admin'
}

export function assertNever(value: never, message = 'unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`)
}

export function kindTtlSeconds(kind: TokenKind, sessionTtlHours: number, stationTtlDays: number): number {
  switch (kind) {
    case 'user':
    case 'admin':
      return sessionTtlHours * 60 * 60
    case 'station':
      return stationTtlDays * 24 * 60 * 60
    default:
      return assertNever(kind)
  }
}

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return buf.toString('base64url')
}

function hmac(secret: string, payload: string): Buffer {
  return crypto.createHmac('sha256', secret).update(payload).digest()
}

export function signToken(secret: string, payload: TokenPayload): string {
  const encoded = base64url(JSON.stringify(payload))
  const signature = base64url(hmac(secret, encoded))
  return `${encoded}.${signature}`
}

export function issueToken(
  secret: string,
  kind: TokenKind,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): { token: string; payload: TokenPayload } {
  if (!isTokenKind(kind)) assertNever(kind as never)
  const iat = Math.floor(nowMs / 1000)
  const payload: TokenPayload = {
    v: 1,
    kind,
    iat,
    exp: iat + ttlSeconds,
    jti: crypto.randomBytes(16).toString('hex'),
  }
  return { token: signToken(secret, payload), payload }
}

export function verifyToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): TokenPayload | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null
  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!encoded || !signature) return null

  let expected: Buffer
  let actual: Buffer
  try {
    expected = hmac(secret, encoded)
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length) return null
  if (!crypto.timingSafeEqual(actual, expected)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const body = parsed as Partial<TokenPayload>
  if (body.v !== 1) return null
  if (!isTokenKind(body.kind)) return null
  if (typeof body.iat !== 'number' || typeof body.exp !== 'number' || typeof body.jti !== 'string') return null
  if (!body.jti) return null
  if (body.exp * 1000 <= nowMs) return null
  return {
    v: 1,
    kind: body.kind,
    iat: body.iat,
    exp: body.exp,
    jti: body.jti,
  }
}

interface RevokedEntry {
  jti: string
  exp: number
}

export class RevocationStore {
  private entries: RevokedEntry[] = []

  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) {
        this.entries = []
        return
      }
      this.entries = parsed.filter((row): row is RevokedEntry => {
        return !!row && typeof row === 'object'
          && typeof (row as RevokedEntry).jti === 'string'
          && typeof (row as RevokedEntry).exp === 'number'
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
      this.entries = []
    }
    this.prune()
  }

  revoke(jti: string, exp: number): void {
    if (!jti) return
    if (this.entries.some((e) => e.jti === jti)) return
    this.entries.push({ jti, exp })
    this.persist()
  }

  isRevoked(jti: string): boolean {
    return this.entries.some((e) => e.jti === jti)
  }

  prune(nowMs: number = Date.now()): void {
    const nowSec = Math.floor(nowMs / 1000)
    const next = this.entries.filter((e) => e.exp > nowSec)
    if (next.length !== this.entries.length) {
      this.entries = next
      this.persist()
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.entries), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
    try { fs.chmodSync(this.filePath, 0o600) } catch { /* noop */ }
  }
}

const PROXY_HEADERS = [
  'x-forwarded-for',
  'cf-connecting-ip',
  'cf-ray',
  'x-real-ip',
  'forwarded',
] as const

export function isLocalStation(req: http.IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || ''
  if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') return false
  const headers = req.headers
  for (const name of PROXY_HEADERS) {
    if (headers[name]) return false
  }
  const host = String(headers.host || '').toLowerCase().replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1'
}

export function extractCookie(req: http.IncomingMessage, name: string): string {
  const cookie = req.headers.cookie ?? ''
  const parts = cookie.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return ''
}

export function extractToken(req: http.IncomingMessage, param: string, cookie: string): string {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
  return url.searchParams.get(param) || extractCookie(req, cookie)
}
