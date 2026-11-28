export type ConnectPhase =
  | 'idle'
  | 'waiting-media'
  | 'connecting'
  | 'connected'
  | 'backoff'
  | 'stopped'

export interface StationConnectSnapshot {
  phase: ConnectPhase
  generation: number
  identity: string
  inFlight: boolean
  activeConnects: number
  connectAttempts: number
  pendingRetryTimers: number
  attempt: number
}

export interface StationConnectContext {
  identity: string
  generation: number
  signal: AbortSignal
}

export type TimerHandle = number

export interface StationConnectDeps {
  waitForMedia: (signal: AbortSignal) => Promise<void>
  connect: (ctx: StationConnectContext) => Promise<void>
  cleanup: () => Promise<void> | void
  schedule: (delayMs: number, cb: () => void) => TimerHandle
  cancel: (handle: TimerHandle) => void
  random?: () => number
  createIdentity?: () => string
  onState?: (state: StationConnectSnapshot) => void
  backoffCapMs?: number
  backoffBaseMs?: number
  log?: (message: string) => void
}

export interface StationConnect {
  start(): void
  stop(): void
  handleDisconnected(generation: number, reason?: unknown): void
  handleConnectError(generation: number, error: unknown): void
  handleVisibility(hidden: boolean): void
  snapshot(): StationConnectSnapshot
}

export const BACKOFF_CAP_MS = 60_000
export const BACKOFF_BASE_MS = 2_000
export const DUPLICATE_IDENTITY_REASON = 2

export function createStationIdentity(random: () => number = Math.random): string {
  return `station-${random().toString(36).slice(2, 10)}`
}

export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

export function isDuplicateIdentity(reason: unknown): boolean {
  if (reason === DUPLICATE_IDENTITY_REASON || reason === 'DUPLICATE_IDENTITY') return true
  if (typeof reason === 'string' && /duplicate[_ ]?identity/i.test(reason)) return true
  if (reason && typeof reason === 'object') {
    const rec = reason as Record<string, unknown>
    if (isDuplicateIdentity(rec.reason)) return true
    if (isDuplicateIdentity(rec.message)) return true
    if (isDuplicateIdentity(rec.name)) return true
    if (isDuplicateIdentity(rec.code)) return true
    if ('value' in rec && isDuplicateIdentity(rec.value)) return true
  }
  return false
}

export function connectBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  capMs: number = BACKOFF_CAP_MS,
  baseMs: number = BACKOFF_BASE_MS,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 16))
  const jittered = exp * (0.5 + random() * 0.5)
  return Math.min(capMs, Math.round(jittered))
}

function assertNever(value: never): never {
  throw new Error(`unhandled connect phase: ${String(value)}`)
}

export function statusFromPhase(phase: ConnectPhase): 'waiting' | 'connecting' | 'connected' | 'error' {
  switch (phase) {
    case 'idle':
    case 'stopped':
      return 'waiting'
    case 'waiting-media':
    case 'connecting':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'backoff':
      return 'error'
    default:
      return assertNever(phase)
  }
}

