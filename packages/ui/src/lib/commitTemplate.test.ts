import { describe, expect, test } from "bun:test"

import {
  COMMIT_SUBJECT_MAX_LENGTH,
  buildCommitMsgHookScript,
  stripCommitComments,
  validateCommitMessage,
} from "./commitTemplate"

describe("stripCommitComments", () => {
  test("drops comment lines and trims whitespace", () => {
    const message = `feat(dashboard): add settings

# comment that should disappear
body line
`
    expect(stripCommitComments(message)).toBe(`feat(dashboard): add settings\n\nbody line`)
  })

  test("returns empty when only comments are present", () => {
    expect(stripCommitComments("# only comments\n#  another\n")).toBe("")
  })
})

describe("validateCommitMessage", () => {
  test("accepts type(scope): summary", () => {
    const result = validateCommitMessage("feat(dashboard): add settings page")
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("accepts type: summary without scope", () => {
    const result = validateCommitMessage("chore: update deps")
    expect(result.valid).toBe(true)
  })

  test("accepts breaking change marker (!)", () => {
    const result = validateCommitMessage("feat(dashboard)!: drop deprecated endpoint")
    expect(result.valid).toBe(true)
  })

  test("accepts generated bullet details after the subject", () => {
    const result = validateCommitMessage(`perf(git): speed commit drafts

- Batch selected Git diffs
- Fall back within the latency budget`)
    expect(result.valid).toBe(true)
    expect(result.cleaned).toContain("- Batch selected Git diffs")
  })

  test("rejects empty message", () => {
    const result = validateCommitMessage("")
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("empty")
  })

  test("rejects unknown type", () => {
    const result = validateCommitMessage("frobnicate(dashboard): add things")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => /type\(scope\)/.test(e))).toBe(true)
  })

  test("rejects subject longer than the configured max", () => {
    const tooLong = "feat: " + "x".repeat(COMMIT_SUBJECT_MAX_LENGTH)
    const result = validateCommitMessage(tooLong)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("chars"))).toBe(true)
  })

  test("rejects trailing period", () => {
    const result = validateCommitMessage("fix(dashboard): correct alignment.")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("period"))).toBe(true)
  })

  test("strips template comments before validating", () => {
    const message = `feat(dashboard): add card

# template guidance below
# allowed types: ...
`
    const result = validateCommitMessage(message)
    expect(result.valid).toBe(true)
    expect(result.cleaned).toBe("feat(dashboard): add card")
  })
})

describe("buildCommitMsgHookScript", () => {
  test("emits a bash script with the configured subject limit", () => {
    const script = buildCommitMsgHookScript()
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(script).toContain(`max_len=${COMMIT_SUBJECT_MAX_LENGTH}`)
    expect(script).toContain("Allowed types:")
  })
})
