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
})
