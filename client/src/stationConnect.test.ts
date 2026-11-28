import { describe, expect, it } from 'vitest'
import {
  BACKOFF_CAP_MS,
  abortError,
  connectBackoffMs,
  createStationConnect,
  isDuplicateIdentity,
  statusFromPhase,
  type StationConnect,
  type StationConnectDeps,
  type TimerHandle,
} from './stationConnect'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function tick(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (pred()) return
    await Promise.resolve()
  }
  throw new Error(`timed out waiting for ${label}`)
}

function createHarness(overrides: Partial<StationConnectDeps> = {}) {
  let timerId = 0
  const pending = new Map<TimerHandle, { delay: number; cb: () => void }>()
  const media = deferred()
  let connectGate = deferred()
  let connectCalls = 0
  let cleanupCalls = 0
  let liveConnects = 0
  const connectStarted: number[] = []

  const schedule = (delay: number, cb: () => void): TimerHandle => {
    const handle = ++timerId
    pending.set(handle, { delay, cb })
    return handle
  }
  const cancel = (handle: TimerHandle): void => {
    pending.delete(handle)
  }

  const deps: StationConnectDeps = {
    waitForMedia: async (signal) => {
      if (signal.aborted) throw abortError()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
        media.promise.then(() => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) reject(abortError())
          else resolve()
        }, reject)
      })
    },
    connect: async ({ generation, signal }) => {
      connectCalls += 1
      liveConnects += 1
      connectStarted.push(generation)
      const gate = connectGate
      try {
        if (signal.aborted) throw abortError()
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(abortError())
          signal.addEventListener('abort', onAbort, { once: true })
          gate.promise.then(() => {
            signal.removeEventListener('abort', onAbort)
            if (signal.aborted) reject(abortError())
            else resolve()
          }, reject)
        })
      } finally {
        liveConnects -= 1
      }
    },
    cleanup: async () => {
      cleanupCalls += 1
    },
    schedule,
    cancel,
    random: () => 0.5,
    createIdentity: () => 'station-test',
    log: () => {},
    ...overrides,
  }

  const machine: StationConnect = createStationConnect(deps)

  return {
    machine,
    pending,
    media,
    get connectCalls() { return connectCalls },
    get cleanupCalls() { return cleanupCalls },
    get liveConnects() { return liveConnects },
    get connectStarted() { return connectStarted },
    resolveMedia() { media.resolve() },
    resolveConnect() {
      const current = connectGate
      connectGate = deferred()
      current.resolve()
    },
    rejectConnect(error: unknown) {
      const current = connectGate
      connectGate = deferred()
      current.reject(error)
    },
    fireTimers() {
      const cbs = [...pending.values()].map((item) => item.cb)
      pending.clear()
      for (const cb of cbs) cb()
    },
  }
}

describe('isDuplicateIdentity', () => {
  it('detects proto enum, name, and error text', () => {
    expect(isDuplicateIdentity(2)).toBe(true)
    expect(isDuplicateIdentity('DUPLICATE_IDENTITY')).toBe(true)
    expect(isDuplicateIdentity({ reason: 2 })).toBe(true)
    expect(isDuplicateIdentity(new Error('duplicate identity: station-abc'))).toBe(true)
    expect(isDuplicateIdentity(1)).toBe(false)
    expect(isDuplicateIdentity('CLIENT_INITIATED')).toBe(false)
  })
})

