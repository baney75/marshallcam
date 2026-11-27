import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { loadConfig } from '../src/config'
import { startMarshallCam, type MarshallCamHandle } from '../src/MarshallCamServer'

const tmpDirs: string[] = []
const handles: MarshallCamHandle[] = []

after(async () => {
  for (const h of handles.splice(0)) {
    try { await h.close() } catch { /* noop */ }
  }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    STATION_PIN: '2468',
    ADMIN_PASSWORD: 'admin-test',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret-for-tests-only',
    DATA_DIR: path.join(dir, 'data'),
    LOG_DIR: path.join(dir, 'logs'),
    SESSION_SECRET: 'integration-session-secret-32bytes!!',
    PORT: '0',
    LISTEN_HOST: '127.0.0.1',
  }
}

async function boot(): Promise<MarshallCamHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-int-'))
  tmpDirs.push(dir)
  const config = loadConfig(testEnv(dir))
  const handle = await startMarshallCam({ config, loadDotEnv: false })
  handles.push(handle)
  return handle
}

describe('server integration', () => {
  it('keeps a PIN login token valid across restart', async () => {
    const first = await boot()
    const login = await fetch(`http://127.0.0.1:${first.port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '2468' }),
    })
    assert.equal(login.status, 200)
    const body = await login.json() as { ok: boolean; token: string }
    assert.equal(body.ok, true)
    assert.ok(body.token)

    const before = await fetch(`http://127.0.0.1:${first.port}/status?token=${encodeURIComponent(body.token)}`)
    assert.equal(before.status, 200)

    const savedConfig = first.config
    await first.close()
    handles.splice(handles.indexOf(first), 1)

    const second = await startMarshallCam({ config: savedConfig, loadDotEnv: false })
    handles.push(second)
    const after = await fetch(`http://127.0.0.1:${second.port}/status?token=${encodeURIComponent(body.token)}`)
    assert.equal(after.status, 200)
    await second.close()
    handles.splice(handles.indexOf(second), 1)
  })

  it('issues a station session on loopback and rejects proxied requests', async () => {
    const handle = await boot()
    const ok = await fetch(`http://127.0.0.1:${handle.port}/station/session`, { method: 'POST' })
    assert.equal(ok.status, 200)
    const data = await ok.json() as { ok: boolean; token: string }
    assert.equal(data.ok, true)
    assert.ok(data.token)

    const proxied = await fetch(`http://127.0.0.1:${handle.port}/station/session`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    })
    assert.equal(proxied.status, 403)

    const healthz = await fetch(`http://127.0.0.1:${handle.port}/healthz`)
    assert.equal(healthz.status, 200)
    const hz = await healthz.json() as { ok: boolean; uptime: number }
    assert.equal(hz.ok, true)
    assert.equal(typeof hz.uptime, 'number')
  })
})
