import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import { buildSessionMessageRecordsSnapshot } from "./sync-context"
import { INITIAL_STATE, type State } from "./types"

const OPEN = "ses_open"
const OTHER = "ses_streaming_child"

const message = (id: string, sessionID: string): Message => ({
  id, sessionID, role: id.endsWith("user") ? "user" : "assistant", time: { created: 1 },
} as unknown as Message)
const text = (id: string, messageID: string, value: string): Part => ({ id, messageID, type: "text", text: value } as unknown as Part)

const openMessages = Array.from({ length: 200 }, (_, index) => message(`msg_${index}_${index % 2 ? "assistant" : "user"}`, OPEN))
const baseState: State = {
  ...INITIAL_STATE,
  status: "complete",
  message: { [OPEN]: openMessages, [OTHER]: [message("msg_child_assistant", OTHER)] },
  part: {
    ...Object.fromEntries(openMessages.map((entry) => [entry.id, [text(`prt_${entry.id}`, entry.id, "settled")]])),
    msg_child_assistant: [text("prt_child", "msg_child_assistant", "")],
  },
}

// Counts Map constructions inside `run`: the snapshot's per-message index.
const countMapConstructions = (run: () => void): number => {
  const OriginalMap = globalThis.Map
  let constructed = 0
  class CountingMap<K, V> extends OriginalMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries)
      constructed += 1
    }
  }
  globalThis.Map = CountingMap as MapConstructor
  try {
    run()
  } finally {
    globalThis.Map = OriginalMap
  }
  return constructed
}

describe("session message records snapshot", () => {
  test("keeps the open session's snapshot without allocating while another session streams", () => {
    const initial = buildSessionMessageRecordsSnapshot(baseState, OPEN)
    const emptySubscriber = buildSessionMessageRecordsSnapshot(baseState, "")
    let state = baseState
    let snapshot = initial
    let empty = emptySubscriber

    const constructed = countMapConstructions(() => {
      for (let index = 0; index < 500; index += 1) {
        const previousChild = state.part.msg_child_assistant![0] as Part & { text: string }
        state = { ...state, part: { ...state.part, msg_child_assistant: [{ ...previousChild, text: `${previousChild.text}${index} ` } as Part] } }
        snapshot = buildSessionMessageRecordsSnapshot(state, OPEN, snapshot)
        // Every tool part without a child session subscribes with an empty id.
        empty = buildSessionMessageRecordsSnapshot(state, "", empty)
      }
    })

    expect(snapshot).toBe(initial)
    expect(snapshot.list).toBe(initial.list)
    expect(empty).toBe(emptySubscriber)
    expect(constructed).toBe(0)
  })

  test("still publishes a new list, reusing unchanged records, when an open-session part changes", () => {
    const initial = buildSessionMessageRecordsSnapshot(baseState, OPEN)
    const changedId = openMessages[199]!.id
    const next = buildSessionMessageRecordsSnapshot({
      ...baseState,
      part: { ...baseState.part, [changedId]: [text(`prt_${changedId}`, changedId, "streaming")] },
    }, OPEN, initial)

    expect(next).not.toBe(initial)
    expect(next.list).toHaveLength(200)
    expect(next.list[199]!.parts[0]).toMatchObject({ text: "streaming" })
    expect(next.list.slice(0, 199).every((record, index) => record === initial.list[index])).toBe(true)
  })

  test("filters context-usage parts once per published part array", () => {
    const stepFinish = { id: "prt_step", messageID: "msg_1_assistant", type: "step-finish" } as unknown as Part
    const parts = [text("prt_text", "msg_1_assistant", "working"), stepFinish]
    const state: State = { ...baseState, part: { ...baseState.part, msg_1_assistant: parts } }
    const first = buildSessionMessageRecordsSnapshot(state, OPEN, undefined, { contextUsagePartsOnly: true })
    const originalFilter = Array.prototype.filter
    let filters = 0
    Array.prototype.filter = function (this: unknown[], ...args: Parameters<typeof originalFilter>) {
      filters += 1
      return originalFilter.apply(this, args)
    } as typeof originalFilter
    let again = first
    try {
      for (let index = 0; index < 50; index += 1) {
        again = buildSessionMessageRecordsSnapshot({ ...state, session_status: { [OTHER]: { type: "busy" } } }, OPEN, again, { contextUsagePartsOnly: true })
      }
    } finally {
      Array.prototype.filter = originalFilter
    }

    expect(again).toBe(first)
    expect(first.list[1]!.parts).toEqual([stepFinish])
    expect(filters).toBe(0)
  })
})
