import { beforeEach, describe, expect, test } from 'bun:test'
import { getStoragePrincipal, setStoragePrincipal } from '@/stores/utils/safeStorage'
import { beginCreationAttempt, forgetCreationAttempt, getCreationTimings, isSafeCreationRestart, PRE_CREATION_RESTART,
  restoredAttempts, runSessionCreation, UNKNOWN_CREATION_OUTCOME, updateCreationAttempt,
  updateFailedCreationAttempt, useSessionCreationStore, waitForCreationStep } from './session-creation'

const snapshot = { draftId: 'draft-test', directory: '/synthetic', text: 'private draft text', providerID: 'provider', modelID: 'model', planMode: true }
beforeEach(() => { useSessionCreationStore.setState({ attempts: {} }) })

describe('single session creation attempt', () => {
  test('late completion after an account change cannot copy private markers across accounts', () => {
    const originalPrincipal = getStoragePrincipal()
    try {
      setStoragePrincipal('creation-account-a')
      const attempt = beginCreationAttempt({ ...snapshot, draftId: crypto.randomUUID() })
      updateCreationAttempt(attempt, { phase: 'creating' })
      setStoragePrincipal('creation-account-b')
      updateCreationAttempt(attempt, { phase: 'created', sessionId: 'ses_account_a' })
      expect(useSessionCreationStore.getState().attempts[attempt.draftId]).toBeUndefined()
      expect(restoredAttempts()[attempt.draftId]).toBeUndefined()
      setStoragePrincipal('creation-account-a')
      expect(restoredAttempts()[attempt.draftId]).toMatchObject({ id: attempt.id, phase: 'unknown' })
      forgetCreationAttempt(attempt.draftId, attempt.id)
    } finally {
      setStoragePrincipal(originalPrincipal)
    }
  })
  test('never retries ambiguous transport failures, resets, timeouts, or generic 5xx', async () => {
    for (const error of [new Error('Failed to fetch'), new Error('ECONNRESET'), new DOMException('Timed out', 'TimeoutError'),
      Object.assign(new Error('gateway failure'), { status: 502, retryable: true }), new Error('OpenCode is restarting')]) {
      let calls = 0
      await expect(runSessionCreation(async () => { calls++; throw error })).rejects.toMatchObject({ code: UNKNOWN_CREATION_OUTCOME, retryable: false })
      expect(calls).toBe(1)
    }
  })
  test('only an explicit pre-creation restart rejection permits another dispatch', async () => {
    let calls = 0
    expect(isSafeCreationRestart({ code: PRE_CREATION_RESTART, retryable: false })).toBe(false)
    const result = await runSessionCreation(async () => {
      if (++calls === 1) throw { code: PRE_CREATION_RESTART, retryable: true }
      return 'ses_created'
    })
    expect(result).toBe('ses_created')
    expect(calls).toBe(2)
  })
  test('readiness retries share one overall deadline', async () => {
    let calls = 0
    const start = Date.now()
    await expect(runSessionCreation(async () => { calls++; throw { code: PRE_CREATION_RESTART } },
      { deadlineAt: start + 40 })).rejects.toMatchObject({ code: 'session_create_not_dispatched' })
    expect(Date.now() - start).toBeLessThan(200)
    expect(calls).toBe(1)
  })
  test('ownership failures and revoked access are confirmed failures without retries', async () => {
    for (const error of [{ code: 'identity_unavailable', retryable: false, status: 503 }, { status: 403 }]) {
      let calls = 0
      await expect(runSessionCreation(async () => { calls++; throw error })).rejects.toMatchObject(error)
      expect(calls).toBe(1)
    }
  })
  test('cancelling before dispatch never calls upstream', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(runSessionCreation(async () => { calls++; return 'ses_bad' }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'session_create_not_dispatched' })
    expect(calls).toBe(0)
  })
  test('cancel returns immediately, retains late identity, and never dispatches twice', async () => {
    const controller = new AbortController()
    let complete!: (value: string) => void
    let late: string | null = null
    let calls = 0
    const creation = runSessionCreation(() => { calls++; return new Promise<string>((resolve) => { complete = resolve }) },
      { signal: controller.signal, onLateSuccess: (value) => { late = value } })
    controller.abort()
    await expect(creation).rejects.toMatchObject({ code: UNKNOWN_CREATION_OUTCOME })
    complete('ses_late')
    await Promise.resolve()
    expect(late).toBe('ses_late')
    expect(calls).toBe(1)
  })
  test('preparation can be cancelled while its underlying work remains pending', async () => {
    const controller = new AbortController()
    const wait = waitForCreationStep(new Promise(() => {}), controller.signal)
    controller.abort()
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' })
  })
  test('reload preserves unknown outcomes without persisting prompt content or attachments in markers', () => {
    const attempt = beginCreationAttempt(snapshot)
    updateCreationAttempt(attempt, { phase: 'creating' })
    expect(restoredAttempts()[snapshot.draftId]).toMatchObject({ id: attempt.id, phase: 'unknown' })
    expect(JSON.stringify(restoredAttempts())).not.toContain(snapshot.text)
    expect(() => beginCreationAttempt(snapshot)).toThrow('Retry as new session')
    forgetCreationAttempt(attempt.draftId, attempt.id)
    expect(beginCreationAttempt(snapshot).id).not.toBe(attempt.id)
  })
  test('late results cannot overwrite a newer attempt; captured selection stays immutable', () => {
    const input = { ...snapshot }
    const first = beginCreationAttempt(input)
    input.modelID = 'different-model'
    expect(first.snapshot?.modelID).toBe('model')
    forgetCreationAttempt(first.draftId, first.id)
    const second = beginCreationAttempt(snapshot)
    updateCreationAttempt(first, { phase: 'created', sessionId: 'ses_old' })
    updateFailedCreationAttempt(first, new Error('old timeout'))
    expect(useSessionCreationStore.getState().attempts[snapshot.draftId].id).toBe(second.id)
    expect(useSessionCreationStore.getState().attempts[snapshot.draftId].sessionId).toBeUndefined()
    expect(JSON.stringify(getCreationTimings())).not.toContain(snapshot.text)
  })
})
