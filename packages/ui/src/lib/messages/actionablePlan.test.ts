import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  PLAN_IMPLEMENTATION_REQUEST_PREFIX,
  buildPlanImplementationRequestMarker,
  findPlanCardReasoningPartIndex,
  findPlanCardSentinel,
  hasStructuredPlanBody,
  isPlanModeUserMessage,
  parsePlanImplementationRequestPart,
  resolveMessagePlanCard,
  resolvePlanCardSplit,
  splitPlanCardSentinel,
  splitReasoningPartPlan,
  stripPlanCardSentinel,
} from "./actionablePlan"

const userMessage = (id: string): Message => ({
  id,
  sessionID: "session-1",
  role: "user",
  time: { created: Date.now() },
} as Message)

const assistantMessage = (id: string): Message => ({
  id,
  sessionID: "session-1",
  role: "assistant",
  time: { created: Date.now() },
} as Message)

const syntheticTextPart = (text: string): Part => ({
  id: "part-1",
  sessionID: "session-1",
  messageID: "message-1",
  type: "text",
  text,
  synthetic: true,
} as Part)

describe("plan implementation request marker", () => {
  const marker = buildPlanImplementationRequestMarker({
    sourceSessionId: "session-1",
    sourceMessageId: "assistant-1",
    planIndex: 0,
  })

  test("round-trips an exact synthetic implementation marker", () => {
    expect(parsePlanImplementationRequestPart(syntheticTextPart(marker))).toEqual({
      action: "implement",
      sourceSessionId: "session-1",
      sourceMessageId: "assistant-1",
      planIndex: 0,
    })
  })

  test("rejects malformed marker JSON", () => {
    expect(parsePlanImplementationRequestPart(
      syntheticTextPart(`${PLAN_IMPLEMENTATION_REQUEST_PREFIX}{broken`),
    )).toBeNull()
  })

  test("rejects visible marker text", () => {
    expect(parsePlanImplementationRequestPart({
      ...syntheticTextPart(marker),
      synthetic: false,
    } as Part)).toBeNull()
  })

  test("rejects unsupported actions and invalid plan identities", () => {
    expect(parsePlanImplementationRequestPart(syntheticTextPart(
      `${PLAN_IMPLEMENTATION_REQUEST_PREFIX}${JSON.stringify({
        action: "improve",
        sourceSessionId: "session-1",
        sourceMessageId: "assistant-1",
        planIndex: 0,
      })}`,
    ))).toBeNull()
    expect(parsePlanImplementationRequestPart(syntheticTextPart(
      `${PLAN_IMPLEMENTATION_REQUEST_PREFIX}${JSON.stringify({
        action: "implement",
        sourceSessionId: "session-1",
        sourceMessageId: "",
        planIndex: -1,
      })}`,
    ))).toBeNull()
  })
})

describe("isPlanModeUserMessage", () => {
  test("treats a recorded plan-mode user turn as a plan source", () => {
    expect(isPlanModeUserMessage(userMessage("user-1"), [], true)).toBe(true)
  })

  test("does not treat a normal user turn as a plan source", () => {
    expect(isPlanModeUserMessage(userMessage("user-1"), [], false)).toBe(false)
  })

  test("detects synthetic plan-mode instructions when recorded state is missing", () => {
    expect(isPlanModeUserMessage(
      userMessage("user-1"),
      [syntheticTextPart("User has requested to enter plan mode.\nProduce an implementation plan only.")],
      false,
    )).toBe(true)
  })

  test("treats a user turn with mode: 'plan' metadata as a plan source", () => {
    expect(isPlanModeUserMessage(
      { ...userMessage("user-1"), mode: "plan", agent: "builder" } as Message,
      [],
      false,
    )).toBe(true)
  })

  test("treats OpenChamber plan-mode metadata as a plan source", () => {
    expect(isPlanModeUserMessage(
      {
        ...userMessage("user-1"),
        agent: "builder",
        metadata: { openchamberPlanMode: true },
      } as unknown as Message,
      [],
      false,
    )).toBe(true)
  })

  test("ignores assistant messages", () => {
    expect(isPlanModeUserMessage(assistantMessage("assistant-1"), [], true)).toBe(false)
  })

  test("returns false for undefined message", () => {
    expect(isPlanModeUserMessage(undefined, [], true)).toBe(false)
  })
})

