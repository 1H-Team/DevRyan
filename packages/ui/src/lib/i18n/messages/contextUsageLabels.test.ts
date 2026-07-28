import { describe, expect, test } from "bun:test"
import { dict } from "./en"

describe("context usage labels", () => {
  test("distinguishes uncached and cached input while explaining context occupancy", () => {
    expect(dict["contextSidebar.tokens.input"]).toBe("Uncached input")
    expect(dict["contextSidebar.tokens.cacheRead"]).toBe("Cached input read")
    expect(dict["contextSidebar.tokens.cacheWrite"]).toBe("Cached input created")
    expect(dict["contextUsage.window.tokenStatsHelp"]).toContain("cached tokens still occupy")
  })
})
