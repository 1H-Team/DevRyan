import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { resolveViewedTrimStart, SessionHistory, VIEWED_TRIM_KEEP_PROMPTS, VIEWED_TRIM_MAX_RECORDS } from "./session-history"

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
const DIRECTORY = "/repo/viewed"
const SESSION = "ses_viewed"
const target = { directory: DIRECTORY, sessionID: SESSION }

// 40 turns: user u<n> then assistant a<n>, oldest first.
const history = Array.from({ length: 40 }, (_, turn) => [
  { id: `msg_${String(turn).padStart(3, "0")}_u`, sessionID: SESSION, role: "user", time: { created: turn * 10 + 1 } },
  { id: `msg_${String(turn).padStart(3, "0")}_a`, sessionID: SESSION, role: "assistant", parentID: `msg_${String(turn).padStart(3, "0")}_u`,
    time: { created: turn * 10 + 2, completed: turn * 10 + 3 }, finish: "stop" },
]).flat() as unknown as Message[]

const owners: Array<{ stores: ChildStoreManager; loader: SessionMessageLoader; owner: SessionHistory }> = []
const requests: Array<{ limit: number; before?: string }> = []

// Newest-first native pages: `v2:<n>` addresses the records before index n.
function setup() {
  const stores = new ChildStoreManager()
  const loader = new SessionMessageLoader(stores)
  const sdk = {
    session: {
      get: async () => ({ data: { id: SESSION, directory: DIRECTORY, title: "Viewed", time: { created: 1, updated: 1 } } as Session }),
      messages: async ({ limit, before }: { limit: number; before?: string }) => {
        requests.push({ limit, before })
        const end = before ? Number(before.slice(3)) : history.length
        const start = Math.max(0, end - limit)
        return {
          data: history.slice(start, end).map((info) => ({ info, parts: [{ id: `prt_${info.id}`, messageID: info.id, sessionID: SESSION, type: "text", text: info.id }] })),
          response: { headers: { get: (name: string) => name === "x-next-cursor" && start > 0 ? `v2:${start}` : null } },
        }
      },
    },
  } as unknown as OpencodeClient
  Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: () => sdk })
  const owner = new SessionHistory({ childStores: stores, loader, getSdk: () => sdk })
  owners.push({ stores, loader, owner })
  return { stores, loader, owner }
}

const retainedIds = (stores: ChildStoreManager) => stores.getChild(DIRECTORY)?.getState().message[SESSION]?.map((entry) => entry.id) ?? []

// Loads the whole history the way a reader scrolling up does.
async function loadEverything(owner: SessionHistory) {
  await owner.ensureRenderable(target, { reason: "selected" })
  while (owner.hasMore(target)) await owner.loadMore(target)
}