describe("splitPlanCardSentinel", () => {
  test("splits preamble and plan text around an own-line sentinel", () => {
    expect(splitPlanCardSentinel("intro\n<!--plan-->\n# Plan")).toEqual({
      preambleText: "intro\n",
      planText: "# Plan",
      source: "sentinel",
    })
  })

  test("supports whitespace and CRLF around the sentinel line", () => {
    expect(splitPlanCardSentinel("intro\r\n \t <!--plan--> \t \r\n# Plan")).toEqual({
      preambleText: "intro\r\n",
      planText: "# Plan",
      source: "sentinel",
    })
  })

  test("returns null for inline sentinel mentions", () => {
    expect(splitPlanCardSentinel("Use <!--plan--> here")).toBeNull()
  })

  test("uses only the first valid sentinel", () => {
    expect(splitPlanCardSentinel("intro\n<!--plan-->\n# Plan\n<!--plan-->\nextra")).toEqual({
      preambleText: "intro\n",
      planText: "# Plan\n<!--plan-->\nextra",
      source: "sentinel",
    })
  })

  test("preserves the full structured plan.md body after the sentinel", () => {
    const planBody = [
      "# Plan Mode Layout Contract Alignment",
      "",
      "## Context",
      "",
      "Runtime plan mode should match plan.md.",
      "",
      "## Critical files",
      "",
      "**Files modified**",
      "- `packages/ui/src/sync/session-ui-store.ts` — align the runtime prompt.",
      "",
      "## Implementation",
      "",
      "1. Update the synthetic instruction.",
      "",
      "## Verification",
      "",
      "1. Run the focused tests.",
    ].join("\n")

    expect(splitPlanCardSentinel(`preamble\n<!--plan-->\n${planBody}`)).toEqual({
      preambleText: "preamble\n",
      planText: planBody,
      source: "sentinel",
    })
  })

  test("tolerates an inline-code backticked sentinel (Grok echoes the prompt's formatting)", () => {
    expect(splitPlanCardSentinel("intro\n`<!--plan-->`\n# Plan")).toEqual({
      preambleText: "intro\n",
      planText: "# Plan",
      source: "sentinel",
    })
  })

  test("tolerates internal spaces inside the comment", () => {
    expect(splitPlanCardSentinel("intro\n<!-- plan -->\n# Plan")).toEqual({
      preambleText: "intro\n",
      planText: "# Plan",
      source: "sentinel",
    })
  })

  test("still rejects a sentinel with other text on the same line", () => {
    expect(splitPlanCardSentinel("intro\n<!--plan--> # Plan title")).toBeNull()
    expect(splitPlanCardSentinel("See `<!--plan-->` for details\nmore")).toBeNull()
  })
})

describe("sentinel find/strip tolerant forms", () => {
  test("findPlanCardSentinel locates bare and decorated sentinels", () => {
    expect(findPlanCardSentinel("abc\n<!--plan-->\nplan")).toBe(4)
    expect(findPlanCardSentinel("abc\n`<!--plan-->`\nplan")).toBe(4)
    expect(findPlanCardSentinel("abc\n<!-- plan -->\nplan")).toBe(4)
    expect(findPlanCardSentinel("no marker")).toBe(-1)
  })

  test("stripPlanCardSentinel removes decorated sentinels", () => {
    expect(stripPlanCardSentinel("intro\n`<!--plan-->`\n# Plan")).toBe("intro\n# Plan")
    expect(stripPlanCardSentinel("intro\n<!-- plan -->\n# Plan")).toBe("intro\n# Plan")
  })
})

describe("hasStructuredPlanBody", () => {
  test("matches a structured plan body and rejects ordinary prose", () => {
    const body = ["# Title", "", "## Context", "", "why", "", "## Implementation", "", "1. do"].join("\n")
    expect(hasStructuredPlanBody(body)).toBe(true)
    expect(hasStructuredPlanBody("just an ordinary answer\nwith lines")).toBe(false)
  })
})

const structuredPlanBody = [
  "# Cursor Plan Card Fix",
  "",
  "## Context",
  "",
  "Cursor models omit the sentinel.",
  "",
  "## Implementation",
  "",
  "1. Add fallback detection.",
  "",
  "## Verification",
  "",
  "1. Run tests.",
].join("\n")

describe("resolvePlanCardSplit", () => {
  test("uses the sentinel when present", () => {
    expect(resolvePlanCardSplit("intro\n<!--plan-->\n# Plan")).toEqual({
      preambleText: "intro\n",
      planText: "# Plan",
      source: "sentinel",
    })
  })

  test("falls back to structured plan headings in plan-mode source turns", () => {
    expect(resolvePlanCardSplit(`intro\n${structuredPlanBody}`, { isPlanModeSource: true })).toEqual({
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "structured",
    })
  })

  test("does not fallback for non-plan-mode turns with headings", () => {
    expect(resolvePlanCardSplit(structuredPlanBody, { isPlanModeSource: false })).toBeNull()
  })

  test("does not fallback when fewer than two plan headings are present", () => {
    expect(resolvePlanCardSplit("# Only Title\n\nSome text.", { isPlanModeSource: true })).toBeNull()
  })
})

const textPart = (messageId: string, text: string): Part => ({
  id: `${messageId}_text`,
  sessionID: "session-1",
  messageID: messageId,
  type: "text",
  text,
} as Part)

const reasoningPart = (messageId: string, text: string): Part => ({
  id: `${messageId}_reasoning`,
  sessionID: "session-1",
  messageID: messageId,
  type: "reasoning",
  text,
} as Part)

