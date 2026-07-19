import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"

const respondCalls: Array<{ sessionID: string; requestID: string; reply: string }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const fetchCalls: Array<{ url: string; body: unknown }> = []
const PERMISSION_STORE_KEY = "permission-store"
let listPendingPermissionsError: unknown = null
let listPendingPermissionsResponse: Array<{ id: string; sessionID?: string }> = []
let sessions: Session[] = []
let permissionMap: Record<string, Array<{ id: string; sessionID?: string }>> = {}

mock.module("@/sync/sync-refs", () => ({
  getAllSyncSessions: () => sessions,
  getSyncChildStores: () => ({
    children: new Map([
      ["/repo", { getState: () => ({ permission: permissionMap }) }],
    ]),
  }),
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/repo",
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (listPendingPermissionsError) throw listPendingPermissionsError
      return listPendingPermissionsResponse
    }),
  },
}))

mock.module("@/sync/session-actions", () => ({
  respondToPermission: mock(async (sessionID: string, requestID: string, reply: string) => {
    respondCalls.push({ sessionID, requestID, reply })
  }),
}))

mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => "/repo",
    }),
  },
}))

const { usePermissionStore } = await import("./permissionStore")
const { getSafeStorage } = await import("./utils/safeStorage")

type PermissionStoreWithCleanup = ReturnType<typeof usePermissionStore.getState> & {
  clearSessionAutoAccept?: (sessionId: string) => Promise<void>
}

describe("permissionStore auto-accept", () => {
  beforeEach(() => {
    respondCalls.length = 0
    listPendingPermissionsCalls.length = 0
    fetchCalls.length = 0
    listPendingPermissionsError = null
    listPendingPermissionsResponse = []
    sessions = [{ id: "session-a", title: "Session", time: { created: 1, updated: 1 } } as Session]
    permissionMap = { "session-a": [{ id: "perm-1", sessionID: "session-a" }] }
    usePermissionStore.setState({ autoAccept: {} })
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      fetchCalls.push({ url: String(input), body: rawBody })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch
  })

  test("still responds to sync-store pending permissions when the pending API fails", async () => {
    listPendingPermissionsError = new Error("pending list unavailable")

    await usePermissionStore.getState().setSessionAutoAccept("session-a", true)

    expect(respondCalls).toEqual([
      { sessionID: "session-a", requestID: "perm-1", reply: "once" },
    ])
  })

  test("auto-responds to API-listed pending permissions for descendant sessions", async () => {
    sessions = [
      { id: "parent", title: "Parent", time: { created: 1, updated: 1 } } as Session,
      { id: "child", parentID: "parent", title: "Child", time: { created: 1, updated: 1 } } as Session,
    ]
    permissionMap = {}
    listPendingPermissionsResponse = [{ id: "perm-api", sessionID: "child" }]

    await usePermissionStore.getState().setSessionAutoAccept("parent", true)

    expect(respondCalls).toEqual([
      { sessionID: "child", requestID: "perm-api", reply: "once" },
    ])
    expect(listPendingPermissionsCalls).toHaveLength(1)
    expect(fetchCalls.map((call) => call.body)).toEqual([
      { sessionId: "parent", enabled: true },
      { sessionId: "child", enabled: true },
    ])
  })

  test("disabling auto-accept mirrors scope but does not respond to pending permissions", async () => {
    sessions = [
      { id: "parent", title: "Parent", time: { created: 1, updated: 1 } } as Session,
      { id: "child", parentID: "parent", title: "Child", time: { created: 1, updated: 1 } } as Session,
    ]
    permissionMap = { child: [{ id: "perm-child", sessionID: "child" }] }
    listPendingPermissionsResponse = [{ id: "perm-api", sessionID: "child" }]

    await usePermissionStore.getState().setSessionAutoAccept("parent", false)

    expect(respondCalls).toEqual([])
    expect(listPendingPermissionsCalls).toHaveLength(0)
    expect(fetchCalls.map((call) => call.body)).toEqual([
      { sessionId: "parent", enabled: false },
      { sessionId: "child", enabled: false },
    ])
  })

  test("removes only the permanently deleted session from persisted auto-accept state", async () => {
    const deletedSessionID = "session-delete"
    const retainedEnabledSessionID = "session-keep-enabled"
    const retainedDisabledSessionID = "session-keep-disabled"
    usePermissionStore.setState({
      autoAccept: {
        [deletedSessionID]: true,
        [retainedEnabledSessionID]: true,
        [retainedDisabledSessionID]: false,
      },
    })
    const store = usePermissionStore.getState() as PermissionStoreWithCleanup

    expect(typeof store.clearSessionAutoAccept).toBe("function")
    await store.clearSessionAutoAccept?.(deletedSessionID)

    expect(usePermissionStore.getState().autoAccept).toEqual({
      [retainedEnabledSessionID]: true,
      [retainedDisabledSessionID]: false,
    })
    const persisted = getSafeStorage().getItem(PERMISSION_STORE_KEY)
    expect(persisted).not.toContain(deletedSessionID)
    expect(persisted).toContain(retainedEnabledSessionID)
    expect(persisted).toContain(retainedDisabledSessionID)
    expect(fetchCalls.at(-1)?.body).toEqual({ sessionId: deletedSessionID, enabled: false })
  })

  test("orders deletion disable after an older in-flight enable mirror", async () => {
    const sessionID = "session-mirror-race"
    sessions = [{ id: sessionID, title: "Race", time: { created: 1, updated: 1 } } as Session]
    permissionMap = {}
    let resolveEnable: ((response: Response) => void) | undefined
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      fetchCalls.push({ url: String(input), body: rawBody })
      if (fetchCalls.length === 1) {
        return new Promise<Response>((resolve) => {
          resolveEnable = resolve
        })
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch

    await usePermissionStore.getState().setSessionAutoAccept(sessionID, true)
    const store = usePermissionStore.getState() as PermissionStoreWithCleanup
    expect(typeof store.clearSessionAutoAccept).toBe("function")
    const clearPromise = store.clearSessionAutoAccept?.(sessionID) ?? Promise.resolve()

    expect(fetchCalls.map((call) => call.body)).toEqual([
      { sessionId: sessionID, enabled: true },
    ])

    resolveEnable?.(new Response(null, { status: 204 }))
    await clearPromise

    expect(fetchCalls.map((call) => call.body)).toEqual([
      { sessionId: sessionID, enabled: true },
      { sessionId: sessionID, enabled: false },
    ])
    expect(usePermissionStore.getState().autoAccept).toEqual({})
  })
})
