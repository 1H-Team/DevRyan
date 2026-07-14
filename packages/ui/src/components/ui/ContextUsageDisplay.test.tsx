import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "@/lib/i18n"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { ContextUsageDisplay } from "./ContextUsageDisplay"

const usage = (overrides: Partial<SessionContextUsage>): SessionContextUsage => ({
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
  sourceAccuracy: "unavailable",
  ...overrides,
})

const renderDisplay = (value: SessionContextUsage) => renderToStaticMarkup(
  <I18nProvider>
    <ContextUsageDisplay usage={value} showPercentIcon />
  </I18nProvider>,
)

describe("ContextUsageDisplay", () => {
  test("shows the raw percentage while the progress ring remains visual-only", () => {
    const markup = renderDisplay(usage({}))

    expect(markup).toContain("125.0%")
    expect(markup).toContain("Usable input capacity: 1.0K")
    expect(markup).toContain("Context limit: 1.2K")
  })

  test("shows measured tokens and neutral unavailable information without a percentage", () => {
    const markup = renderDisplay(usage({
      totalTokens: 512,
      percentage: null,
      capacityLimit: null,
      capacityBasis: "unavailable",
      inputLimit: null,
      contextLimit: null,
      outputLimit: null,
    }))

    expect(markup).toContain("Context limit unavailable")
    expect(markup).toContain("512")
    expect(markup).not.toContain("%")
    expect(markup).not.toContain("/ 0")
  })
})
