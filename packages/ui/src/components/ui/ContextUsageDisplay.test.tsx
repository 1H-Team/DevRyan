import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "@/lib/i18n"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { ContextUsageDisplay } from "./ContextUsageDisplay"

const usage = (overrides: Partial<SessionContextUsage>): SessionContextUsage => ({
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
  ...overrides,
})

const renderDisplay = (
  value: SessionContextUsage | null,
  availability?: 'idle' | 'loading' | 'unavailable' | 'available',
) => renderToStaticMarkup(
  <I18nProvider>
    <ContextUsageDisplay usage={value} availability={availability} showPercentIcon />
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
      activeInputTokens: 512,
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

  test("keeps an informative trigger visible before a session exists", () => {
    const markup = renderDisplay(null, "idle")

    expect(markup).toContain("Context Usage: Start a chat to measure context usage.")
    expect(markup).toContain("Unavailable")
    expect(markup).not.toContain("0%")
  })

  test("marks unresolved context usage as busy", () => {
    const markup = renderDisplay(null, "loading")

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("Loading context usage…")
    expect(markup).not.toContain("0%")
  })

  test("distinguishes a resolved unmeasured session from loading", () => {
    const markup = renderDisplay(null, "unavailable")

    expect(markup).toContain("Context usage has not been measured for this session.")
    expect(markup).not.toContain('aria-busy="true"')
  })
})
