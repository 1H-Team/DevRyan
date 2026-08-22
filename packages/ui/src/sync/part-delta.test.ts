import { describe, expect, test } from "bun:test"
import {
  appendNonOverlappingDelta,
  appendStreamingTextDelta,
  collapseExactAdjacentTextRepeats,
  normalizeAssistantReasoningText,
  normalizeAssistantVisibleText,
  stripInternalToolRunnerDiagnostics,
} from "./part-delta"

describe("collapseExactAdjacentTextRepeats", () => {
  test("collapses a duplicated complete status line inside one value", () => {
    const line = "Continuing implementation: creating the hook and history section, then wiring them into the shell."

    expect(collapseExactAdjacentTextRepeats(
      `${line}\n${line}\nSkipped malformed tool call "edit": Invalid arguments for tool "edit".`,
    )).toBe(`${line}\nSkipped malformed tool call "edit": Invalid arguments for tool "edit".`)
  })

  test("collapses a jammed duplicated tool diagnostic inside one value", () => {
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'

    expect(collapseExactAdjacentTextRepeats(
      `${diagnostic}${diagnostic}Tool loop guard stopped repeated schema-invalid calls to "edit" after 4 attempts (limit 2).`,
    )).toBe(`${diagnostic}Tool loop guard stopped repeated schema-invalid calls to "edit" after 4 attempts (limit 2).`)
  })

  test("keeps short intentional repetition", () => {
    expect(collapseExactAdjacentTextRepeats("ha\nha")).toBe("ha\nha")
  })

  test("keeps non-adjacent repeated long text", () => {
    const line = "This is a long sentence that may legitimately return later in a response."

    expect(collapseExactAdjacentTextRepeats(`${line}\nDifferent middle sentence.\n${line}`))
      .toBe(`${line}\nDifferent middle sentence.\n${line}`)
  })
})

describe("stripInternalToolRunnerDiagnostics", () => {
  test("removes malformed edit tool diagnostics and keeps assistant prose", () => {
    const prose = "The `edit` tool is blocked, so I'll use `Write` and `StrReplace` to finish the hook."
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'

    expect(stripInternalToolRunnerDiagnostics(`${prose}\n${diagnostic}`)).toBe(prose)
  })

  test("removes jammed tool-runner diagnostics", () => {
    const prose = "Picking up implementation: creating the hook and history section."
    const malformed = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string. missing required: old_string | edit requires path, old_string, and new_string'
    const blocked = 'Tool "edit" has been temporarily blocked after 3 repeated validation failures. Do not retry this tool. Use a different approach to complete the task.'
    const guard = 'Tool loop guard stopped repeated schema-invalid calls to "edit" after 4 attempts (limit 2). Adjust tool arguments and retry.'

    expect(stripInternalToolRunnerDiagnostics(`${prose}\n${malformed}${blocked}${guard}`)).toBe(prose)
  })

  test("returns empty string for diagnostic-only text", () => {
    expect(stripInternalToolRunnerDiagnostics(
      'Tool loop guard stopped repeated schema-invalid calls to "edit" after 8 attempts (limit 6). Adjust tool arguments and retry.',
    )).toBe("")
  })

  test("keeps ordinary model-authored edit tool prose", () => {
    const prose = "The edit tool is blocked, so I'll use Write and StrReplace next."

    expect(stripInternalToolRunnerDiagnostics(prose)).toBe(prose)
  })
})

