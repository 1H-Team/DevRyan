import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "@/lib/i18n"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { ContextUsageWindow } from "./ContextUsageWindow"
import { isContextUsageOutsideInteraction } from "./contextUsageInteraction"

const triggerRef = { current: null }

const usage: SessionContextUsage = {
  activeInputTokens: 1250,
  lastOutputTokens: 0,
  source: "message-fallback",
  updatedAt: 1,
  percentage: 125,
  capacityLimit: 1000,
  capacityBasis: "input",
  inputLimit: 1000,
  contextLimit: 1200,
  outputLimit: 200,
  tokenBreakdown: {
    input: 1250,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1250,
  },
  hasTokenBreakdown: true,
}

describe("ContextUsageWindow", () => {
  test("explains that drafts do not have context usage yet", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={null}
          availability="idle"
          onClose={() => {}}
          onCompact={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Start a chat to measure context usage.")
    expect(markup).not.toContain("Compact")
  })

  test("renders a busy loading state without fabricating token values", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={null}
          availability="loading"
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("Loading context usage…")
    expect(markup).not.toContain("0.0%")
  })

  test("renders a resolved unmeasured state", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={null}
          availability="unavailable"
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Context usage has not been measured for this session.")
  })

  test("keeps the raw percentage label while clamping visual segment widths", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow usage={usage} onClose={() => {}} triggerRef={triggerRef} />
      </I18nProvider>,
    )

    expect(markup).toContain("1.3K / 1.0K (125%)")
    expect(markup).toContain("width:100%")
    expect(markup).not.toContain("width:125%")
  })

  test("offers compaction only for an available measured session", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={usage}
          availability="available"
          onClose={() => {}}
          onCompact={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Compact")
  })

  test("renders a muted free space row when capacity is known", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            activeInputTokens: 250,
            percentage: 25,
            tokenBreakdown: { ...usage.tokenBreakdown, input: 250, total: 250 },
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Free Space")
    expect(markup).toContain("750")
    expect(markup).toContain("75.0%")
  })

  test("hides free space and percents when capacity is unavailable", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            capacityLimit: null,
            capacityBasis: "unavailable",
            inputLimit: null,
            contextLimit: null,
            outputLimit: null,
            percentage: null,
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).not.toContain("Free Space")
    expect(markup).toContain("1.3K Tokens")
  })

  test("renders an expanded collapse toggle in the header", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow usage={usage} onClose={() => {}} triggerRef={triggerRef} />
      </I18nProvider>,
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain("Collapse Context Details")
  })

  test("renders every subagent session with title-cased section headings", () => {
    const subagentSessions = [
      { sessionId: "subagent-1", title: "Alpha Research", activeInputTokens: 1101 },
      { sessionId: "subagent-2", title: "Bravo Review", activeInputTokens: 2202 },
      { sessionId: "subagent-3", title: "Charlie Tests", activeInputTokens: 3303 },
      { sessionId: "subagent-4", title: "Delta Docs", activeInputTokens: 4404 },
      { sessionId: "subagent-5", title: "Echo Audit", activeInputTokens: 5505 },
    ].map((session) => ({
      ...session,
      capacityLimit: 10_000,
      capacityBasis: "input" as const,
      inputLimit: 10_000,
      contextLimit: 10_000,
      outputLimit: null,
      percentage: (session.activeInputTokens / 10_000) * 100,
    }))

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            relatedSubagentSessions: subagentSessions,
            relatedSubagentActiveInputTokens: subagentSessions.reduce((sum, session) => sum + session.activeInputTokens, 0),
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Uncached input")
    expect(markup).toContain("Subagent Sessions")
    expect(markup).not.toContain("Subagent sessions")
    expect(markup).not.toContain("more sessions")

    for (const session of subagentSessions) {
      expect(markup).toContain(session.title)
      expect(markup).toContain(`${(session.activeInputTokens / 1000).toFixed(1)}K / 10.0K`)
    }
  })

  test("labels provider token categories without explanatory usage copy", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            tokenBreakdown: {
              input: 100,
              output: 20,
              reasoning: 10,
              cacheRead: 900,
              cacheWrite: 220,
              total: 1250,
            },
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Uncached input")
    expect(markup).toContain("Cached input read")
    expect(markup).toContain("Cached input created")
    expect(markup).not.toContain("not a cumulative session total")
    expect(markup).not.toContain("high reuse is normal")
  })

  test("renders subagent rows as a collapsed tree with unmeasured markers", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            relatedSubagentSessions: [
              {
                sessionId: "subagent-1",
                title: "Parent Task",
                activeInputTokens: 1200,
                capacityLimit: 10_000,
                capacityBasis: "input",
                inputLimit: 10_000,
                contextLimit: 10_000,
                outputLimit: null,
                percentage: 12,
                parentSessionId: "root-session",
                depth: 0,
                hasData: true,
                tokenBreakdown: { input: 1200, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1200 },
              },
              {
                sessionId: "subagent-2",
                title: "Nested Task",
                activeInputTokens: 500,
                capacityLimit: 10_000,
                capacityBasis: "input",
                inputLimit: 10_000,
                contextLimit: 10_000,
                outputLimit: null,
                percentage: 5,
                parentSessionId: "subagent-1",
                depth: 1,
                hasData: true,
              },
              {
                sessionId: "subagent-3",
                title: "Unloaded Task",
                activeInputTokens: 0,
                capacityLimit: null,
                capacityBasis: "unavailable",
                inputLimit: null,
                contextLimit: null,
                outputLimit: null,
                percentage: null,
                parentSessionId: "root-session",
                depth: 0,
                hasData: false,
              },
            ],
            relatedSubagentActiveInputTokens: 1700,
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Parent Task")
    expect(markup).toContain("Unloaded Task")
    // Subagent rows default to collapsed, so nested children stay hidden.
    expect(markup).not.toContain("Nested Task")
    expect(markup).toContain("Expand Subagent Session")
    expect(markup).toContain("—")
    expect(markup).toContain("1.2K / 10.0K")
  })

  test("renders provider token rows without heuristic source categories", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            activeInputTokens: 850,
            lastOutputTokens: 100,
            percentage: 85,
            tokenBreakdown: {
              input: 300,
              output: 100,
              reasoning: 50,
              cacheRead: 500,
              cacheWrite: 50,
              total: 1000,
            },
          }}
          onClose={() => {}}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Uncached input")
    expect(markup).toContain("Cached input read")
    expect(markup).toContain("Cached input created")
    expect(markup).toContain("850 / 1.0K (85%)")
    expect(markup).toContain("Last response (outside active context)")
    expect(markup).toContain("Output")
    expect(markup).toContain("Reasoning")
    expect(markup).not.toContain("System Tools")
    expect(markup).not.toContain("Memory Files")
    expect(markup).not.toContain("Messages")
  })

  test("keeps trigger and panel interactions open while closing for outside interactions", () => {
    const panelTarget = {} as Node
    const triggerTarget = {} as Node
    const outsideTarget = {} as Node
    const panel = { contains: (target: Node) => target === panelTarget } as HTMLElement
    const trigger = { contains: (target: Node) => target === triggerTarget } as HTMLElement

    expect(isContextUsageOutsideInteraction(panelTarget, panel, trigger)).toBe(false)
    expect(isContextUsageOutsideInteraction(triggerTarget, panel, trigger)).toBe(false)
    expect(isContextUsageOutsideInteraction(outsideTarget, panel, trigger)).toBe(true)
    expect(isContextUsageOutsideInteraction(null, panel, trigger)).toBe(false)
  })
})
