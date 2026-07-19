import { describe, expect, test } from "bun:test"

import {
  STARTUP_READINESS_PHASES,
  createStartupReadinessSnapshot,
  recoverStartupInitialization,
  shouldShowStartupReadinessScreen,
  shouldRestartOpenCodeForStartupRecovery,
  summarizeStartupReadiness,
  withStartupReadinessPhase,
} from "./readiness"

describe("startup readiness", () => {
  test("is ready only when every send-critical phase is ready", () => {
    const snapshot = createStartupReadinessSnapshot("ready")

    expect(summarizeStartupReadiness(snapshot).ready).toBe(true)

    for (const phase of STARTUP_READINESS_PHASES) {
      const blocked = withStartupReadinessPhase(snapshot, phase, { status: "loading" })
      expect(summarizeStartupReadiness(blocked).ready).toBe(false)
      expect(summarizeStartupReadiness(blocked).phase).toBe(phase)
    }
  })

  test("blocks on a transient failure and unblocks after a later success", () => {
    const failed = withStartupReadinessPhase(
      createStartupReadinessSnapshot("ready"),
      "agents",
      { status: "error", error: "OpenCode returned 503" },
    )

    const failedSummary = summarizeStartupReadiness(failed)
    expect(failedSummary.ready).toBe(false)
    expect(failedSummary.phase).toBe("agents")
    expect(failedSummary.error).toContain("OpenCode returned 503")

    const recovered = withStartupReadinessPhase(failed, "agents", { status: "ready" })
    expect(summarizeStartupReadiness(recovered).ready).toBe(true)
  })

  test("treats an empty session list as valid after the list request succeeds", () => {
    const snapshot = withStartupReadinessPhase(
      createStartupReadinessSnapshot("ready"),
      "sessionList",
      { status: "ready" },
    )

    expect(summarizeStartupReadiness(snapshot).ready).toBe(true)
  })

  test("blocks on chat runtime warmup before startup is complete", () => {
    const snapshot = withStartupReadinessPhase(
      createStartupReadinessSnapshot("ready"),
      "chatRuntime",
      { status: "loading" },
    )

    const summary = summarizeStartupReadiness(snapshot)

    expect(summary.ready).toBe(false)
    expect(summary.phase).toBe("chatRuntime")
    expect(summary.status).toBe("loading")
  })

  test("blocks on agent runtime warmup before startup is complete", () => {
    const snapshot = withStartupReadinessPhase(
      createStartupReadinessSnapshot("ready"),
      "agentRuntime",
      { status: "loading" },
    )

    const summary = summarizeStartupReadiness(snapshot)

    expect(summary.ready).toBe(false)
    expect(summary.phase).toBe("agentRuntime")
    expect(summary.status).toBe("loading")
  })

  test("allows non-main desktop boot views to bypass chat readiness", () => {
    const snapshot = createStartupReadinessSnapshot("idle")

    expect(summarizeStartupReadiness(snapshot, { route: "desktop-chooser" }).ready).toBe(true)
    expect(summarizeStartupReadiness(snapshot, { route: "desktop-recovery" }).ready).toBe(true)
    expect(summarizeStartupReadiness(snapshot, { route: "main" }).ready).toBe(false)
  })

  test("shows the startup screen only before startup has completed", () => {
    const loading = summarizeStartupReadiness(
      withStartupReadinessPhase(createStartupReadinessSnapshot("ready"), "sessionList", { status: "loading" }),
    )
    const ready = summarizeStartupReadiness(createStartupReadinessSnapshot("ready"))

    expect(shouldShowStartupReadinessScreen(loading, false)).toBe(true)
    expect(shouldShowStartupReadinessScreen(ready, false)).toBe(false)
    expect(shouldShowStartupReadinessScreen(loading, true)).toBe(false)
  })

  test("restarts a failed OpenCode runtime before retrying client initialization", async () => {
    const calls: string[] = []

    const result = await recoverStartupInitialization({
      loadHealth: async () => ({ openCodeRunning: false, isOpenCodeReady: false }),
      restartOpenCode: async () => { calls.push("restart") },
      initializeApp: async () => { calls.push("initialize") },
    })

    expect(result).toEqual({ restartAttempted: true, restartError: null })
    expect(calls).toEqual(["restart", "initialize"])
  })

  test("does not restart a healthy runtime during client-only recovery", async () => {
    const calls: string[] = []

    await recoverStartupInitialization({
      loadHealth: async () => ({ openCodeRunning: true, isOpenCodeReady: true }),
      restartOpenCode: async () => { calls.push("restart") },
      initializeApp: async () => { calls.push("initialize") },
    })

    expect(calls).toEqual(["initialize"])
    expect(shouldRestartOpenCodeForStartupRecovery(null)).toBe(false)
  })

  test("refreshes client state after a managed runtime restart failure", async () => {
    const restartError = new Error("restart failed")
    const calls: string[] = []

    const result = await recoverStartupInitialization({
      loadHealth: async () => ({ openCodeRunning: false }),
      restartOpenCode: async () => {
        calls.push("restart")
        throw restartError
      },
      initializeApp: async () => { calls.push("initialize") },
    })

    expect(result).toEqual({ restartAttempted: true, restartError })
    expect(calls).toEqual(["restart", "initialize"])
  })
})
