import { describe, expect, it } from 'bun:test'
import { applyDirectoryEvent } from '../event-reducer'
import { INITIAL_STATE } from '../types'

function upsertMessage(state, messageID, role = 'assistant', sessionID = 'ses_1') {
  applyDirectoryEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: messageID,
        sessionID,
        role,
        time: { created: 1 },
      },
    },
  })
}

describe('applyDirectoryEvent', () => {
  it('does not duplicate overlapping delta text after a newer part.updated replaces an older one', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-1'
    const partID = 'part-1'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]).toHaveLength(1)
    expect(state.part[messageID]?.[0]?.text).toBe(
      'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends only the non-overlapping suffix of a streaming delta', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-2'
    const partID = 'part-2'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedRead',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedReadDiagra',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Diagram • Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(
      'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends a non-overlapping delta unchanged', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-3'
    const partID = 'part-3'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'PR comment done — ',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Let me fix it.',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('PR comment done — Let me fix it.')
  })

  it('preserves legitimate repeated output when no updated-to-delta dedupe window is active', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-4'
    const partID = 'part-4'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: 'ha',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'ha',
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe('haha')
  })

  it('skips exact duplicate full text deltas from repeated provider frames', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-duplicate-text'
    const partID = 'part-duplicate-text'
    const duplicated = 'Checking the current file state and finishing the move: remove the duplicate Registrations block from Credentials and update tab completion.'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: duplicated,
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: duplicated,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(duplicated)
  })

  it('skips exact duplicate full output deltas from repeated tool-error frames', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-duplicate-output'
    const partID = 'part-duplicate-output'
    const duplicated = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          output: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'output',
        delta: duplicated,
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'output',
        delta: duplicated,
      },
    })

    expect(state.part[messageID]?.[0]?.output).toBe(duplicated)
  })

  it('normalizes duplicate assistant text frames and strips internal diagnostics inside one coalesced delta', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-coalesced-duplicate'
    const partID = 'part-coalesced-duplicate'
    const duplicated = 'Continuing implementation: creating the hook and history section, then wiring them into the shell.'

    upsertMessage(state, messageID, 'assistant')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: `${duplicated}\n${duplicated}\nSkipped malformed tool call "edit": Invalid arguments for tool "edit".`,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(duplicated)
  })

  it('strips internal tool loop guard messages from assistant text deltas', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-tool-loop-guard'
    const partID = 'part-tool-loop-guard'
    const duplicated = 'Tool loop guard stopped repeated schema-invalid calls to "edit" after 8 attempts (limit 6). Adjust tool arguments and retry.'

    upsertMessage(state, messageID, 'assistant')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: duplicated,
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: duplicated,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe("")
  })

  it('does not strip Cursor meta-looking assistant text deltas', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-meta-restatement'
    const partID = 'part-meta-restatement'
    const meta = 'The user wants to continue implementing the calendar redesign.'
    const prose = 'Fixing the broken AppointmentHistorySection, then wiring the shell and i18n.'

    upsertMessage(state, messageID, 'assistant')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: `${meta}\n\n${prose}`,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(`${meta}\n\n${prose}`)
  })

  it('preserves intent-restatement lines from assistant reasoning deltas', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-reasoning-meta-restatement'
    const partID = 'part-reasoning-meta-restatement'
    const meta = 'The user requests to continue implementing the calendar redesign.'
    const reasoning = 'The AppointmentHistorySection file contains invalid JSX syntax.'

    upsertMessage(state, messageID, 'assistant')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'reasoning',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: `${meta}\n\n${reasoning}`,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(`${meta}\n\n${reasoning}`)
  })

  it('preserves self-referential skill/action lines from assistant reasoning deltas', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-reasoning-skill-action'
    const partID = 'part-reasoning-skill-action'
    const noisy = 'Considering Supabase skills I think I might need to apply some Supabase skills.'
    const reasoning = 'The auth route should reuse the existing Supabase server client.'

    upsertMessage(state, messageID, 'assistant')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'reasoning',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: `${noisy}\n\n${reasoning}`,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(`${noisy}\n\n${reasoning}`)
  })

  it('does not strip internal diagnostic-looking user text', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-user-diagnostic'
    const partID = 'part-user-diagnostic'
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'

    upsertMessage(state, messageID, 'user')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          sessionID: 'ses_1',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: diagnostic,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(diagnostic)
  })

  it('does not strip meta-restatement-looking user text', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-user-meta-restatement'
    const partID = 'part-user-meta-restatement'
    const text = 'The user wants to continue implementing the calendar redesign.'

    upsertMessage(state, messageID, 'user')

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          sessionID: 'ses_1',
          messageID,
          text: '',
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: text,
      },
    })

    expect(state.part[messageID]?.[0]?.text).toBe(text)
  })

  it('sanitizes full assistant text part updates after the owning message arrives', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-full-assistant-diagnostic'
    const partID = 'part-full-assistant-diagnostic'
    const prose = 'Continuing implementation: creating the hook and history section.'
    const diagnostic = 'Tool "edit" has been temporarily blocked after 3 repeated validation failures. Do not retry this tool. Use a different approach to complete the task.'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'text',
          sessionID: 'ses_1',
          messageID,
          text: `${prose}${diagnostic}`,
        },
      },
    })

    upsertMessage(state, messageID, 'assistant')

    expect(state.part[messageID]?.[0]?.text).toBe(prose)
  })

  it('preserves full assistant reasoning part updates after the owning message arrives', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-full-assistant-reasoning-meta'
    const partID = 'part-full-assistant-reasoning-meta'
    const meta = 'The user requests to continue implementing the calendar redesign.'
    const reasoning = 'The AppointmentHistorySection file contains invalid JSX syntax.'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'reasoning',
          sessionID: 'ses_1',
          messageID,
          text: `${meta}\n\n${reasoning}`,
        },
      },
    })

    upsertMessage(state, messageID, 'assistant')

    expect(state.part[messageID]?.[0]?.text).toBe(`${meta}\n\n${reasoning}`)
  })

  it('does not let a stale running tool update overwrite a completed tool part', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-5'
    const partID = 'part-5'

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'completed',
            time: {
              start: 10,
              end: 20,
            },
          },
        },
      },
    })

    applyDirectoryEvent(state, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partID,
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'running',
            time: {
              start: 10,
            },
          },
        },
      },
    })

    expect(state.part[messageID]?.[0]?.state?.status).toBe('completed')
    expect(state.part[messageID]?.[0]?.state?.time?.end).toBe(20)
  })
})
