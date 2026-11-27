import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { ConfigError, loadConfig } from '../src/config'

const tmpDirs: string[] = []

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'))
  tmpDirs.push(dir)
  return {
    STATION_PIN: '1234',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    DATA_DIR: path.join(dir, 'data'),
    LOG_DIR: path.join(dir, 'logs'),
    SESSION_SECRET: 'unit-test-session-secret',
    ...overrides,
  }
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(baseEnv())
    assert.equal(cfg.port, 3000)
    assert.equal(cfg.livekitUrlLocal, 'ws://127.0.0.1:7880')
    assert.equal(cfg.appName, 'MarshallCam')
    assert.equal(cfg.appTagline, 'Two-way video intercom')
    assert.equal(cfg.stationTokenTtlDays, 3650)
    assert.equal(cfg.sessionTtlHours, 720)
    assert.equal(cfg.adminPassword, null)
    assert.equal(cfg.tvIp, null)
    assert.ok(cfg.iceServers.length >= 1)
  })

  it('derives LIVEKIT_URL_LAN from SERVER_LAN_IP', () => {
    const cfg = loadConfig(baseEnv({ SERVER_LAN_IP: '192.168.1.50' }))
    assert.equal(cfg.livekitUrlLan, 'ws://192.168.1.50:7880')
  })

  it('errors clearly when required vars are missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'))
    tmpDirs.push(dir)
    assert.throws(
      () => loadConfig({ DATA_DIR: path.join(dir, 'data'), LOG_DIR: path.join(dir, 'logs') }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /STATION_PIN/)
        assert.match(err.message, /LIVEKIT_API_KEY/)
        assert.match(err.message, /LIVEKIT_API_SECRET/)
        return true
      },
    )
  })

  it('rejects a non-numeric PIN', () => {
    assert.throws(
      () => loadConfig(baseEnv({ STATION_PIN: 'abcd' })),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /STATION_PIN/)
        return true
      },
    )
  })

  it('persists a generated SESSION_SECRET', () => {
    const env = baseEnv({ SESSION_SECRET: undefined })
    delete env.SESSION_SECRET
    const cfg = loadConfig(env)
    assert.equal(cfg.sessionSecret.length, 64)
    const secretFile = path.join(cfg.dataDir, 'session-secret')
    const mode = fs.statSync(secretFile).mode & 0o777
    assert.equal(mode, 0o600)
    const again = loadConfig(env)
    assert.equal(again.sessionSecret, cfg.sessionSecret)
  })
})
