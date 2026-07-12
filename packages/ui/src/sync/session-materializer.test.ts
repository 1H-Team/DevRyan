import { describe, expect, test } from "bun:test"
import {
  ARCHIVED_OFFLOAD_TTL_MS,
  cancelArchivedOffload,
  ensureSessionMaterialized,
  getMaterializationState,
  loadOlderMessages,
  markArchived,
  markUnarchived,
  offloadArchivedSessionNow,
  getSessionMaterializerDirectoryRetainedCountsForTest,
  registerSessionMaterializer,
  releaseSessionMaterializerDirectory,
} from "./session-materializer"

describe("session-materializer", () => {
  test("uses a 20 minute archived offload TTL", () => {
    expect(ARCHIVED_OFFLOAD_TTL_MS).toBe(20 * 60 * 1000)
  })

  test("materializes first page through the registered directory loader", async () => {
    const calls: string[] = []
    const unregister = registerSessionMaterializer("/materializer/project", {
      ensureFirstPage: async (sessionID) => {
        calls.push(sessionID)
      },
      loadOlderMessages: async () => undefined,
      offloadSession: () => undefined,
    })

    await ensureSessionMaterialized("ses_materialize", "/materializer/project")

    expect(calls).toEqual(["ses_materialize"])
    expect(getMaterializationState("ses_materialize", "/materializer/project").level).toBe("firstPageLoaded")
    unregister()
  })

  test("loads older messages through the registered target directory loader", async () => {
    const calls: string[] = []
    const unregister = registerSessionMaterializer("/materializer/other-project", {
      ensureFirstPage: async () => undefined,
      loadOlderMessages: async (sessionID) => {
        calls.push(sessionID)
      },
      offloadSession: () => undefined,
    })

    await loadOlderMessages("ses_other", "/materializer/other-project")

    expect(calls).toEqual(["ses_other"])
    unregister()
  })

  test("offloads archived sessions without losing summary state", () => {
    const offloaded: string[] = []
    const unregister = registerSessionMaterializer("/archive/project", {
      ensureFirstPage: async () => undefined,
      loadOlderMessages: async () => undefined,
      offloadSession: (sessionID) => {
        offloaded.push(sessionID)
      },
    })

    markArchived("ses_archived", "/archive/project")
    offloadArchivedSessionNow("ses_archived", "/archive/project")

    expect(offloaded).toEqual(["ses_archived"])
    expect(getMaterializationState("ses_archived", "/archive/project").level).toBe("summaryOnly")
    unregister()
  })

  test("unarchive cancels offload and starts materialization", async () => {
    const calls: string[] = []
    const unregister = registerSessionMaterializer("/unarchive/project", {
      ensureFirstPage: async (sessionID) => {
        calls.push(sessionID)
      },
      loadOlderMessages: async () => undefined,
      offloadSession: () => undefined,
    })

    markArchived("ses_unarchive", "/unarchive/project")
    markUnarchived("ses_unarchive", "/unarchive/project")
    await ensureSessionMaterialized("ses_unarchive", "/unarchive/project")

    expect(calls).toEqual(["ses_unarchive", "ses_unarchive"])
    expect(getMaterializationState("ses_unarchive", "/unarchive/project").archived).toBe(false)
    cancelArchivedOffload("ses_unarchive", "/unarchive/project")
    unregister()
  })

  test("releases callbacks, state, and archived timers for only the disposed directory", async () => {
    const callbacks = {
      ensureFirstPage: async () => undefined,
      loadOlderMessages: async () => undefined,
      offloadSession: () => undefined,
    }
    registerSessionMaterializer("/release/a", callbacks)
    registerSessionMaterializer("/release/b", callbacks)
    await ensureSessionMaterialized("ses_a", "/release/a")
    await ensureSessionMaterialized("ses_b", "/release/b")
    markArchived("ses_a", "/release/a")
    markArchived("ses_b", "/release/b")

    releaseSessionMaterializerDirectory("/release/a")

    expect(getSessionMaterializerDirectoryRetainedCountsForTest("/release/a")).toEqual({
      callbacks: 0,
      states: 0,
      timers: 0,
    })
    expect(getSessionMaterializerDirectoryRetainedCountsForTest("/release/b")).toEqual({
      callbacks: 1,
      states: 1,
      timers: 1,
    })

    releaseSessionMaterializerDirectory("/release/b")
  })

  test("does not let a late materialization completion recreate disposed state", async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    registerSessionMaterializer("/release/late", {
      ensureFirstPage: () => pending,
      loadOlderMessages: async () => undefined,
      offloadSession: () => undefined,
    })

    const materializing = ensureSessionMaterialized("ses_late", "/release/late")
    releaseSessionMaterializerDirectory("/release/late")
    resolve()
    await materializing

    expect(getSessionMaterializerDirectoryRetainedCountsForTest("/release/late")).toEqual({
      callbacks: 0,
      states: 0,
      timers: 0,
    })
  })
})
