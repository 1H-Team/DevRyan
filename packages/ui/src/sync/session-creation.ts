import { create } from 'zustand'
import { getSafeStorage, getStoragePrincipal } from '@/stores/utils/safeStorage'
import type { AttachedFile } from '@/stores/types/sessionTypes'

export const SESSION_CREATION_DEADLINE_MS = 120_000
export const PRE_CREATION_RESTART = 'session_create_restart_rejected'
export const UNKNOWN_CREATION_OUTCOME = 'session_create_outcome_unknown'
const STORAGE_KEY = 'openchamber_session_creation_attempts'

export type CreationSnapshot = Readonly<{
  draftId: string
  directory: string | null
  text: string
  attachments?: readonly AttachedFile[]
  providerID: string
  modelID: string
  agent?: string
  variant?: string | null
  planMode: boolean
}>
export type CreationAttempt = {
  id: string
  draftId: string
  startedAt: number
  phase: 'preparing' | 'creating' | 'unknown' | 'failed' | 'created'
  sessionId?: string
  directoryHint?: string
  snapshot?: CreationSnapshot
}

export function restoredAttempts(): Record<string, CreationAttempt> {
  try {
    const value: unknown = JSON.parse(getSafeStorage().getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(value)) return {}
    return Object.fromEntries(value.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Partial<CreationAttempt>
      if (typeof entry.id !== 'string' || typeof entry.draftId !== 'string' || typeof entry.startedAt !== 'number') return []
      if (!['preparing', 'creating', 'unknown', 'failed', 'created'].includes(entry.phase || '')) return []
      const phase = entry.phase === 'preparing' ? 'failed' : entry.phase === 'creating' ? 'unknown' : entry.phase!
      return [[entry.draftId, { id: entry.id, draftId: entry.draftId, startedAt: entry.startedAt, phase,
        ...(typeof entry.directoryHint === 'string' ? { directoryHint: entry.directoryHint } : {}),
        ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}) }]]
    }))
  } catch { return {} }
}

// Narrow, low-frequency state: the shell and live sync stores don't subscribe.
export const useSessionCreationStore = create<{ attempts: Record<string, CreationAttempt> }>(() => ({ attempts: restoredAttempts() }))
let runtimePrincipal = getStoragePrincipal()

function ensureCreationPrincipal() {
  const principal = getStoragePrincipal()
  if (principal === runtimePrincipal) return
  runtimePrincipal = principal
  // Account changes reload the UI. A late response before that reload must not
  // copy the previous account's outcome markers into the new storage namespace.
  useSessionCreationStore.setState({ attempts: restoredAttempts() })
}

function persistAttempts() {
  // Prompt content and attachments remain in the existing local draft stores.
  // Only durable outcome markers are needed to prevent duplicate creates on reload.
  const markers = Object.values(useSessionCreationStore.getState().attempts).map((attempt) => ({
    id: attempt.id, draftId: attempt.draftId, phase: attempt.phase, startedAt: attempt.startedAt, sessionId: attempt.sessionId, directoryHint: attempt.directoryHint,
  }))
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(markers))
}

export function beginCreationAttempt(snapshot: CreationSnapshot): CreationAttempt {
  ensureCreationPrincipal()
  const previous = useSessionCreationStore.getState().attempts[snapshot.draftId]
  if (previous && previous.phase !== 'failed') {
    throw Object.assign(new Error('A session may already exist. Confirm “Retry as new session” before creating another.'),
      { code: UNKNOWN_CREATION_OUTCOME, retryable: false })
  }
  const attempt: CreationAttempt = { id: crypto.randomUUID(), draftId: snapshot.draftId, startedAt: Date.now(), phase: 'preparing',
    snapshot: Object.freeze({ ...snapshot, attachments: snapshot.attachments ? Object.freeze(snapshot.attachments.map((file) => Object.freeze({ ...file }))) : undefined }) }
  useSessionCreationStore.setState((state) => ({ attempts: { ...state.attempts, [attempt.draftId]: attempt } }))
  persistAttempts()
  markCreationTiming(attempt.id, 'submit')
  return attempt
}

export function updateCreationAttempt(attempt: CreationAttempt, patch: Partial<Pick<CreationAttempt, 'phase' | 'sessionId' | 'directoryHint'>>) {
  ensureCreationPrincipal()
  const current = useSessionCreationStore.getState().attempts[attempt.draftId]
  if (current?.id !== attempt.id) return // Late completion belongs only to its original attempt.
  useSessionCreationStore.setState((state) => ({ attempts: { ...state.attempts, [attempt.draftId]: { ...current, ...patch } } }))
  persistAttempts()
}

