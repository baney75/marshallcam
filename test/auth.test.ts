import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  issueToken,
  isLocalStation,
  RevocationStore,
  signToken,
  verifyToken,
  type TokenPayload,
} from '../src/auth'

const secret = 'test-session-secret-not-for-production'
const tmpDirs: string[] = []

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

function fakeReq(opts: { remoteAddress?: string; headers?: http.IncomingHttpHeaders }): http.IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: opts.headers ?? { host: 'localhost:3000' },
  } as http.IncomingMessage
}

describe('auth tokens', () => {
  it('signs and verifies a user token', () => {
    const { token, payload } = issueToken(secret, 'user', 3600)
    const verified = verifyToken(secret, token)
    assert.ok(verified)
    assert.equal(verified.kind, 'user')
    assert.equal(verified.jti, payload.jti)
    assert.equal(verified.v, 1)
  })

  it('issues a long-lived station token', () => {
    const ttl = 3650 * 24 * 60 * 60
    const { token, payload } = issueToken(secret, 'station', ttl)
    const verified = verifyToken(secret, token)
    assert.ok(verified)
    assert.equal(verified.kind, 'station')
    assert.ok(payload.exp - payload.iat >= ttl - 1)
  })

  it('rejects a tampered payload', () => {
    const { token } = issueToken(secret, 'user', 3600)
    const [encoded, sig] = token.split('.')
    assert.ok(encoded && sig)
    const raw = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as TokenPayload
    parsed.kind = 'admin'
    const tampered = `${Buffer.from(JSON.stringify(parsed)).toString('base64url')}.${sig}`
    assert.equal(verifyToken(secret, tampered), null)
  })

  it('rejects a tampered signature', () => {
    const { token } = issueToken(secret, 'user', 3600)
    const [encoded] = token.split('.')
    assert.ok(encoded)
    assert.equal(verifyToken(secret, `${encoded}.aaaaaaaa`), null)
  })

  it('rejects an expired token', () => {
    const payload: TokenPayload = {
      v: 1,
      kind: 'user',
      iat: 1_700_000_000,
      exp: 1_700_000_100,
      jti: 'expired-jti',
    }
    const token = signToken(secret, payload)
    assert.equal(verifyToken(secret, token, 1_700_000_101_000), null)
    assert.ok(verifyToken(secret, token, 1_700_000_050_000))
  })

  it('persists revocation and prunes expired entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-revoke-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'revoked.json')
    const store = new RevocationStore(file)
    store.load()
    store.revoke('live-jti', Math.floor(Date.now() / 1000) + 3600)
    store.revoke('old-jti', Math.floor(Date.now() / 1000) - 10)
    assert.equal(store.isRevoked('live-jti'), true)
    store.prune()
    assert.equal(store.isRevoked('old-jti'), false)
    assert.equal(store.isRevoked('live-jti'), true)

    const reloaded = new RevocationStore(file)
    reloaded.load()
    assert.equal(reloaded.isRevoked('live-jti'), true)
    assert.equal(reloaded.isRevoked('old-jti'), false)
  })
})

describe('isLocalStation', () => {
  it('trusts loopback to localhost without proxy headers', () => {
    assert.equal(isLocalStation(fakeReq({ remoteAddress: '127.0.0.1', headers: { host: 'localhost:3000' } })), true)
    assert.equal(isLocalStation(fakeReq({ remoteAddress: '::1', headers: { host: '127.0.0.1:3000' } })), true)
    assert.equal(isLocalStation(fakeReq({ remoteAddress: '::ffff:127.0.0.1', headers: { host: 'localhost' } })), true)
  })

  it('rejects proxy headers even from loopback', () => {
    assert.equal(isLocalStation(fakeReq({
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:3000', 'x-forwarded-for': '1.2.3.4' },
    })), false)
    assert.equal(isLocalStation(fakeReq({
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:3000', 'cf-connecting-ip': '1.2.3.4' },
    })), false)
  })

  it('rejects non-loopback remotes and public Host headers', () => {
    assert.equal(isLocalStation(fakeReq({
      remoteAddress: '192.168.1.20',
      headers: { host: 'localhost:3000' },
    })), false)
    assert.equal(isLocalStation(fakeReq({
      remoteAddress: '127.0.0.1',
      headers: { host: 'cam.example.com' },
    })), false)
  })
})