describe("viewed transcript trim", () => {
  beforeEach(() => {
    useFeatureFlagsStore.getState().setSessionFastLoadEnabled(true)
    requests.length = 0
  })

  afterEach(() => {
    for (const { stores, loader, owner } of owners.splice(0)) {
      owner.dispose()
      loader.dispose()
      stores.disposeAll()
    }
    Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: originalGetScopedSdkClient })
  })

  test("keeps whole turns for the newest prompts within the record bound", () => {
    const records = (prompts: number, repliesPerPrompt: number) => Array.from({ length: prompts }, (_, turn) => [
      { id: `u${turn}`, role: "user" },
      ...Array.from({ length: repliesPerPrompt }, (_, reply) => ({ id: `a${turn}_${reply}`, role: "assistant" })),
    ]).flat() as unknown as Message[]

    expect(resolveViewedTrimStart(records(VIEWED_TRIM_KEEP_PROMPTS, 3))).toBe(0)
    expect(resolveViewedTrimStart(records(VIEWED_TRIM_KEEP_PROMPTS + 5, 1))).toBe(10)
    // Fewer prompts when they would exceed the record bound.
    const heavy = records(4, 120)
    const start = resolveViewedTrimStart(heavy)
    expect(heavy[start]?.id).toBe("u2")
    expect(heavy.length - start).toBeLessThan(VIEWED_TRIM_MAX_RECORDS + 1)
    // The newest prompt stays even when it alone is over the bound.
    const huge = records(2, VIEWED_TRIM_MAX_RECORDS + 10)
    expect(huge[resolveViewedTrimStart(huge)]?.id).toBe("u1")
  })

  test("bounds a settled transcript and reloads the dropped history on demand", async () => {
    const { stores, loader, owner } = setup()
    await loadEverything(owner)
    expect(retainedIds(stores)).toHaveLength(80)

    expect(owner.trimViewedSession(target)).toBe(true)

    const kept = retainedIds(stores)
    expect(kept).toEqual(history.slice(60).map((entry) => entry.id))
    const state = stores.getChild(DIRECTORY)!.getState()
    expect(state.part[history[0]!.id]).toBeUndefined()
    expect(state.part[history[60]!.id]).toHaveLength(1)
    expect(owner.hasMore(target)).toBe(true)
    expect(loader.getSnapshot(target).tailAnchorMessageID).toBe(history[60]!.id)

    // Scrolling up walks to the anchor and restores what was dropped, in order.
    requests.length = 0
    await owner.loadMore(target)
    expect(requests.map((request) => request.before)).toEqual([undefined])
    expect(retainedIds(stores).slice(-20)).toEqual(kept)
    expect(retainedIds(stores).length).toBeGreaterThan(20)
    expect(loader.getSnapshot(target).tailAnchorMessageID).toBeUndefined()
    while (owner.hasMore(target)) await owner.loadMore(target)
    expect(retainedIds(stores)).toEqual(history.map((entry) => entry.id))
  })

  test("resumes below an anchor that ends a page exactly", async () => {
    const { stores, loader, owner } = setup()
    await loadEverything(owner)
    expect(owner.trimViewedSession(target)).toBe(true)
    // Make the newest page end exactly at the anchor.
    const limit = 20
    loader.trimToTail(target, history[60]!.id)
    const sdk = opencodeClient.getScopedSdkClient(DIRECTORY) as unknown as { session: { messages: (input: { limit: number; before?: string }) => Promise<unknown> } }
    const pageAt = sdk.session.messages
    sdk.session.messages = (input) => pageAt({ ...input, limit })
    requests.length = 0

    await owner.loadMore(target)

    expect(requests.map((request) => request.before)).toEqual([undefined, "v2:60"])
    expect(retainedIds(stores)).toEqual(history.slice(40).map((entry) => entry.id))
  })

  test("refuses to trim anything live, reverting or in flight", async () => {
    const { stores, loader, owner } = setup()
    await loadEverything(owner)
    const store = stores.getChild(DIRECTORY)!
    const settled = store.getState()
    const refusedWith = (patch: Partial<typeof settled>) => {
      store.setState({ ...settled, ...patch })
      return owner.trimViewedSession(target)
    }

    expect(refusedWith({ session_status: { [SESSION]: { type: "busy" } } })).toBe(false)
    expect(refusedWith({ question: { [SESSION]: [{ id: "q" }] } as unknown as typeof settled.question })).toBe(false)
    // An unfinished assistant: the stream may still be filling a gap.
    const live = { ...history[79]!, time: { created: 400 } } as unknown as Message
    expect(refusedWith({ message: { [SESSION]: [...settled.message[SESSION]!.slice(0, -1), live] } })).toBe(false)
    expect(refusedWith({ session: [{ id: SESSION, revert: { messageID: history[70]!.id } } as unknown as Session] })).toBe(false)
    expect(refusedWith({ revert_transaction: { [SESSION]: { status: "pending", messageID: history[70]!.id } } as unknown as typeof settled.revert_transaction })).toBe(false)
    store.setState(settled)

    const refreshing = loader.refreshTail(target)
    expect(loader.getSnapshot(target).status).toBe("loading")
    expect(owner.trimViewedSession(target)).toBe(false)
    await refreshing
    expect(loader.getSnapshot(target).status).toBe("ready")
    owner.optimisticAdd({ ...target, message: { id: "msg_zzz_u", sessionID: SESSION, role: "user", time: { created: 999 } } as unknown as Message, parts: [] })
    expect(owner.trimViewedSession(target)).toBe(false)

    expect(retainedIds(stores).filter((id) => id !== "msg_zzz_u")).toEqual(history.map((entry) => entry.id))
  })
})