export function updateFailedCreationAttempt(attempt: CreationAttempt, error: unknown) {
  ensureCreationPrincipal()
  const current = useSessionCreationStore.getState().attempts[attempt.draftId]
  if (current?.id !== attempt.id || current.phase === 'created') return
  updateCreationAttempt(attempt, { phase: current.phase === 'creating' && isUnknownCreationError(error) ? 'unknown' : 'failed' })
}

export function forgetCreationAttempt(draftId: string, attemptId: string) {
  ensureCreationPrincipal()
  const state = useSessionCreationStore.getState()
  if (state.attempts[draftId]?.id !== attemptId) return
  const attempts = { ...state.attempts }
  delete attempts[draftId]
  useSessionCreationStore.setState({ attempts })
  persistAttempts()
}

export function isSafeCreationRestart(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === PRE_CREATION_RESTART
    && (!('retryable' in error) || error.retryable !== false))
}

export function isUnknownCreationError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const details = error as { code?: unknown; status?: unknown; retryable?: unknown }
    if (details.code === UNKNOWN_CREATION_OUTCOME) return true
    if (isSafeCreationRestart(error) || details.code === 'identity_unavailable') return false
    if (typeof details.status === 'number' && details.status >= 400 && details.status < 500) return false
    // A known nonretryable ownership rejection is a confirmed failure. Generic
    // 5xx and transport failures cannot prove the upstream create did not commit.
    if (details.retryable === false && details.code) return false
  }
  return true
}

export function waitForCreationStep<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
  })
}

export async function runSessionCreation<T>(dispatch: (signal: AbortSignal) => Promise<T>, options: {
  signal?: AbortSignal
  deadlineAt?: number
  onDispatch?: () => void
  onLateSuccess?: (value: T) => void
} = {}): Promise<T> {
  const deadlineAt = options.deadlineAt ?? Date.now() + SESSION_CREATION_DEADLINE_MS
  const deadline = new AbortController()
  const remaining = deadlineAt - Date.now()
  const timer = setTimeout(() => deadline.abort(new DOMException('Session creation deadline exceeded', 'TimeoutError')), Math.max(0, remaining))
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  let dispatched = false
  let waitingForLateResult = false
  try {
    if (remaining <= 0) throw new Error('Session creation deadline exceeded before dispatch')
    for (;;) {
      signal.throwIfAborted()
      options.onDispatch?.()
      dispatched = true
      // Local cancellation stops preparation/prompt dispatch immediately. Let
      // an already dispatched create report its authoritative late result.
      const request = dispatch(deadline.signal)
      let abandoned = false
      request.then((value) => {
        if (abandoned) { clearTimeout(timer); options.onLateSuccess?.(value) }
      }, () => { if (abandoned) clearTimeout(timer) })
      try { return await waitForCreationStep(request, signal) }
      catch (error) {
        abandoned = signal.aborted
        waitingForLateResult = abandoned
        if (!isSafeCreationRestart(error)) throw error
        dispatched = false
        await waitForCreationStep(new Promise((resolve) => setTimeout(resolve, 250)), signal)
      }
    }
  } catch (error) {
    if (dispatched && isUnknownCreationError(error)) {
      throw Object.assign(new Error('Session creation outcome is unknown. A session may already exist; your draft is retained.'),
        { code: UNKNOWN_CREATION_OUTCOME, retryable: false, cause: error })
    }
    if (!dispatched) throw Object.assign(new Error('Session creation stopped before dispatch; your draft is retained.'),
      { code: 'session_create_not_dispatched', retryable: false, cause: error })
    throw error
  } finally { if (!waitingForLateResult) clearTimeout(timer) }
}

type CreationTiming = { attemptId: string; mark: string; at: number; sessionId?: string }
const recentTimings: CreationTiming[] = []
export function markCreationTiming(attemptId: string, mark: 'submit' | 'target-prepared' | 'upstream-create' | 'acknowledged' | 'promoted' | 'prompt-accepted', sessionId?: string) {
  recentTimings.push({ attemptId, mark, at: Date.now(), ...(sessionId ? { sessionId } : {}) })
  if (recentTimings.length > 300) recentTimings.shift()
  if (typeof performance !== 'undefined') {
    const name = `devryan.session-create.${mark}`
    performance.clearMarks(name)
    performance.mark(name, { detail: { attemptId, sessionId } })
  }
}
export const getCreationTimings = (): readonly CreationTiming[] => recentTimings.slice()
