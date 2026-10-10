import { describe, expect, test } from "bun:test"

import {
  STARTUP_READINESS_PHASES,
  markStartupReadiness,
  createStartupReadinessSnapshot,
  recoverStartupInitialization,
  shouldShowStartupReadinessScreen,
  shouldRestartOpenCodeForStartupRecovery,
  summarizeStartupReadiness,
  withStartupBootstrapReadiness,
  withStartupReadinessPhase,
} from "./readiness"

describe("startup readiness", () => {
  test("timing is bounded across retries and never records error content or changes readiness", () => {
    const measured = new Set<string>()
    const failed = withStartupReadinessPhase(createStartupReadinessSnapshot("loading"), "providers", {
      status: "error", error: "private configuration content",
    })
    const before = summarizeStartupReadiness(failed)
    try {
      for (let retry = 0; retry < 100; retry++) markStartupReadiness(failed, measured)
      expect(measured.size).toBe(STARTUP_READINESS_PHASES.length)
      expect(summarizeStartupReadiness(failed)).toEqual(before)
      markStartupReadiness(createStartupReadinessSnapshot("ready"), measured)
      expect(measured.size).toBe(2 * STARTUP_READINESS_PHASES.length)
      for (const name of measured) {
        expect(name).not.toContain("private")
        expect(performance.getEntriesByName(name)).toHaveLength(1)
      }
    } finally {
      for (const name of measured) performance.clearMarks(name)
    }
  })

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

  test("surfaces provider failure after a healthy OpenCode connection", () => {
    const snapshot = withStartupBootstrapReadiness(createStartupReadinessSnapshot("ready"), {
      desktopBootReady: true,
      isConnected: true,
      isInitialized: false,
      retriesExhausted: false,
      providers: { status: "error", error: "Provider bootstrap failed" },
      agents: { status: "idle" },
      initialization: { status: "error", error: "Provider bootstrap failed" },
    })

    expect(summarizeStartupReadiness(snapshot)).toEqual({
      ready: false,
      phase: "providers",
      status: "error",
      error: "Provider bootstrap failed",
    })
  })

  test("surfaces unexpected initialization failure without downgrading health", () => {
    const snapshot = withStartupBootstrapReadiness(createStartupReadinessSnapshot("ready"), {
      desktopBootReady: true,
      isConnected: true,
      isInitialized: false,
      retriesExhausted: true,
      providers: { status: "ready" },
      agents: { status: "ready" },
      initialization: { status: "error", error: "Unexpected startup failure" },
    })

    expect(snapshot.health.status).toBe("ready")
    expect(summarizeStartupReadiness(snapshot)).toEqual({
      ready: false,
      phase: "initialization",
      status: "error",
      error: "Unexpected startup failure",
    })
  })

  test("turns an exhausted connection attempt into an actionable health error", () => {
    const snapshot = withStartupBootstrapReadiness(createStartupReadinessSnapshot("ready"), {
      desktopBootReady: true,
      isConnected: false,
      isInitialized: false,
      retriesExhausted: true,
      providers: { status: "idle" },
      agents: { status: "idle" },
      initialization: { status: "loading" },
    })

    expect(summarizeStartupReadiness(snapshot)).toEqual({
      ready: false,
      phase: "health",
      status: "error",
      error: "DevRyan could not connect to OpenCode.",
    })
  })

  test("names the server's reason when OpenCode could not start", () => {
    const snapshot = withStartupBootstrapReadiness(createStartupReadinessSnapshot("ready"), {
      desktopBootReady: true,
      isConnected: false,
      isInitialized: false,
      retriesExhausted: true,
      openCodeError: "  DEVRYAN_CURSOR_PLUGIN_CONFLICT: preserve the plugin ",
      providers: { status: "idle" },
      agents: { status: "idle" },
      initialization: { status: "loading" },
    })

    expect(summarizeStartupReadiness(snapshot).error).toBe(
      "DevRyan could not connect to OpenCode: DEVRYAN_CURSOR_PLUGIN_CONFLICT: preserve the plugin",
    )
  })

  test('a terminal startup failure wins over a stale connected event', () => {
    const snapshot = withStartupBootstrapReadiness(createStartupReadinessSnapshot('ready'), {
      desktopBootReady: true, isConnected: true, isInitialized: false, retriesExhausted: true,
      openCodeError: 'Native bootstrap failed', providers: { status: 'idle' }, agents: { status: 'idle' },
      initialization: { status: 'error', error: 'Native bootstrap failed' },
    })
    expect(summarizeStartupReadiness(snapshot).phase).toBe('health')
    expect(summarizeStartupReadiness(snapshot).error).toContain('Native bootstrap failed')
  })

  test("treats an empty session list as valid after the list request succeeds", () => {
    const snapshot = withStartupReadinessPhase(
      createStartupReadinessSnapshot("ready"),
      "sessionList",
      { status: "ready" },
    )

    expect(summarizeStartupReadiness(snapshot).ready).toBe(true)
  })

  test("requires runtime and workspace state, without optional prewarming", () => {
    expect(STARTUP_READINESS_PHASES).toEqual([
      "health", "providers", "agents", "initialization", "globalSync",
      "directorySync", "sessionList", "responseStyle", "worktree",
    ])
    expect(summarizeStartupReadiness(createStartupReadinessSnapshot("ready")).ready).toBe(true)
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

  test('Retry cancels the old startup owner before health/restart and starts a fresh owner only after restart settles', async () => {
    const calls: string[] = []
    let releaseRestart!: () => void
    const pending = recoverStartupInitialization({
      cancelInitialization: () => { calls.push('cancel') },
      loadHealth: async () => { calls.push('health'); return { isOpenCodeReady: false } },
      restartOpenCode: () => { calls.push('restart'); return new Promise<void>(resolve => { releaseRestart = resolve }) },
      initializeApp: async () => { calls.push('initialize') },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual(['cancel', 'health', 'restart'])
    releaseRestart()
    await pending
    expect(calls).toEqual(['cancel', 'health', 'restart', 'initialize'])
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

  test("restarts when OpenCode recorded a bootstrap error even if running flags are omitted", async () => {
    const calls: string[] = []

    const result = await recoverStartupInitialization({
      loadHealth: async () => ({
        lastOpenCodeError: "Managed orchestration is already owned by another DevRyan runtime using this data directory",
      }),
      restartOpenCode: async () => { calls.push("restart") },
      initializeApp: async () => { calls.push("initialize") },
    })

    expect(result).toEqual({ restartAttempted: true, restartError: null })
    expect(calls).toEqual(["restart", "initialize"])
    expect(shouldRestartOpenCodeForStartupRecovery({
      lastOpenCodeError: "Managed orchestration is already owned by another DevRyan runtime using this data directory",
    })).toBe(true)
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
