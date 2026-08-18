export const STARTUP_READINESS_PHASES = [
  "health",
  "providers",
  "agents",
  "initialization",
  "globalSync",
  "directorySync",
  "sessionList",
  "responseStyle",
  "worktree",
  "agentRuntime",
  "chatRuntime",
] as const

export type StartupReadinessPhase = typeof STARTUP_READINESS_PHASES[number]
export type StartupPhaseStatus = "idle" | "loading" | "ready" | "error"
export type StartupRoute = "main" | "desktop-chooser" | "desktop-recovery"

export interface StartupPhaseSnapshot {
  status: StartupPhaseStatus
  error?: string | null
}

export type StartupReadinessSnapshot = Record<StartupReadinessPhase, StartupPhaseSnapshot>

export interface StartupReadinessOptions {
  route?: StartupRoute
}

export interface StartupReadinessSummary {
  ready: boolean
  phase?: StartupReadinessPhase
  status?: StartupPhaseStatus
  error?: string
}

export interface StartupRecoveryHealth {
  openCodeRunning?: unknown
  isOpenCodeReady?: unknown
  lastOpenCodeError?: unknown
}

export interface StartupBootstrapReadiness {
  desktopBootReady: boolean
  isConnected: boolean
  isInitialized: boolean
  retriesExhausted: boolean
  providers: StartupPhaseSnapshot
  agents: StartupPhaseSnapshot
  initialization: StartupPhaseSnapshot
}

export interface StartupRecoveryDependencies {
  loadHealth: () => Promise<StartupRecoveryHealth | null>
  restartOpenCode?: () => Promise<unknown>
  initializeApp: () => Promise<void>
}

export interface StartupRecoveryResult {
  restartAttempted: boolean
  restartError: unknown | null
}

const clonePhase = (phase: StartupPhaseSnapshot): StartupPhaseSnapshot => ({
  status: phase.status,
  error: phase.error ?? null,
})

export const createStartupReadinessSnapshot = (
  status: StartupPhaseStatus = "idle",
): StartupReadinessSnapshot => STARTUP_READINESS_PHASES.reduce((snapshot, phase) => {
  snapshot[phase] = { status, error: null }
  return snapshot
}, {} as StartupReadinessSnapshot)

export const withStartupReadinessPhase = (
  snapshot: StartupReadinessSnapshot,
  phase: StartupReadinessPhase,
  next: StartupPhaseSnapshot,
): StartupReadinessSnapshot => ({
  ...snapshot,
  [phase]: clonePhase(next),
})

export const withStartupBootstrapReadiness = (
  snapshot: StartupReadinessSnapshot,
  readiness: StartupBootstrapReadiness,
): StartupReadinessSnapshot => {
  let next = snapshot
  const healthReady = readiness.desktopBootReady && readiness.isConnected
  next = withStartupReadinessPhase(next, "health", healthReady
    ? { status: "ready" }
    : readiness.desktopBootReady && readiness.retriesExhausted
      ? { status: "error", error: "DevRyan could not connect to OpenCode." }
      : { status: "loading" })
  next = withStartupReadinessPhase(next, "providers", readiness.providers)
  next = withStartupReadinessPhase(next, "agents", readiness.agents)
  next = withStartupReadinessPhase(next, "initialization", readiness.isInitialized
    ? { status: "ready" }
    : readiness.initialization.status === "error"
      ? readiness.initialization
      : { status: "loading" })
  return next
}

export const summarizeStartupReadiness = (
  snapshot: StartupReadinessSnapshot,
  options?: StartupReadinessOptions,
): StartupReadinessSummary => {
  if (options?.route === "desktop-chooser" || options?.route === "desktop-recovery") {
    return { ready: true }
  }

  for (const phase of STARTUP_READINESS_PHASES) {
    const item = snapshot[phase]
    if (item.status === "error") {
      return {
        ready: false,
        phase,
        status: item.status,
        error: item.error || "Startup failed.",
      }
    }
    if (item.status !== "ready") {
      return { ready: false, phase, status: item.status }
    }
  }

  return { ready: true }
}

export const shouldShowStartupReadinessScreen = (
  summary: StartupReadinessSummary,
  hasCompletedStartup: boolean,
): boolean => !hasCompletedStartup && !summary.ready

export const shouldRestartOpenCodeForStartupRecovery = (
  health: StartupRecoveryHealth | null,
): boolean => {
  if (!health) return false
  if (health.openCodeRunning === false || health.isOpenCodeReady === false) return true
  return typeof health.lastOpenCodeError === "string" && health.lastOpenCodeError.trim().length > 0
}

export const recoverStartupInitialization = async (
  dependencies: StartupRecoveryDependencies,
): Promise<StartupRecoveryResult> => {
  let health: StartupRecoveryHealth | null = null
  try {
    health = await dependencies.loadHealth()
  } catch {
    // If DevRyan's health route is unavailable, retain the existing client-only retry.
  }

  const restartAttempted = Boolean(
    dependencies.restartOpenCode
    && shouldRestartOpenCodeForStartupRecovery(health),
  )
  let restartError: unknown | null = null

  if (restartAttempted) {
    try {
      await dependencies.restartOpenCode?.()
    } catch (error) {
      restartError = error
    }
  }

  // Always retry client initialization so the recovery screen refreshes its
  // authoritative error even when the managed runtime restart fails.
  await dependencies.initializeApp()

  return { restartAttempted, restartError }
}
