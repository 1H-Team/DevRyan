import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client'

import { INITIAL_STATE, type State } from '@/sync/types'
import {
  clearDirectorySessionChangeAttributions,
  clearSessionChangeAttribution,
  getSessionChangeAttributionKey,
  reconcileSessionChangeAttribution,
  useSessionChangeAttributionStore,
} from './useSessionChangeAttributionStore'

const createState = (path: string): State => {
  const session = {
    id: 'ses_1',
    title: 'Session',
    time: { created: 1, updated: 2 },
  } as Session
  const message = {
    id: 'msg_1',
    sessionID: session.id,
    role: 'assistant',
    time: { created: 1, completed: 2 },
  } as Message
  const part = {
    id: 'prt_1',
    sessionID: session.id,
    messageID: message.id,
    type: 'tool',
    tool: 'edit',
    state: { status: 'completed', input: { path } },
  } as unknown as Part

  return {
    ...INITIAL_STATE,
    session: [session],
    message: { [session.id]: [message] },
    part: { [message.id]: [part] },
  }
}

describe('useSessionChangeAttributionStore', () => {
  beforeEach(() => {
    useSessionChangeAttributionStore.setState({ entries: new Map() })
  })

  test('preserves the entries map when reconciliation is a no-op', () => {
    const state = createState('/repo/src/app.ts')
    reconcileSessionChangeAttribution('/repo', 'ses_1', state)
    const first = useSessionChangeAttributionStore.getState().entries

    reconcileSessionChangeAttribution('/repo', 'ses_1', state)

    expect(useSessionChangeAttributionStore.getState().entries).toBe(first)
  })

  test('clears one session or every entry owned by a directory', () => {
    reconcileSessionChangeAttribution('/repo', 'ses_1', createState('/repo/src/app.ts'))
    reconcileSessionChangeAttribution('/other', 'ses_1', createState('/other/src/app.ts'))

    clearSessionChangeAttribution('/repo', 'ses_1')
    expect(useSessionChangeAttributionStore.getState().entries.has(
      getSessionChangeAttributionKey('/repo', 'ses_1'),
    )).toBe(false)
    expect(useSessionChangeAttributionStore.getState().entries.has(
      getSessionChangeAttributionKey('/other', 'ses_1'),
    )).toBe(true)

    clearDirectorySessionChangeAttributions('/other')
    expect(useSessionChangeAttributionStore.getState().entries.size).toBe(0)
  })
})
