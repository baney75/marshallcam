import { describe, expect, it } from 'vitest'
import {
  bootstrapAuth,
  detectRole,
  nextBackoffMs,
  shouldClearToken,
  type FetchLike,
  type TokenStore,
} from './authBootstrap'

function memoryStore(initial = ''): TokenStore & { value: string } {
  const store = {
    value: initial,
    get() { return store.value },
    set(token: string) { store.value = token },
    clear() { store.value = '' },
  }
  return store
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('detectRole', () => {
  it('uses explicit role and localhost', () => {
    expect(detectRole('?role=station', 'phone.example.com')).toBe('station')
    expect(detectRole('?role=remote', 'localhost')).toBe('remote')
    expect(detectRole('', 'localhost')).toBe('station')
    expect(detectRole('', '127.0.0.1')).toBe('station')
  })

  it('keeps private-range heuristic only behind ?role=', () => {
    expect(detectRole('', '192.168.1.20')).toBe('remote')
    expect(detectRole('?role=', '192.168.1.20')).toBe('station')
    expect(detectRole('', '10.0.0.8')).toBe('remote')
  })
})

describe('token discard rules', () => {
  it('clears only on 401/403', () => {
    expect(shouldClearToken(401)).toBe(true)
    expect(shouldClearToken(403)).toBe(true)
    expect(shouldClearToken(500)).toBe(false)
    expect(shouldClearToken(200)).toBe(false)
  })

  it('backs off up to 10s', () => {
    expect(nextBackoffMs(0)).toBe(1000)
    expect(nextBackoffMs(1000)).toBe(2000)
    expect(nextBackoffMs(8000)).toBe(10000)
    expect(nextBackoffMs(10000)).toBe(10000)
  })
})

describe('bootstrapAuth', () => {
  it('keeps the token when a network error is followed by success', async () => {
    const store = memoryStore('saved-token')
    let statusCalls = 0
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') return jsonResponse(200, { ok: true, uptime: 1 })
      if (url.startsWith('/status')) {
        statusCalls += 1
        if (statusCalls === 1) throw new Error('network down')
        return jsonResponse(200, { status: 'idle' })
      }
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'remote',
      storedToken: 'saved-token',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result).toEqual({ status: 'authed', token: 'saved-token' })
    expect(store.get()).toBe('saved-token')
  })

  it('retries 5xx without clearing the token', async () => {
    const store = memoryStore('saved-token')
    let statusCalls = 0
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') return jsonResponse(200, { ok: true, uptime: 1 })
      if (url.startsWith('/status')) {
        statusCalls += 1
        if (statusCalls < 3) return jsonResponse(503, { error: 'busy' })
        return jsonResponse(200, { status: 'idle' })
      }
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'remote',
      storedToken: 'saved-token',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result.status).toBe('authed')
    expect(store.get()).toBe('saved-token')
    expect(statusCalls).toBe(3)
  })

  it('clears the token on 401', async () => {
    const store = memoryStore('bad-token')
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') return jsonResponse(200, { ok: true, uptime: 1 })
      if (url.startsWith('/status')) return jsonResponse(401, { error: 'Unauthorized' })
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'remote',
      storedToken: 'bad-token',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result.status).toBe('pin')
    expect(store.get()).toBe('')
  })

  it('auto-provisions a station with no token', async () => {
    const store = memoryStore('')
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') return jsonResponse(200, { ok: true, uptime: 1 })
      if (url === '/station/session') return jsonResponse(200, { ok: true, token: 'station-token' })
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'station',
      storedToken: '',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result).toEqual({ status: 'authed', token: 'station-token' })
    expect(store.get()).toBe('station-token')
  })

  it('shows PIN for a remote with no token', async () => {
    const store = memoryStore('')
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') return jsonResponse(200, { ok: true, uptime: 1 })
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'remote',
      storedToken: '',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result.status).toBe('pin')
  })

  it('waits out a boot race then auths the station without PIN', async () => {
    const store = memoryStore('boot-token')
    let healthCalls = 0
    const fetchFn: FetchLike = async (input) => {
      const url = String(input)
      if (url === '/healthz') {
        healthCalls += 1
        if (healthCalls < 3) throw new Error('ECONNREFUSED')
        return jsonResponse(200, { ok: true, uptime: 0.2 })
      }
      if (url.startsWith('/status')) return jsonResponse(200, { status: 'idle' })
      throw new Error(`unexpected ${url}`)
    }
    const result = await bootstrapAuth({
      role: 'station',
      storedToken: 'boot-token',
      fetch: fetchFn,
      store,
      sleep: async () => {},
    })
    expect(result.status).toBe('authed')
    expect(store.get()).toBe('boot-token')
    expect(healthCalls).toBe(3)
  })
})