describe("resolveMessagePlanCard", () => {
  test("uses an explicit sentinel even when the source turn is not known plan mode", () => {
    expect(resolveMessagePlanCard([
      textPart("msg_1", `intro\n<!--plan-->\n${structuredPlanBody}`),
    ], { isPlanModeSource: false })).toEqual({
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "sentinel",
    })
  })

  test("joins non-consecutive text parts split by tool boundaries", () => {
    expect(resolveMessagePlanCard([
      textPart("msg_1", "intro\n<!--plan-->"),
      { id: "tool", sessionID: "session-1", messageID: "msg_1", type: "tool", tool: "grep" } as Part,
      textPart("msg_1", structuredPlanBody),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "sentinel",
    })
  })

  test("promotes structured plan content from trailing reasoning in plan mode", () => {
    expect(resolveMessagePlanCard([
      textPart("msg_1", "I'll inspect the repo first."),
      reasoningPart("msg_1", structuredPlanBody),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "I'll inspect the repo first.\n",
      planText: structuredPlanBody,
      source: "reasoning",
    })
  })

  test("uses a sentinel emitted inside a reasoning part (Grok emits it on the reasoning channel)", () => {
    expect(resolveMessagePlanCard([
      textPart("msg_1", "narration."),
      reasoningPart("msg_1", `Preamble thought.\n<!--plan-->\n${structuredPlanBody}`),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "narration.\n",
      planText: structuredPlanBody,
      source: "reasoning",
    })
  })

  test("joins a plan started in reasoning with its text continuation (straddle)", () => {
    const planHead = ["# Zen Fix", "", "## Context", "", "why it broke"].join("\n")
    const planTail = ["## Implementation", "", "1. do", "", "## Verification", "", "1. run tests."].join("\n")
    expect(resolveMessagePlanCard([
      reasoningPart("msg_1", `Thinking about the approach.\n<!--plan-->\n${planHead}`),
      textPart("msg_1", planTail),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "",
      planText: `${planHead}\n${planTail}`,
      source: "reasoning",
    })
  })

  test("does not glue a narration tail after a mid-turn reasoning plan fragment into the card", () => {
    const planFragment = ["# Diagnosis", "", "## Context", "", "words"].join("\n")
    expect(resolveMessagePlanCard([
      reasoningPart("msg_1", `Perfect!\n<!--plan-->\n${planFragment}`),
      textPart("msg_1", "The catalog id is x. I'll reproduce the failure next."),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "The catalog id is x. I'll reproduce the failure next.\n",
      planText: planFragment,
      source: "reasoning",
    })
  })

  test("does not displace a self-contained text plan with a reasoning draft", () => {
    expect(resolveMessagePlanCard([
      reasoningPart("msg_1", ["# Old Draft", "", "## Context", "", "old thinking."].join("\n")),
      textPart("msg_1", structuredPlanBody),
    ], { isPlanModeSource: true })).toEqual({
      preambleText: "",
      planText: structuredPlanBody,
      source: "structured",
    })
  })
})

describe("splitReasoningPartPlan", () => {
  test("splits at the sentinel and reports reasoning source", () => {
    expect(splitReasoningPartPlan(`Thought.\n<!--plan-->\n${structuredPlanBody}`)).toEqual({
      preambleText: "Thought.\n",
      planText: structuredPlanBody,
      source: "reasoning",
    })
  })

  test("falls back to structured headings", () => {
    expect(splitReasoningPartPlan(`Thought.\n${structuredPlanBody}`)).toEqual({
      preambleText: "Thought.\n",
      planText: structuredPlanBody,
      source: "reasoning",
    })
  })

  test("returns null for plain thought text", () => {
    expect(splitReasoningPartPlan("Just thinking about the failing test.")).toBeNull()
  })
})

describe("findPlanCardReasoningPartIndex", () => {
  test("returns -1 outside plan mode and when the plan is text-sourced", () => {
    expect(findPlanCardReasoningPartIndex([
      reasoningPart("msg_1", structuredPlanBody),
    ], { isPlanModeSource: false })).toBe(-1)
    expect(findPlanCardReasoningPartIndex([
      textPart("msg_1", `intro\n<!--plan-->\n${structuredPlanBody}`),
      reasoningPart("msg_1", "trailing thought."),
    ], { isPlanModeSource: true })).toBe(-1)
  })

  test("returns the sentinel-bearing reasoning part index", () => {
    expect(findPlanCardReasoningPartIndex([
      textPart("msg_1", "narration."),
      reasoningPart("msg_1", `Preamble thought.\n<!--plan-->\n${structuredPlanBody}`),
    ], { isPlanModeSource: true })).toBe(1)
  })

  test("returns the straddle head index and agrees with resolveMessagePlanCard", () => {
    const parts = [
      reasoningPart("msg_1", `Thinking.\n<!--plan-->\n# Zen Fix\n\n## Context\n\nwhy`),
      textPart("msg_1", "## Implementation\n\n1. do\n\n## Verification\n\n1. run tests."),
    ]
    expect(findPlanCardReasoningPartIndex(parts, { isPlanModeSource: true })).toBe(0)
    expect(resolveMessagePlanCard(parts, { isPlanModeSource: true })?.source).toBe("reasoning")
  })
})
