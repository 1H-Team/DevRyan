import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import {
  clearSyncRefs,
  getSyncChildStores,
  getSyncDirectory,
  setSyncRefs,
} from "./sync-refs"

describe("sync imperative ref ownership", () => {
  test("only the owning provider can release module-level SDK and store refs", () => {
    const owner = new ChildStoreManager()
    const other = new ChildStoreManager()
    setSyncRefs({} as OpencodeClient, owner, "/owner")

    expect(clearSyncRefs(other)).toBe(false)
    expect(getSyncChildStores()).toBe(owner)
    expect(getSyncDirectory()).toBe("/owner")

    expect(clearSyncRefs(owner)).toBe(true)
    expect(() => getSyncChildStores()).toThrow("ChildStoreManager not initialized")
    expect(getSyncDirectory()).toBe("")
  })
})