export function createStationConnect(deps: StationConnectDeps): StationConnect {
  const random = deps.random ?? Math.random
  const capMs = deps.backoffCapMs ?? BACKOFF_CAP_MS
  const baseMs = deps.backoffBaseMs ?? BACKOFF_BASE_MS
  const log = deps.log ?? ((message: string) => console.log(`[MarshallCam] ${message}`))
  const identity = (deps.createIdentity ?? createStationIdentity)()

  let phase: ConnectPhase = 'idle'
  let generation = 0
  let inFlight = false
  let activeConnects = 0
  let connectAttempts = 0
  let pendingRetryTimers = 0
  let attempt = 0
  let stopped = false
  let hidden = false
  let loopActive = false
  let lastReason: unknown
  let settledGeneration = -1
  let timer: TimerHandle | null = null
  let attemptAbort: AbortController | null = null
  let retryAbort: AbortController | null = null
  let parkResolve: (() => void) | null = null
  let visibleResolve: (() => void) | null = null

  function snapshot(): StationConnectSnapshot {
    return {
      phase,
      generation,
      identity,
      inFlight,
      activeConnects,
      connectAttempts,
      pendingRetryTimers,
      attempt,
    }
  }

  function emit(): void {
    deps.onState?.(snapshot())
  }

  function setPhase(next: ConnectPhase): void {
    if (phase === next) return
    phase = next
    emit()
  }

  function cancelPending(): void {
    if (timer !== null) {
      deps.cancel(timer)
      timer = null
    }
    if (pendingRetryTimers > 0) pendingRetryTimers = 0
    retryAbort?.abort()
    retryAbort = null
  }

  function abortAttempt(): void {
    attemptAbort?.abort()
  }

  function unpark(): void {
    const resolve = parkResolve
    parkResolve = null
    resolve?.()
  }

  function wakeVisible(): void {
    const resolve = visibleResolve
    visibleResolve = null
    resolve?.()
  }

  function waitForDisconnectPark(gen: number): Promise<void> {
    if (settledGeneration === gen) return Promise.resolve()
    if (parkResolve) unpark()
    return new Promise<void>((resolve) => {
      parkResolve = resolve
    })
  }

  function waitUntilVisible(): Promise<void> {
    if (!hidden || stopped) return Promise.resolve()
    return new Promise<void>((resolve) => {
      visibleResolve = resolve
    })
  }

  function waitBackoff(delayMs: number): Promise<void> {
    cancelPending()
    if (stopped || hidden) return Promise.resolve()
    const ac = new AbortController()
    retryAbort = ac
    return new Promise<void>((resolve, reject) => {
      if (ac.signal.aborted) {
        reject(abortError())
        return
      }
      pendingRetryTimers = 1
      emit()
      const handle = deps.schedule(delayMs, () => {
        if (timer === handle) timer = null
        pendingRetryTimers = 0
        emit()
        resolve()
      })
      timer = handle
      ac.signal.addEventListener('abort', () => {
        deps.cancel(handle)
        if (timer === handle) timer = null
        pendingRetryTimers = 0
        emit()
        reject(abortError())
      }, { once: true })
    })
  }

  function settle(reason: unknown): void {
    if (stopped) return
    if (settledGeneration === generation) return
    settledGeneration = generation
    lastReason = reason
    abortAttempt()
    unpark()
  }

  function bumpAttempt(reason: unknown): void {
    if (isDuplicateIdentity(reason)) {
      attempt = Math.max(attempt + 1, 3)
      log('Station: DUPLICATE_IDENTITY — another session took over; backing off')
      return
    }
    attempt += 1
  }

  async function oneAttempt(): Promise<void> {
    generation += 1
    const gen = generation
    settledGeneration = -1
    lastReason = undefined
    inFlight = true
    emit()
    const ac = new AbortController()
    attemptAbort = ac
    try {
      setPhase('waiting-media')
      await deps.waitForMedia(ac.signal)
      if (stopped || hidden || ac.signal.aborted) throw abortError()

      await deps.cleanup()
      if (stopped || hidden || ac.signal.aborted) throw abortError()

      setPhase('connecting')
      connectAttempts += 1
      activeConnects += 1
      emit()
      try {
        await deps.connect({ identity, generation: gen, signal: ac.signal })
      } finally {
        activeConnects = Math.max(0, activeConnects - 1)
        emit()
      }
      if (stopped || hidden || ac.signal.aborted) {
        await deps.cleanup()
        throw abortError()
      }

      attempt = 0
      inFlight = false
      const parked = waitForDisconnectPark(gen)
      setPhase('connected')
      await parked
      if (stopped) return
      bumpAttempt(lastReason)
    } catch (error) {
      if (stopped) return
      if (!isAbortError(error)) settle(error)
      if (settledGeneration !== gen && lastReason === undefined) lastReason = error
      if (!stopped && !hidden) bumpAttempt(lastReason ?? error)
    } finally {
      inFlight = false
      if (attemptAbort === ac) attemptAbort = null
      emit()
    }
  }

  async function runLoop(): Promise<void> {
    loopActive = true
    try {
      while (!stopped) {
        if (hidden) {
          setPhase('idle')
          await waitUntilVisible()
          if (stopped) break
          continue
        }
        await oneAttempt()
        if (stopped) break
        if (hidden) continue
        const delay = connectBackoffMs(attempt, random, capMs, baseMs)
        setPhase('backoff')
        log(`Station: retry in ${delay}ms (attempt ${attempt})`)
        try {
          await waitBackoff(delay)
        } catch {
          // cancelled because a newer schedule, visibility, or stop() won
        }
      }
    } finally {
      loopActive = false
      if (!stopped) {
        start()
      } else {
        setPhase('stopped')
      }
    }
  }

  function start(): void {
    stopped = false
    if (loopActive) {
      wakeVisible()
      return
    }
    void runLoop()
  }

  function stop(): void {
    stopped = true
    hidden = false
    cancelPending()
    abortAttempt()
    unpark()
    wakeVisible()
    void deps.cleanup()
    setPhase('stopped')
  }

  function handleDisconnected(eventGeneration: number, reason?: unknown): void {
    if (eventGeneration !== generation) {
      log(`Station: ignoring disconnected from superseded room gen=${eventGeneration} current=${generation}`)
      return
    }
    settle(reason)
  }

  function handleConnectError(eventGeneration: number, error: unknown): void {
    if (eventGeneration !== generation) return
    settle(error)
  }

  function handleVisibility(isHidden: boolean): void {
    if (stopped) return
    hidden = isHidden
    if (isHidden) {
      cancelPending()
      if (phase !== 'connected') abortAttempt()
      return
    }
    wakeVisible()
    if (!loopActive) start()
  }

  return {
    start,
    stop,
    handleDisconnected,
    handleConnectError,
    handleVisibility,
    snapshot,
  }
}
