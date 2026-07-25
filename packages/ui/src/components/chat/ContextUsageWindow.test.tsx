import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "@/lib/i18n"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { ContextUsageWindow } from "./ContextUsageWindow"

const usage: SessionContextUsage = {
  totalTokens: 1250,
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
  sourceAccuracy: "reported",
  sourceTotalTokens: 1250,
  sources: [{ source: "conversation", tokens: 1250 }],
}

describe("ContextUsageWindow", () => {
  test("keeps the raw percentage label while clamping visual segment widths", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow usage={usage} onClose={() => {}} />
      </I18nProvider>,
    )

    expect(markup).toContain("125.0% Full")
    expect(markup).toContain("width:100%")
    expect(markup).not.toContain("width:125%")
  })

  test("renders every subagent session with title-cased section headings", () => {
    const subagentSessions = [
      { sessionId: "subagent-1", title: "Alpha Research", totalTokens: 1101 },
      { sessionId: "subagent-2", title: "Bravo Review", totalTokens: 2202 },
      { sessionId: "subagent-3", title: "Charlie Tests", totalTokens: 3303 },
      { sessionId: "subagent-4", title: "Delta Docs", totalTokens: 4404 },
      { sessionId: "subagent-5", title: "Echo Audit", totalTokens: 5505 },
    ].map((session) => ({
      ...session,
      capacityLimit: 10_000,
      capacityBasis: "input" as const,
      inputLimit: 10_000,
      contextLimit: 10_000,
      outputLimit: null,
      percentage: (session.totalTokens / 10_000) * 100,
    }))

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageWindow
          usage={{
            ...usage,
            sourceAccuracy: "unavailable",
            sources: [],
            relatedSubagentSessions: subagentSessions,
            relatedSubagentTotalTokens: subagentSessions.reduce((sum, session) => sum + session.totalTokens, 0),
          }}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    expect(markup).toContain("Token Stats")
    expect(markup).toContain("Subagent Sessions")
    expect(markup).not.toContain("Token stats")
    expect(markup).not.toContain("Subagent sessions")
    expect(markup).not.toContain("more sessions")

    for (const session of subagentSessions) {
      expect(markup).toContain(session.title)
      expect(markup).toContain(`${(session.totalTokens / 1000).toFixed(1)}K / 10.0K`)
    }
  })
})
