import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { SessionTreeChanges } from '@/lib/opencode/client'
import { sessionEvents } from '@/lib/sessionEvents'
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession'
import {
  clearDirectorySessionTreeChanges,
  clearSessionTreeChanges,
  getSessionTreeChangesKey,
  observeSessionTreeActivity,
  refreshSessionTreeChanges,
  requestSessionTreeChangesRefresh,
  resetSessionTreeChangesForTests,
  setSessionTreeChangesDebounceForTests,
  setSessionTreeChangesFetcher,
  subscribeSessionTreeChanges,
  useSessionTreeChangesStore,
} from './useSessionTreeChangesStore'

const DEBOUNCE_MS = 20

const makeChanges = (overrides: Partial<SessionTreeChanges> = {}): SessionTreeChanges => ({
  files: [],
  sessionCount: 0,
  hasUnattributedMutations: false,
  firstUserMessageID: null,
  rootSessionID: 'ses_root',
  ...overrides,
})

const file = (path: string) => ({ path, status: 'modified' as const, additions: 1, deletions: 0, sessions: ['ses_root'] })

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Deferred = { promise: Promise<SessionTreeChanges>; resolve: (value: SessionTreeChanges) => void; reject: (error: unknown) => void }
const createDeferred = (): Deferred => {
  let resolve!: (value: SessionTreeChanges) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<SessionTreeChanges>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useSessionTreeChangesStore', () => {
  const calls: Array<{ rootSessionID: string; directory: string }> = []
  let respond: (rootSessionID: string, directory: string) => Promise<SessionTreeChanges> = () => Promise.resolve(makeChanges())

  beforeEach(() => {
    resetSessionTreeChangesForTests()
    setSessionTreeChangesDebounceForTests(DEBOUNCE_MS)
    calls.length = 0
    respond = () => Promise.resolve(makeChanges())
    setSessionTreeChangesFetcher((rootSessionID, directory) => {
      calls.push({ rootSessionID, directory })
      return respond(rootSessionID, directory)
    })
  })

  afterEach(() => {
    resetSessionTreeChangesForTests()
    setSessionTreeChangesFetcher(null)
    setSessionTreeChangesDebounceForTests(null)
  })

  test('keys entries by normalized directory and root session id', () => {
    expect(JSON.parse(getSessionTreeChangesKey('/repo/', 'ses_1')).slice(2)).toEqual(['/repo', 'ses_1'])
    expect(JSON.parse(getSessionTreeChangesKey('C:\\repo\\', 'ses_1')).slice(2)).toEqual(['C:/repo', 'ses_1'])
    expect(getSessionTreeChangesKey('/repo', 'ses_1')).toBe(getSessionTreeChangesKey('/repo//', 'ses_1'))
  })

  test('rejects a response naming another independent session', async () => {
    respond = () => Promise.resolve(makeChanges({ rootSessionID: 'ses_other', files: [file('other.ts')] }))
    await refreshSessionTreeChanges('/repo', 'ses_root')
    const entry = useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))
    expect(entry?.files).toEqual([])
    expect(entry?.error).toContain('identity mismatch')
  })

  test('rejects a response from another worktree with the same session id', async () => {
    respond = () => Promise.resolve(makeChanges({ directory: '/other-worktree', files: [file('other.ts')] }))
    await refreshSessionTreeChanges('/repo', 'ses_root')
    const entry = useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))
    expect(entry?.files).toEqual([])
    expect(entry?.error).toContain('directory mismatch')
  })

  test('switching worktrees drops a released request even after returning to the same task', async () => {
    const previous = createDeferred()
    respond = () => previous.promise
    const release = subscribeSessionTreeChanges('/repo', 'ses_root')
    release()
    respond = () => Promise.resolve(makeChanges({ revision: 'current', files: [file('current.ts')] }))
    const releaseCurrent = subscribeSessionTreeChanges('/repo', 'ses_root')
    await wait(0)
    previous.resolve(makeChanges({ revision: 'old', files: [file('old.ts')] }))
    await wait(0)
    expect(useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))?.revision).toBe('current')
    releaseCurrent()
  })

  test('late responses cannot resurrect a deleted session', async () => {
    const deferred = createDeferred()
    respond = () => deferred.promise
    const request = refreshSessionTreeChanges('/repo', 'ses_root')
    clearSessionTreeChanges('/repo', 'ses_root')
    deferred.resolve(makeChanges({ files: [file('deleted.ts')] }))
    await request
    expect(useSessionTreeChangesStore.getState().entries.size).toBe(0)
  })

  test('changing account clears cached files and rejects old in-flight responses', async () => {
    const principal = getAuthPrincipal()
    const deferred = createDeferred()
    respond = () => deferred.promise
    const previousKey = getSessionTreeChangesKey('/repo', 'ses_root')
    const request = refreshSessionTreeChanges('/repo', 'ses_root')
    try {
      setAuthPrincipal({ ...principal, id: 'different-account' })
      expect(getSessionTreeChangesKey('/repo', 'ses_root')).not.toBe(previousKey)
      deferred.resolve(makeChanges({ files: [file('private.ts')] }))
      await request
      expect(useSessionTreeChangesStore.getState().entries.size).toBe(0)
    } finally { setAuthPrincipal(principal) }
  })

  test('repository polling does not re-fetch captured history; capture notifications do', async () => {
    respond = () => Promise.resolve(makeChanges({ revision: 'revision', coverage: 'complete' }))
    const unsubscribe = subscribeSessionTreeChanges('/repo', 'ses_root')
    await wait(0)
    calls.length = 0
    sessionEvents.requestGitRefresh({ directory: '/repo' })
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toEqual([])
    sessionEvents.requestGitRefresh({ directory: '/repo', sessionChanges: true })
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toHaveLength(1)
    unsubscribe()
  })

  test('subscribing fetches immediately and stores the entry under the key', async () => {
    respond = () => Promise.resolve(makeChanges({
      files: [file('src/a.ts')],
      sessionCount: 2,
      hasUnattributedMutations: true,
      firstUserMessageID: 'msg_1',
    }))

    const unsubscribe = subscribeSessionTreeChanges('/repo', 'ses_root')
    await wait(0)

    expect(calls).toEqual([{ rootSessionID: 'ses_root', directory: '/repo' }])
    const entry = useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))
    expect(entry?.files.map((entryFile) => entryFile.path)).toEqual(['src/a.ts'])
    expect(entry?.sessionCount).toBe(2)
    expect(entry?.hasUnattributedMutations).toBe(true)
    expect(entry?.firstUserMessageID).toBe('msg_1')
    expect(entry?.loading).toBe(false)
    expect(entry?.error).toBeNull()
    expect(entry?.fetchedAt).toBeGreaterThan(0)
    unsubscribe()
  })

  test('debounces burst refresh requests into one fetch', async () => {
    requestSessionTreeChangesRefresh('/repo', 'ses_root')
    requestSessionTreeChangesRefresh('/repo', 'ses_root')
    requestSessionTreeChangesRefresh('/repo', 'ses_root')
    expect(calls).toEqual([])

    await wait(DEBOUNCE_MS * 3)
    expect(calls).toHaveLength(1)
  })

  test('refreshes on a working → idle transition of the tree', async () => {
    observeSessionTreeActivity('/repo', 'ses_root', false)
    observeSessionTreeActivity('/repo', 'ses_root', true)
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toEqual([])

    observeSessionTreeActivity('/repo', 'ses_root', false)
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toEqual([{ rootSessionID: 'ses_root', directory: '/repo' }])
  })

  test('refreshes subscribed trees on git refresh hints for their directory only', async () => {
    const unsubscribe = subscribeSessionTreeChanges('/repo', 'ses_root')
    await wait(0)
    calls.length = 0

    sessionEvents.requestGitRefresh({ directory: '/elsewhere' })
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toEqual([])

    sessionEvents.requestGitRefresh({ directory: '/repo' })
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toEqual([{ rootSessionID: 'ses_root', directory: '/repo' }])

    unsubscribe()
    sessionEvents.requestGitRefresh({ directory: '/repo' })
    await wait(DEBOUNCE_MS * 3)
    expect(calls).toHaveLength(1)
  })

  test('ignores a response that a newer request for the same key has superseded', async () => {
    const first = createDeferred()
    const second = createDeferred()
    const pending = [first, second]
    respond = () => pending.shift()!.promise

    const firstRefresh = refreshSessionTreeChanges('/repo', 'ses_root')
    const secondRefresh = refreshSessionTreeChanges('/repo', 'ses_root')
    expect(calls).toHaveLength(2)

    second.resolve(makeChanges({ files: [file('src/new.ts')] }))
    await secondRefresh
    first.resolve(makeChanges({ files: [file('src/stale.ts')] }))
    await firstRefresh

    const entry = useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))
    expect(entry?.files.map((entryFile) => entryFile.path)).toEqual(['src/new.ts'])
    expect(entry?.loading).toBe(false)
  })

  test('records fetch failures without dropping the previous files', async () => {
    respond = () => Promise.resolve(makeChanges({ files: [file('src/a.ts')] }))
    await refreshSessionTreeChanges('/repo', 'ses_root')

    respond = () => Promise.reject(new Error('offline'))
    await refreshSessionTreeChanges('/repo', 'ses_root')

    const entry = useSessionTreeChangesStore.getState().entries.get(getSessionTreeChangesKey('/repo', 'ses_root'))
    expect(entry?.error).toBe('offline')
    expect(entry?.loading).toBe(false)
    expect(entry?.files.map((entryFile) => entryFile.path)).toEqual(['src/a.ts'])
  })

  test('clears every entry owned by a directory', async () => {
    await refreshSessionTreeChanges('/repo', 'ses_root')
    await refreshSessionTreeChanges('/other', 'ses_root')

    clearDirectorySessionTreeChanges('/repo')

    const entries = useSessionTreeChangesStore.getState().entries
    expect(entries.has(getSessionTreeChangesKey('/repo', 'ses_root'))).toBe(false)
    expect(entries.has(getSessionTreeChangesKey('/other', 'ses_root'))).toBe(true)
  })
})
