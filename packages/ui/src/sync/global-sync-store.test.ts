import { expect, test } from "bun:test"
import { useGlobalSyncStore } from "./global-sync-store"

test("manual startup retries replace the stream epoch even without a bootstrap error", () => {
  const before = useGlobalSyncStore.getState()
  try {
    before.actions.set({ ready: true, error: undefined })
    before.actions.retryBootstrap()
    before.actions.retryBootstrap()
    const after = useGlobalSyncStore.getState()
    expect(after.bootstrapEpoch).toBe(before.bootstrapEpoch + 2)
    expect(after.ready).toBe(false)
    expect(after.error).toBeUndefined()
    expect(after.path).toBe(before.path)
    expect(after.projects).toBe(before.projects)
  } finally {
    useGlobalSyncStore.setState(before, true)
  }
})