describe('connectBackoffMs', () => {
  it('applies jitter and caps near 60s', () => {
    expect(connectBackoffMs(0, () => 0)).toBe(1000)
    expect(connectBackoffMs(0, () => 1)).toBe(2000)
    expect(connectBackoffMs(20, () => 0)).toBe(BACKOFF_CAP_MS / 2)
    expect(connectBackoffMs(20, () => 1)).toBe(BACKOFF_CAP_MS)
    expect(connectBackoffMs(20, () => 0.5)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
  })
})

describe('statusFromPhase', () => {
  it('maps every phase', () => {
    expect(statusFromPhase('idle')).toBe('waiting')
    expect(statusFromPhase('stopped')).toBe('waiting')
    expect(statusFromPhase('waiting-media')).toBe('connecting')
    expect(statusFromPhase('connecting')).toBe('connecting')
    expect(statusFromPhase('connected')).toBe('connected')
    expect(statusFromPhase('backoff')).toBe('error')
  })
})

describe('station connect single-flight', () => {
  it('waits for a slow camera prompt before any LiveKit join, then keeps one connect in flight', async () => {
    const h = createHarness()
    h.machine.start()
    h.machine.start()
    await tick()

    expect(h.machine.snapshot().phase).toBe('waiting-media')
    expect(h.connectCalls).toBe(0)
    expect(h.machine.snapshot().activeConnects).toBe(0)
    expect(h.machine.snapshot().inFlight).toBe(true)

    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'first livekit connect')

    expect(h.connectCalls).toBe(1)
    expect(h.machine.snapshot().activeConnects).toBe(1)
    expect(h.machine.snapshot().phase).toBe('connecting')
    expect(h.cleanupCalls).toBeGreaterThanOrEqual(1)

    h.machine.handleDisconnected(0, 'disconnected')
    h.machine.handleConnectError(0, new Error('stale join'))
    h.machine.start()
    await tick()

    expect(h.connectCalls).toBe(1)
    expect(h.machine.snapshot().activeConnects).toBe(1)
    expect(h.pending.size).toBe(0)

    h.resolveConnect()
    await waitFor(() => h.machine.snapshot().phase === 'connected', 'connected')
    expect(h.machine.snapshot().activeConnects).toBe(0)
    expect(h.connectCalls).toBe(1)
  })

  it('keeps a single slow LiveKit join when disconnect and error fire together at boot', async () => {
    const h = createHarness()
    h.machine.start()
    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'slow livekit connect started')
    expect(h.machine.snapshot().activeConnects).toBe(1)

    const gen = h.machine.snapshot().generation
    h.machine.handleDisconnected(gen, 'disconnected')
    h.machine.handleConnectError(gen, new Error('ws failed'))
    await waitFor(() => h.machine.snapshot().pendingRetryTimers === 1, 'one timer after dual failure')

    expect(h.connectCalls).toBe(1)
    expect(h.machine.snapshot().activeConnects).toBe(0)
    expect(h.pending.size).toBe(1)

    h.fireTimers()
    await waitFor(() => h.connectCalls === 2, 'exactly one retry after dual failure')
    expect(h.connectCalls).toBe(2)
    expect(h.machine.snapshot().activeConnects).toBe(1)
  })

  it('treats disconnect and connect error together as one retry', async () => {
    const h = createHarness()
    h.machine.start()
    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'boot connect')
    h.resolveConnect()
    await waitFor(() => h.machine.snapshot().phase === 'connected', 'connected')

    const gen = h.machine.snapshot().generation
    h.machine.handleDisconnected(gen, 'failed')
    h.machine.handleConnectError(gen, new Error('failed'))
    await waitFor(() => h.machine.snapshot().pendingRetryTimers === 1, 'single backoff timer')

    expect(h.pending.size).toBe(1)
    expect(h.machine.snapshot().activeConnects).toBe(0)
    expect(h.connectCalls).toBe(1)

    h.fireTimers()
    await waitFor(() => h.connectCalls === 2, 'single retry connect')
    expect(h.connectCalls).toBe(2)
    expect(h.machine.snapshot().activeConnects).toBe(1)
    expect(h.pending.size).toBe(0)
  })

  it('backs off on DUPLICATE_IDENTITY instead of immediately retrying', async () => {
    const h = createHarness()
    h.machine.start()
    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'boot connect')
    h.resolveConnect()
    await waitFor(() => h.machine.snapshot().phase === 'connected', 'connected')

    const gen = h.machine.snapshot().generation
    h.machine.handleDisconnected(gen, 2)
    await waitFor(() => h.machine.snapshot().pendingRetryTimers === 1, 'duplicate backoff')

    const timer = [...h.pending.values()][0]
    expect(timer.delay).toBeGreaterThanOrEqual(8_000)
    expect(h.connectCalls).toBe(1)
    expect(h.machine.snapshot().attempt).toBeGreaterThanOrEqual(3)
  })

  it('cancels pending retries and skips connect on unload', async () => {
    const h = createHarness()
    h.machine.start()
    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'boot connect')
    h.rejectConnect(new Error('livekit down'))
    await waitFor(() => h.machine.snapshot().pendingRetryTimers === 1, 'error backoff')
    expect(h.pending.size).toBe(1)

    h.machine.stop()
    await tick()
    expect(h.pending.size).toBe(0)
    expect(h.machine.snapshot().phase).toBe('stopped')
    expect(h.machine.snapshot().activeConnects).toBe(0)

    h.fireTimers()
    await tick(20)
    expect(h.connectCalls).toBe(1)
  })

  it('does not retry while hidden after a visibility teardown', async () => {
    const h = createHarness()
    h.machine.start()
    h.resolveMedia()
    await waitFor(() => h.connectCalls === 1, 'boot connect')
    h.rejectConnect(new Error('ice failed'))
    await waitFor(() => h.pending.size === 1, 'backoff scheduled')

    h.machine.handleVisibility(true)
    await tick()
    expect(h.pending.size).toBe(0)
    expect(h.connectCalls).toBe(1)

    h.fireTimers()
    await tick(20)
    expect(h.connectCalls).toBe(1)
  })
})
