import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { normalizeFetchedMessageRecords } from "./message-fetch"

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

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${line}\n`)
  })

  test("strips internal tool-runner diagnostics from persisted assistant text", () => {
    const line = "Picking up implementation: creating the hook and history section, then wiring them into the shell."
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${line}\n${line}\n${diagnostic}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(line)
  })

  test("does not strip Cursor meta-looking prose from persisted assistant text", () => {
    const meta = "The user wants to continue implementing the calendar redesign."
    const line = "Fixing the broken AppointmentHistorySection, then wiring the shell and i18n."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", `${meta}\n\n${line}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${meta}\n\n${line}`)
  })

  test("preserves intent restatements in persisted assistant reasoning", () => {
    const meta = "The user requests to continue implementing the calendar redesign."
    const reasoning = "The AppointmentHistorySection file contains invalid JSX syntax."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${meta}\n\n${reasoning}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${meta}\n\n${reasoning}`)
  })

  test("preserves skill/action prose in persisted assistant reasoning", () => {
    const noisy = "Considering Supabase skills I think I might need to apply some Supabase skills."
    const reasoning = "The auth route should reuse the existing Supabase server client."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves skill-conflict prose in persisted assistant reasoning", () => {
    const noisy = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const reasoning = "The orchestrator prompt conflicts with skills that require announcements."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves headings and skill-announcement prose in persisted assistant reasoning", () => {
    const noisy = "**Clarifying plan execution**\n\nThe user provided a brief plan. My skill indicates that I should save the plan and announce it, but the platform announcement policy is tool-only."
    const reasoning = "The final response should contain the concise plan only."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [reasoningPart("msg_1", `${noisy}\n\n${reasoning}`)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("does not strip repeated skill/action-looking prose from persisted assistant text", () => {
    const text = "Considering Supabase skills I think I might need to apply some Supabase skills."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(text)
  })

  test("does not strip skill-conflict-looking prose from persisted assistant text", () => {
    const text = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(text)
  })

  test("does not strip skill-announcement-looking prose from persisted assistant text", () => {
    const text = "My skill indicates that I should save the plan and announce it, but this sentence is visible assistant prose."
    const records = normalizeFetchedMessageRecords([
      { info: message("msg_1"), parts: [textPart("msg_1", text)] },
    ])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(text)
  })

  test("does not strip diagnostics from persisted user text", () => {
    const info = { ...message("msg_user"), role: "user" as const } as Message
    const text = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'
    const records = normalizeFetchedMessageRecords([{ info, parts: [textPart("msg_user", text)] }])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(text)
  })

  test("does not strip meta-restatement-looking persisted user text", () => {
    const info = { ...message("msg_user"), role: "user" as const } as Message
    const text = "The user wants to continue implementing the calendar redesign."
    const records = normalizeFetchedMessageRecords([{ info, parts: [textPart("msg_user", text)] }])

    expect((records[0]?.parts?.[0] as { text?: string }).text).toBe(text)
  })

  test("preserves non-text parts and message info identity where parts do not change", () => {
    const info = message("msg_2")
    const tool = { id: "tool_1", messageID: "msg_2", type: "tool", output: "ok" } as unknown as Part
    const records = normalizeFetchedMessageRecords([{ info, parts: [tool] }])

    expect(records[0]?.info).toBe(info)
    expect(records[0]?.parts?.[0]).toBe(tool)
  })
})
