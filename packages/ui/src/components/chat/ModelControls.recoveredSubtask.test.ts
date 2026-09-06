import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./ModelControls.tsx", import.meta.url), "utf8")

describe("ModelControls recovered subtask restoration", () => {
  test("uses the directory-scoped child session and restores its exact send configuration", () => {
    expect(source).toContain(
      "useSession(currentSessionId, currentSessionDirectory ?? undefined)",
    )
    expect(source).toContain(
      "createLatestUserChoiceSelector(currentSessionId ?? '')",
    )
    expect(source).toContain(
      "const currentSessionMessagesResolved = useSessionMessagesResolved(",
    )
    expect(source).toContain(
      "providers.length === 0 || !currentSessionMessagesResolved || !latestLoadedUserChoice?.providerID",
    )
    expect(source).not.toContain(
      "providers.length === 0 || !hasRenderableCurrentSessionSnapshot || !latestLoadedUserChoice?.providerID",
    )
    expect(
      /applyModelSelectionWithVariant\(\s*latestLoadedUserChoice\.providerID,\s*latestLoadedUserChoice\.modelID,\s*latestLoadedUserChoice\.variant,\s*restoredAgent \|\| currentAgentName \|\| undefined,/.test(source),
    ).toBe(true)
    expect(source).toContain("saveSessionAgentSelection(currentSessionId, restoredAgent)")
    expect(source).toContain("saveAgentModelForSession(")
    expect(source).toContain("preserveCurrentModel: true")
    expect(source).toContain("recordSessionSelection: false")
  })
})
