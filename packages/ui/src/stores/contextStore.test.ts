import { beforeEach, describe, expect, test } from "bun:test"
import { migratePersistedContextUsage, useContextStore } from "./contextStore"
import { resolveModelContextCapacity } from "./utils/modelContextCapacity"

const SESSION_ID = "ses_context_deferred_delete"

describe("contextStore permanent session cleanup", () => {
  beforeEach(() => {
    useContextStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
      currentAgentContext: new Map(),
      sessionContextUsage: new Map(),
      sessionAgentEditModes: new Map(),
    })
  })

  test("does not let a queued usage calculation recreate a deleted session", async () => {
    const messages = new Map([
      [SESSION_ID, [{
        info: {
          id: "msg_context_assistant",
          sessionID: SESSION_ID,
          role: "assistant",
          tokens: {
            input: 100,
            output: 20,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      }]],
    ])
    const capacity = resolveModelContextCapacity({ limit: { context: 10_000 } })
    const store = useContextStore.getState() as ReturnType<typeof useContextStore.getState> & {
      clearSessionContext?: (sessionId: string) => void
    }

    expect(store.getContextUsage(SESSION_ID, capacity, messages)?.activeInputTokens).toBe(100)
    expect(typeof store.clearSessionContext).toBe("function")
    store.clearSessionContext?.(SESSION_ID)

    await Promise.resolve()
    await Promise.resolve()

    expect(useContextStore.getState().sessionContextUsage.has(SESSION_ID)).toBe(false)
  })

  test("preserves untouched map references while removing the exact session", () => {
    const untouchedAgentSelections = useContextStore.getState().sessionAgentSelections
    const untouchedAgentModels = useContextStore.getState().sessionAgentModelSelections
    useContextStore.setState({
      sessionModelSelections: new Map([
        [SESSION_ID, { providerId: "openai", modelId: "gpt-5.5" }],
      ]),
    })

    useContextStore.getState().clearSessionContext(SESSION_ID)

    const next = useContextStore.getState()
    expect(next.sessionModelSelections.has(SESSION_ID)).toBe(false)
    expect(next.sessionAgentSelections).toBe(untouchedAgentSelections)
    expect(next.sessionAgentModelSelections).toBe(untouchedAgentModels)
  })
})

describe("contextStore usage migration", () => {
  test("derives active input from input and cache components", () => {
    const migrated = migratePersistedContextUsage({
      totalTokens: 128_504,
      percentage: 64,
      capacityLimit: 200_000,
      capacityBasis: "context",
      inputLimit: null,
      contextLimit: 200_000,
      outputLimit: null,
      tokenBreakdown: {
        input: 2,
        output: 1_464,
        reasoning: 0,
        cacheRead: 125_220,
        cacheWrite: 1_818,
        total: 128_504,
      },
      hasTokenBreakdown: true,
    })

    expect(migrated?.activeInputTokens).toBe(127_040)
    expect(migrated?.lastOutputTokens).toBe(1_464)
    expect(migrated?.source).toBe("message-fallback")
    expect(migrated?.tokenBreakdown.total).toBe(127_040)
  })
})
