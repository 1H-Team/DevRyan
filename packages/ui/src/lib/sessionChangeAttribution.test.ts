import { describe, expect, test } from 'bun:test'
import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client'

import { projectSessionChangeAttribution } from './sessionChangeAttribution'
import { INITIAL_STATE, type State } from '@/sync/types'

const assistant = (id: string, sessionID = 'ses_1'): Message => ({
  id,
  sessionID,
  role: 'assistant',
  time: { created: 1, completed: 2 },
} as Message)

const user = (id: string, sessionID = 'ses_1', summary?: unknown): Message => ({
  id,
  sessionID,
  role: 'user',
  time: { created: 1 },
  ...(summary ? { summary } : {}),
} as Message)

const tool = (
  id: string,
  messageID: string,
  name: string,
  input: Record<string, unknown>,
  status = 'completed',
): Part => ({
  id,
  sessionID: 'ses_1',
  messageID,
  type: 'tool',
  tool: name,
  state: { status, input },
} as Part)

const state = (messages: Message[], parts: Record<string, Part[]>, session?: Session): State => ({
  ...INITIAL_STATE,
  session: [session ?? ({
    id: 'ses_1',
    title: 'Session',
    time: { created: 1, updated: 2 },
  } as Session)],
  message: { ses_1: messages },
  part: parts,
})

describe('projectSessionChangeAttribution', () => {
  test('ignores contaminated user summaries and workspace patch snapshots', () => {
    const messages = [
      user('msg_user', 'ses_1', {
        diffs: [
          { file: 'unrelated-a.ts', additions: 100, deletions: 20 },
          { file: 'unrelated-b.ts', additions: 50, deletions: 10 },
        ],
      }),
      assistant('msg_assistant'),
    ]

    expect(projectSessionChangeAttribution(state(messages, {
      msg_assistant: [{
        id: 'prt_snapshot',
        sessionID: 'ses_1',
        messageID: 'msg_assistant',
        type: 'patch',
        files: ['unrelated-a.ts', 'unrelated-b.ts'],
      } as unknown as Part],
    }), 'ses_1', '/repo')).toEqual({
      paths: [],
      hasUnattributedMutations: false,
    })
  })

  test('attributes completed explicit file tools and normalizes repository-relative paths', () => {
    const messages = [assistant('msg_assistant')]
    const result = projectSessionChangeAttribution(state(messages, {
      msg_assistant: [
        tool('prt_edit', 'msg_assistant', 'edit', { path: '/repo/src/app.ts' }),
        tool('prt_write', 'msg_assistant', 'write', { filePath: './src/new.ts' }),
        tool('prt_patch', 'msg_assistant', 'apply_patch', {
          patch: '*** Begin Patch\n*** Update File: src/app.ts\n*** Add File: src/added.ts\n*** End Patch',
        }),
      ],
    }), 'ses_1', '/repo')

    expect(result).toEqual({
      paths: ['src/added.ts', 'src/app.ts', 'src/new.ts'],
      hasUnattributedMutations: false,
    })
  })

  test('supports provider aliases and top-level Cursor input shapes', () => {
    const cursorTool = {
      id: 'prt_cursor_write',
      sessionID: 'ses_1',
      messageID: 'msg_assistant',
      type: 'tool',
      tool: 'writeToolCall',
      input: { targetFile: 'a/provider-owned.ts' },
      state: { status: 'completed' },
    } as unknown as Part

    const result = projectSessionChangeAttribution(state(
      [assistant('msg_assistant')],
      { msg_assistant: [cursorTool] },
    ), 'ses_1', '/repo')

    expect(result).toEqual({
      paths: ['a/provider-owned.ts'],
      hasUnattributedMutations: false,
    })
  })

  test('excludes failed, aborted, outside-repository, and non-file tools', () => {
    const messages = [assistant('msg_assistant')]
    const result = projectSessionChangeAttribution(state(messages, {
      msg_assistant: [
        tool('prt_failed', 'msg_assistant', 'edit', { path: '/repo/src/failed.ts' }, 'failed'),
        tool('prt_aborted', 'msg_assistant', 'write', { path: '/repo/src/aborted.ts' }, 'aborted'),
        tool('prt_read', 'msg_assistant', 'read', { path: '/repo/src/read.ts' }),
        tool('prt_outside', 'msg_assistant', 'edit', { path: '/other/outside.ts' }),
      ],
    }), 'ses_1', '/repo')

    expect(result).toEqual({
      paths: [],
      hasUnattributedMutations: true,
    })
  })

  test('marks successful shell mutations as unattributed without claiming workspace files', () => {
    const messages = [assistant('msg_assistant')]
    const result = projectSessionChangeAttribution(state(messages, {
      msg_assistant: [
        tool('prt_bash', 'msg_assistant', 'bash', { command: 'generate files' }),
      ],
    }), 'ses_1', '/repo')

    expect(result).toEqual({
      paths: [],
      hasUnattributedMutations: true,
    })
  })

  test('drops tools hidden by an authoritative session revert boundary', () => {
    const messages = [
      assistant('msg_1'),
      assistant('msg_2'),
    ]
    const session = {
      id: 'ses_1',
      title: 'Session',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2' },
    } as Session

    const result = projectSessionChangeAttribution(state(messages, {
      msg_1: [tool('prt_keep', 'msg_1', 'edit', { path: '/repo/src/keep.ts' })],
      msg_2: [tool('prt_drop', 'msg_2', 'edit', { path: '/repo/src/drop.ts' })],
    }, session), 'ses_1', '/repo')

    expect(result).toEqual({
      paths: ['src/keep.ts'],
      hasUnattributedMutations: false,
    })
  })
})
