import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"

import {
  buildResponseStyleInstruction,
  cacheResponseStyleInstructionFromSettings,
  clearResponseStyleInstructionCacheForTests,
  getCachedResponseStyleInstruction,
  getCachedResponseStyleLevel,
  isResponseStyleInstructionLoaded,
  readResponseStyleLevelFromParts,
  readSessionResponseStyleLevel,
  resolveResponseStyleLevel,
  shouldAttachResponseStyleReminder,
  wrapResponseStyleReminder,
} from "./responseStyle"

describe("response style levels", () => {
  test("maps disabled and legacy settings to rationale levels", () => {
    expect(resolveResponseStyleLevel({ responseStyleEnabled: false, responseStylePreset: "detailed" })).toBe("provider")
    expect(resolveResponseStyleLevel({ responseStyleEnabled: true, responseStylePreset: "actions" })).toBe("actions")

    for (const preset of ["concise", "noFiller", "matchEnergy"]) {
      expect(resolveResponseStyleLevel({ responseStyleEnabled: true, responseStylePreset: preset })).toBe("concise")
    }
    for (const preset of ["detailed", "mentor", "pushback", "warmPeer"]) {
      expect(resolveResponseStyleLevel({ responseStyleEnabled: true, responseStylePreset: preset })).toBe("detailed")
    }

    expect(resolveResponseStyleLevel({ responseStyleEnabled: true, responseStylePreset: "custom" })).toBe("provider")
    expect(resolveResponseStyleLevel({ responseStyleEnabled: true, responseStylePreset: "unknown" })).toBe("provider")
  })

  test("captures the selected level in a synthetic first-turn reminder", () => {
    const instruction = buildResponseStyleInstruction({ enabled: true, preset: "concise" })
    expect(instruction).not.toBeNull()
    const reminder = wrapResponseStyleReminder("concise", instruction ?? "")
    const parts = [{ type: "text", synthetic: true, text: reminder }] as Part[]

    expect(reminder).toContain('data-devryan-response-style="concise"')
    expect(readResponseStyleLevelFromParts(parts)).toBe("concise")
    expect(readResponseStyleLevelFromParts([{ ...parts[0], synthetic: false }] as Part[])).toBe("provider")
    expect(readResponseStyleLevelFromParts([])).toBe("provider")

    expect(readSessionResponseStyleLevel([
      { parts },
      { parts: [{ type: "text", text: "Later user prompt." }] as Part[] },
    ])).toBe("concise")
  })

  test("attaches the reminder only to a new conversation's first prompt", () => {
    expect(shouldAttachResponseStyleReminder({
      isNewSessionDraft: true,
      hasExistingSession: false,
      existingSessionHasUserMessages: false,
    })).toBe(true)
    expect(shouldAttachResponseStyleReminder({
      isNewSessionDraft: false,
      hasExistingSession: true,
      existingSessionHasUserMessages: false,
    })).toBe(true)
    expect(shouldAttachResponseStyleReminder({
      isNewSessionDraft: false,
      hasExistingSession: true,
      existingSessionHasUserMessages: true,
    })).toBe(false)
  })
})

describe("response style startup cache", () => {
  beforeEach(() => {
    clearResponseStyleInstructionCacheForTests()
  })

  test("caches the selected level and its first-turn instruction", () => {
    const settings = {
      responseStyleEnabled: true,
      responseStylePreset: "detailed",
    }

    const expected = buildResponseStyleInstruction({ enabled: true, preset: "detailed" })
    expect(cacheResponseStyleInstructionFromSettings(settings)).toBe(expected)
    expect(getCachedResponseStyleInstruction()).toBe(expected)
    expect(getCachedResponseStyleLevel()).toBe("detailed")
    expect(isResponseStyleInstructionLoaded()).toBe(true)
  })

  test("keeps provider default empty and maps removed custom settings safely", () => {
    expect(cacheResponseStyleInstructionFromSettings({
      responseStyleEnabled: true,
      responseStylePreset: "custom",
      responseStyleCustomInstructions: "Old custom tone instruction.",
    })).toBeNull()
    expect(getCachedResponseStyleLevel()).toBe("provider")
  })

  test("reads cached instructions synchronously without fetching settings on submit", () => {
    let fetchCalls = 0
    const fetchMock = mock(() => {
      fetchCalls += 1
      throw new Error("submit must not fetch settings")
    })
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      cacheResponseStyleInstructionFromSettings({
        responseStyleEnabled: true,
        responseStylePreset: "actions",
      })

      expect(getCachedResponseStyleInstruction()).toContain("action or status summary")
      expect(getCachedResponseStyleLevel()).toBe("actions")
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
