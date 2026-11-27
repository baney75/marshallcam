export type Role = 'remote' | 'station'

export interface TokenStore {
  get(): string
  set(token: string): void
  clear(): void
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export type SleepFn = (ms: number) => Promise<void>

export type BootstrapStatus = 'connecting' | 'authed' | 'pin'

export interface BootstrapResult {
  status: 'authed' | 'pin'
  token: string
}

export interface BootstrapOptions {
  role: Role
  storedToken: string
  fetch: FetchLike
  store: TokenStore
  sleep?: SleepFn
  now?: () => number
  remoteHealthBudgetMs?: number
  onStatus?: (status: BootstrapStatus) => void
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function detectRole(
  search: string = typeof location !== 'undefined' ? location.search : '',
  hostname: string = typeof location !== 'undefined' ? location.hostname : '',
): Role {
  const params = new URLSearchParams(search)
  const explicit = params.get('role')
  if (explicit === 'station') return 'station'
  if (explicit === 'remote') return 'remote'
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'station'
  if (params.has('role')) {
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) {
      return 'station'
    }
  }
  return 'remote'
}

export function nextBackoffMs(previous: number): number {
  if (previous <= 0) return 1000
  return Math.min(previous * 2, 10_000)
}

export function shouldClearToken(status: number): boolean {
  return status === 401 || status === 403
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 0
}

async function getJson(fetchFn: FetchLike, url: string, init?: RequestInit): Promise<{
  ok: boolean
  status: number
  data: Record<string, unknown> | null
  networkError: boolean
}> {
  try {
    const res = await fetchFn(url, init)
    let data: Record<string, unknown> | null = null
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
    } catch {
      data = null
    }
    return { ok: res.ok, status: res.status, data, networkError: false }
  } catch {
    return { ok: false, status: 0, data: null, networkError: true }
  }
}

export async function waitForHealthz(options: {
  fetch: FetchLike
  sleep?: SleepFn
  now?: () => number
  indefinitely: boolean
  budgetMs?: number
}): Promise<boolean> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const started = now()
  let delay = 0
  for (;;) {
    const res = await getJson(options.fetch, '/healthz')
    if (res.ok && res.data && res.data.ok === true) return true
    if (!options.indefinitely) {
      const elapsed = now() - started
      if (elapsed >= (options.budgetMs ?? 60_000)) return false
    }
    delay = nextBackoffMs(delay)
    await sleep(delay)
  }
}

export async function provisionStationSession(fetchFn: FetchLike, store: TokenStore): Promise<string | null> {
  const res = await getJson(fetchFn, '/station/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (res.ok && typeof res.data?.token === 'string' && res.data.token) {
    store.set(res.data.token)
    return res.data.token
  }
  if (shouldClearToken(res.status)) return null
  if (res.networkError || isRetryableStatus(res.status)) {
    throw new Error('station-session-retry')
  }
  return null
}

export async function validateStoredToken(
  fetchFn: FetchLike,
  token: string,
): Promise<'valid' | 'invalid' | 'retry'> {
  const res = await getJson(fetchFn, `/status?token=${encodeURIComponent(token)}`, {
    credentials: 'include',
  })
  if (res.ok) return 'valid'
  if (shouldClearToken(res.status)) return 'invalid'
  return 'retry'
}

export async function bootstrapAuth(options: BootstrapOptions): Promise<BootstrapResult> {
  const sleep = options.sleep ?? defaultSleep
  const onStatus = options.onStatus ?? (() => {})
  onStatus('connecting')

  const healthy = await waitForHealthz({
    fetch: options.fetch,
    sleep,
    now: options.now,
    indefinitely: options.role === 'station',
    budgetMs: options.remoteHealthBudgetMs ?? 60_000,
  })
  if (!healthy) {
    onStatus('pin')
    return { status: 'pin', token: '' }
  }

  let token = options.storedToken
  let delay = 0

  while (token) {
    const result = await validateStoredToken(options.fetch, token)
    if (result === 'valid') {
      options.store.set(token)
      onStatus('authed')
      return { status: 'authed', token }
    }
    if (result === 'invalid') {
      options.store.clear()
      token = ''
      break
    }
    delay = nextBackoffMs(delay)
    await sleep(delay)
  }

  if (options.role === 'station') {
    delay = 0
    for (;;) {
      try {
        const provisioned = await provisionStationSession(options.fetch, options.store)
        if (provisioned) {
          onStatus('authed')
          return { status: 'authed', token: provisioned }
        }
        onStatus('pin')
        return { status: 'pin', token: '' }
      } catch {
        delay = nextBackoffMs(delay)
        await sleep(delay)
      }
    }
  }

  onStatus('pin')
  return { status: 'pin', token: '' }
}

export async function recoverStationToken(
  fetchFn: FetchLike,
  store: TokenStore,
): Promise<string | null> {
  try {
    return await provisionStationSession(fetchFn, store)
  } catch {
    return null
  }
}

export const localStorageTokenStore: TokenStore = {
  get() {
    try { return localStorage.getItem('mc_token') || '' } catch { return '' }
  },
  set(token: string) {
    try { localStorage.setItem('mc_token', token) } catch { /* noop */ }
  },
  clear() {
    try { localStorage.removeItem('mc_token') } catch { /* noop */ }
  },
}
