import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import {
  clearDirectoryMaterializations,
  createRestartSafeOwnershipCleanup,
  releaseDirectoryRoutingIndex,
  type DirectoryRoutingIndex,
} from "./directory-disposal"
import { INITIAL_STATE, type State } from "./types"

const session = (id: string, directory: string): Session => ({
  id,
  title: id,
  directory,
  time: { created: 1, updated: 1 },
} as Session)

const message = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "assistant",
  time: { created: 1 },
} as Message)

describe("directory sync disposal", () => {
  test("removes only routing entries owned by the disposed directory", () => {
    const routingIndex: DirectoryRoutingIndex = {
      sessionDirectoryById: new Map([
        ["session-a", "/repo/a"],
        ["session-a-orphan", "/repo/a"],
        ["session-b", "/repo/b"],
      ]),
      messageSessionById: new Map([
        ["message-a", "session-a"],
        ["message-a-orphan", "session-a-orphan"],
        ["message-b", "session-b"],
      ]),
      sessionMessageIdsById: new Map([
        ["session-a", new Set(["message-a"])],
        ["session-a-orphan", new Set(["message-a-orphan"])],
        ["session-b", new Set(["message-b"])],
      ]),
    }
    const snapshot: State = {
      ...INITIAL_STATE,
      session: [session("session-a", "/repo/a")],
      message: { "session-a": [message("message-a", "session-a")] },
    }

    const releasedSessionIds = releaseDirectoryRoutingIndex(routingIndex, "/repo/a", snapshot)

    expect(releasedSessionIds).toEqual(new Set(["session-a", "session-a-orphan"]))
    expect([...routingIndex.sessionDirectoryById.entries()]).toEqual([["session-b", "/repo/b"]])
    expect([...routingIndex.messageSessionById.entries()]).toEqual([["message-b", "session-b"]])
    expect([...routingIndex.sessionMessageIdsById.keys()]).toEqual(["session-b"])
  })

  test("clears retry timers for one directory without touching another", async () => {
    let disposedTimerFired = false
    let retainedTimerFired = false
    const disposedTimer = setTimeout(() => {
      disposedTimerFired = true
    }, 5)
    const retainedTimer = setTimeout(() => {
      retainedTimerFired = true
    }, 5)
    const pending = new Map([
      ["a", { directory: "/repo/a", retryTimer: disposedTimer }],
      ["b", { directory: "/repo/b", retryTimer: retainedTimer }],
    ])

    expect(clearDirectoryMaterializations(pending, "/repo/a")).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(disposedTimerFired).toBe(false)
    expect(retainedTimerFired).toBe(true)
    expect([...pending.keys()]).toEqual(["b"])
  })

  test("defers real unmount cleanup while ignoring a Strict Mode effect restart", () => {
    const scheduled: Array<() => void> = []
    let cleanupCount = 0
    const activate = createRestartSafeOwnershipCleanup(
      () => {
        cleanupCount += 1
      },
      (cleanup) => scheduled.push(cleanup),
    )

    const firstCleanup = activate()
    firstCleanup()
    const finalCleanup = activate()
    scheduled.shift()?.()
    expect(cleanupCount).toBe(0)

    finalCleanup()
    scheduled.shift()?.()
    expect(cleanupCount).toBe(1)
  })
})