describe("normalizeAssistantVisibleText", () => {
  test("collapses duplicated assistant prose and strips internal diagnostics", () => {
    const prose = "Continuing implementation: creating the hook and history section, then wiring them into the shell."
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'

    expect(normalizeAssistantVisibleText(`${prose}\n${prose}\n${diagnostic}`)).toBe(prose)
  })

  test("keeps visible assistant text that looks like a user request summary", () => {
    const prose = "The user wants to keep a visible implementation summary in the final answer."

    expect(normalizeAssistantVisibleText(prose)).toBe(prose)
  })

  test("preserves provider-authored intent restatements in reasoning", () => {
    const meta = "The user wants to continue implementing the calendar redesign."
    const reasoning = "The AppointmentHistorySection file contains invalid JSX syntax."

    expect(normalizeAssistantReasoningText(`${meta}\n\n${reasoning}`)).toBe(`${meta}\n\n${reasoning}`)
  })

  test("preserves a long Anthropic visual-review trace verbatim", () => {
    const reasoning = "I can't visually parse the PNG binary data from the screenshots, but I have the source code and browser measurements from the task context, so I'll work from those instead. The desktop and mobile measurements show no horizontal overflow. The main non-visual issue is the hardcoded English strings, which should remain an advisory finding rather than being silently removed from the trace."

    expect(normalizeAssistantReasoningText(reasoning)).toBe(reasoning)
  })

  test("preserves provider-authored skill narration in reasoning", () => {
    const noisy = "Considering Supabase skills I think I might need to apply some Supabase skills."
    const reasoning = "The request touches Supabase auth, so the implementation should read the local Supabase helper first."

    expect(normalizeAssistantReasoningText(`${noisy}\n\n${reasoning}`)).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves provider-authored skill-conflict reasoning", () => {
    const noisy = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const reasoning = "The orchestrator prompt conflicts with skills that require announcements."

    expect(normalizeAssistantReasoningText(`${noisy}\n\n${reasoning}`)).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves provider-authored headings and skill-announcement reasoning", () => {
    const noisy = "**Clarifying plan execution**\n\nThe user provided a brief plan. My skill indicates that I should save the plan and announce it, but the platform announcement policy is tool-only."
    const reasoning = "The final response should contain the concise plan only."

    expect(normalizeAssistantReasoningText(`${noisy}\n\n${reasoning}`)).toBe(`${noisy}\n\n${reasoning}`)
  })

  test("preserves repeated inspect-target reasoning lines", () => {
    const noisy = "Exploring skills index I need to inspect the skills index."

    expect(normalizeAssistantReasoningText(noisy)).toBe(noisy)
  })

  test("does not strip useful reasoning that mentions skills without self-referential repetition", () => {
    const reasoning = "The Supabase skill is relevant because the request changes auth behavior."

    expect(normalizeAssistantReasoningText(reasoning)).toBe(reasoning)
  })

  test("does not strip visible assistant text that matches skill-conflict reasoning shape", () => {
    const text = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."

    expect(normalizeAssistantVisibleText(text)).toBe(text)
  })

  test("does not strip visible assistant text that mentions skill announcements", () => {
    const text = "My skill indicates that I should save the plan and announce it, but this sentence is visible assistant prose."

    expect(normalizeAssistantVisibleText(text)).toBe(text)
  })

  test("preserves reasoning intent-restatement variants from every provider", () => {
    const variants = [
      "The user requests to revert the changes I made during our conversation.",
      "The user asked to continue implementing the calendar redesign.",
      "The user is asking to finish the remaining shell wiring.",
      "The user wants me to continue implementing the solution.",
      "The user intends for me to proceed with implementing the calendar redesign.",
    ]

    variants.forEach((variant) => {
      expect(normalizeAssistantReasoningText(variant)).toBe(variant)
    })
  })

  test("keeps ordinary requirement summaries that do not restate agent intent", () => {
    const prose = "The user wants a calendar redesign with appointment history."

    expect(normalizeAssistantReasoningText(prose)).toBe(prose)
  })

  test("preserves incomplete reasoning list fragments while streaming", () => {
    const reasoning = "Good. So for the professional dashboard, the required changes are:\n\n1."

    expect(normalizeAssistantReasoningText(reasoning)).toBe(reasoning)
  })

  test("removes internal tool-runner diagnostics without removing reasoning prose", () => {
    const reasoning = "The user requests a complete explanation of the implementation."
    const diagnostic = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'

    expect(normalizeAssistantReasoningText(`${reasoning}\n${diagnostic}`)).toBe(reasoning)
  })

  test("strips exact Cursor edit-tool workaround lines and keeps visible assistant prose", () => {
    const workaround = "The `edit` tool is blocked, so I'll use `Write` and `StrReplace` to finish the hook, history section, shell wiring, and i18n keys."
    const prose = "Fixing the broken AppointmentHistorySection, then wiring the shell and i18n."

    expect(normalizeAssistantVisibleText(`${workaround}\n\n${prose}`)).toBe(prose)
  })

  test("strips exact Cursor continuing-with-tool-workaround lines", () => {
    expect(normalizeAssistantVisibleText("Continuing with `Write` and `StrReplace` since `edit` is blocked.")).toBe("")
  })
})

describe("appendStreamingTextDelta", () => {
  test("normalizes a duplicated first frame in a single coalesced delta", () => {
    const frame = "Continuing implementation: creating the hook and history section, then wiring them into the shell."

    expect(appendStreamingTextDelta("", `${frame}\n${frame}\n`)).toBe(`${frame}\n`)
  })
})

describe("appendNonOverlappingDelta", () => {
  test("dedupes a delta the existing value already fully contains, at any length", () => {
    expect(appendNonOverlappingDelta("streamed hello", "hello")).toBe("streamed hello")
    expect(appendNonOverlappingDelta("ok", "ok")).toBe("ok")
  })

  test("strips a long genuine overlap between snapshot tail and delta head", () => {
    expect(appendNonOverlappingDelta(
      "The booking flow already exists in this repo",
      "already exists in this repo, so the work is integration",
    )).toBe("The booking flow already exists in this repo, so the work is integration")
  })

  test("keeps a short coincidental overlap instead of swallowing word characters", () => {
    // "…and v" + "vital…": the shared "v" is coincidence, not a replay. The old
    // 1-char dedupe produced "…and vital…", eating the delta's leading letter.
    expect(appendNonOverlappingDelta("difficulty read, and v", "vital context follows"))
      .toBe("difficulty read, and vvital context follows")
    expect(appendNonOverlappingDelta("checking the", "the docs")).toBe("checking thethe docs")
  })

  test("collapses a 5-character streaming handoff without requiring a longer overlap", () => {
    expect(appendNonOverlappingDelta("Hello", "Hello world")).toBe("Hello world")
    expect(appendNonOverlappingDelta(
      "toolFailedToReadDiagram vs toolFailedReadDiagra",
      "Diagram • Let me fix it.",
    )).toBe("toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.")
  })
})
