import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { DEFAULT_MESSAGE_LIMIT } from "@/stores/types/sessionTypes"
import {
  hasMessageRecordInfo,
  normalizeFetchedMessageRecords,
  normalizeMessageFetchLimit,
  normalizeSessionMessagePageLimit,
  resolveMessagePagePagination,
  resolveRetainedMessageLimit,
  type MessageRecord,
} from "./message-fetch"

const message = (id: string): Message => ({
  id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1 },
} as Message)

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}_part`,
  messageID,
  type: "text",
  text,
} as Part)

const reasoningPart = (messageID: string, text: string): Part => ({
  id: `${messageID}_reasoning`,
  messageID,
  type: "reasoning",
  text,
} as Part)

describe("normalizeFetchedMessageRecords", () => {
  test("normalizes duplicate text inside persisted fetched records", () => {
    const line = "Picking up implementation: creating the hook and history section, then wiring them into the shell."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${line}\n${line}\n`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${line}\n`)
  })

  test("strips internal tool-runner diagnostics from persisted assistant text", () => {
    const line = "Picking up implementation: creating the hook and history section, then wiring them into the shell."
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${line}\n${line}\n${diagnostic}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(line)
  })

  test("does not strip Cursor meta-looking prose from persisted assistant text", () => {
    const meta = "The user wants to continue implementing the calendar redesign."
    const line = "Fixing the broken AppointmentHistorySection, then wiring the shell and i18n."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${meta}\n\n${line}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${meta}\n\n${line}`)
  })

  test("preserves intent restatements in persisted assistant reasoning", () => {
    const meta = "The user requests to continue implementing the calendar redesign."
    const reasoning = "The AppointmentHistorySection file contains invalid JSX syntax."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${meta}\n\n${reasoning}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${meta}\n\n${reasoning}`)
  })

  test("preserves skill/action prose in persisted assistant reasoning", () => {
    const noisy = "Considering Supabase skills I think I might need to apply some Supabase skills."
    const reasoning = "The auth route should reuse the existing Supabase server client."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves skill-conflict prose in persisted assistant reasoning", () => {
    const noisy = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const reasoning = "The orchestrator prompt conflicts with skills that require announcements."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves headings and skill-announcement prose in persisted assistant reasoning", () => {
    const noisy = "**Clarifying plan execution**\n\nThe user provided a brief plan. My skill indicates that I should save the plan and announce it, but the platform announcement policy is tool-only."
    const reasoning = "The final response should contain the concise plan only."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("does not strip repeated skill/action-looking prose from persisted assistant text", () => {
    const text = "Considering Supabase skills I think I might need to apply some Supabase skills."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(text)
  })

  test("does not strip skill-conflict-looking prose from persisted assistant text", () => {
    const text = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(text)
  })

  test("does not strip skill-announcement-looking prose from persisted assistant text", () => {
    const text = "My skill indicates that I should save the plan and announce it, but this sentence is visible assistant prose."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(text)
  })

  test("does not strip diagnostics from persisted user text", () => {
    const info = { ...message("msg_user"), role: "user" as const } as Message
    const text = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'
    const records = normalizeFetchedMessageRecords([{ info, parts: [textPart("msg_user", text)] }])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(text)
  })

  test("does not strip meta-restatement-looking persisted user text", () => {
    const info = { ...message("msg_user"), role: "user" as const } as Message
    const text = "The user wants to continue implementing the calendar redesign."
    const records = normalizeFetchedMessageRecords([{ info, parts: [textPart("msg_user", text)] }])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(text)
  })

  test("preserves non-text parts and message info identity where parts do not change", () => {
    const info = message("msg_2")
    const tool = { id: "tool_1", messageID: "msg_2", type: "tool", output: "ok" } as unknown as Part
    const records = normalizeFetchedMessageRecords([{ info, parts: [tool] }])

    expect(records[0]?.info).toBe(info)
    expect(records[0]?.parts?.[0]).toBe(tool)
  })
})

describe("normalizeMessageFetchLimit", () => {
  test("falls back for an infinite limit of either sign and for NaN", () => {
    expect(DEFAULT_MESSAGE_LIMIT).toBe(200)
    expect(normalizeMessageFetchLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MESSAGE_LIMIT)
    expect(normalizeMessageFetchLimit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MESSAGE_LIMIT)
    expect(normalizeMessageFetchLimit(Number.NaN)).toBe(DEFAULT_MESSAGE_LIMIT)
    expect(normalizeMessageFetchLimit(Number.POSITIVE_INFINITY, 7)).toBe(7)
    expect(normalizeMessageFetchLimit(undefined, 7)).toBe(7)
  })

  test("falls back for zero and negative limits and keeps the largest finite number", () => {
    expect(normalizeMessageFetchLimit(0, 7)).toBe(7)
    expect(normalizeMessageFetchLimit(-0, 7)).toBe(7)
    expect(normalizeMessageFetchLimit(-1, 7)).toBe(7)
    expect(normalizeMessageFetchLimit(1, 7)).toBe(1)
    expect(normalizeMessageFetchLimit(Number.MAX_VALUE, 7)).toBe(Number.MAX_VALUE)
  })

  test("floors a fractional limit, so a positive limit under 1 becomes 0 instead of the fallback", () => {
    expect(normalizeMessageFetchLimit(1.9, 7)).toBe(1)
    expect(normalizeMessageFetchLimit(0.5, 7)).toBe(0)
    expect(normalizeMessageFetchLimit(Number.MIN_VALUE, 7)).toBe(0)
  })

  test("an infinite limit gives the default page size, retained limit and pagination limit", () => {
    expect(normalizeSessionMessagePageLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MESSAGE_LIMIT)
    expect(resolveRetainedMessageLimit({ requestedLimit: Number.POSITIVE_INFINITY, materializedCount: 3 })).toBe(DEFAULT_MESSAGE_LIMIT)
    expect(resolveRetainedMessageLimit({ requestedLimit: 10, materializedCount: Number.POSITIVE_INFINITY })).toBe(DEFAULT_MESSAGE_LIMIT)
    // 500 records against an infinite request: compared with the default 200, so the page is full and its cursor is kept.
    expect(resolveMessagePagePagination({ requestedLimit: Number.POSITIVE_INFINITY, returnedCount: 500, cursor: "cur" }))
      .toEqual({ cursor: "cur", complete: false })
    expect(resolveMessagePagePagination({ requestedLimit: Number.POSITIVE_INFINITY, returnedCount: 199, cursor: "cur" }))
      .toEqual({ cursor: undefined, complete: true })
  })
})

describe("hasMessageRecordInfo", () => {
  test("requires a message id of at least one UTF-16 unit", () => {
    expect(hasMessageRecordInfo({ info: message("") })).toBe(false)
    expect(hasMessageRecordInfo({ info: message("m") })).toBe(true)
    expect(hasMessageRecordInfo({ info: message("\ud800") })).toBe(true)
  })

  test("rejects a record without info or with a non-string id", () => {
    expect(hasMessageRecordInfo({})).toBe(false)
    expect(hasMessageRecordInfo({ parts: [] })).toBe(false)
    // Deliberately malformed: a numeric id, as an untyped server payload could carry.
    const numeric = { info: { ...message("x"), id: 1 } } as unknown as MessageRecord
    expect(hasMessageRecordInfo(numeric)).toBe(false)
  })
})

describe("normalizeFetchedMessageRecords: astral and lone-surrogate text", () => {
  // 34 UTF-16 units: above the 32-unit repeat floor.
  const emojiLine = "\ud83d\ude00".repeat(17)
  // 33 units: a lone high surrogate and 16 pairs.
  const loneLine = `\ud800${"\ud83d\ude00".repeat(16)}`

  test("collapses an unterminated line equal to the one above into one copy that gains a line break, keeping surrogate pairs intact", () => {
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${emojiLine}\n${emojiLine}`)] },
    ])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${emojiLine}\n`)
  })

  test("keeps a lone surrogate unchanged in a collapsed assistant reasoning part", () => {
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${loneLine}\n${loneLine}\n`)] },
    ])

    const text = (records[0]!.parts![0] as { text?: string }).text
    expect(text).toBe(`${loneLine}\n`)
    expect(text?.charCodeAt(0)).toBe(0xd800)
  })

  test("keeps a lone low surrogate unchanged in a collapsed user text part", () => {
    const info = { ...message("msg_user"), role: "user" as const } as Message
    const line = `${"\ud83d\ude00".repeat(16)}\udc00`
    const records = normalizeFetchedMessageRecords([{ info, parts: [textPart("msg_user", `${line}\n${line}\n`)] }])

    expect((records[0]!.parts![0] as { text?: string }).text).toBe(`${line}\n`)
  })

  test("returns the same record and part when astral text long enough to be scanned needs no change", () => {
    // 34 + 35 = 69 UTF-16 units: past the 64-unit short circuit, so the repeat scan runs.
    const text = `${emojiLine} once, followed by different words.`
    expect(text.length).toBe(69)
    const part = textPart("msg_1", text)
    const record = { info: message("msg_1"), parts: [part] }
    const records = normalizeFetchedMessageRecords([record])

    expect(records[0]).toBe(record)
    expect(records[0]?.parts?.[0]).toBe(part)
  })
})

describe("normalizeFetchedMessageRecords: a record with several parts", () => {
  test("returns a new record when only its first part changes, keeping the unchanged later part by identity", () => {
    const line = "Picking up implementation: creating the hook and history section, then wiring them into the shell."
    const first = textPart("msg_1", `${line}\n${line}\n`)
    const last = { ...reasoningPart("msg_1", "Short and unchanged."), id: "msg_1_last" } as Part
    const record = { info: message("msg_1"), parts: [first, last] }

    const [result] = normalizeFetchedMessageRecords([record])

    expect(result).not.toBe(record)
    expect((result!.parts![0] as { text?: string }).text).toBe(`${line}\n`)
    expect(result!.parts![1]).toBe(last)
    expect(result!.info).toBe(record.info)
    expect(record.parts[0]).toBe(first)
  })
})
