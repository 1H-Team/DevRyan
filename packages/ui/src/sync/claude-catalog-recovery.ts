/**
 * Claude's models come from Claude Code itself and reach OpenCode's catalog several
 * seconds after the claude-agent connection exists. A catalog read in that window
 * lists no Claude models and nothing announces their arrival, so a connected Claude
 * with no models re-reads its configuration scope until they are listed.
 */
export const CLAUDE_CATALOG_RECOVERY_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 4000, 5000, 8000, 10000]

export function createClaudeCatalogRecovery(deps: {
  /** Whether the scope's committed catalog lists at least one Claude model. */
  hasClaudeModels: (directory: string | null) => boolean
  /** Whether the claude-agent connection exists for the scope; a failed read is "no". */
  isConnected: (directory: string | null) => Promise<boolean>
  reload: (options: { directory: string | null; force: true }) => Promise<void>
  sleep?: (ms: number) => Promise<unknown>
  delays?: readonly number[]
}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const delays = deps.delays ?? CLAUDE_CATALOG_RECOVERY_DELAYS_MS
  const active = new Set<string>()
  return {
    /** Call after a catalog commit. Reloads issued here re-enter and return at once. */
    async check(directory: string | null): Promise<void> {
      const scope = directory ?? ''
      if (active.has(scope) || deps.hasClaudeModels(directory)) return
      active.add(scope)
      try {
        if (!await deps.isConnected(directory).catch(() => false)) return
        for (const delay of delays) {
          await sleep(delay)
          // A newer load may have listed the models while this one waited.
          if (deps.hasClaudeModels(directory)) return
          await deps.reload({ directory, force: true }).catch(() => {})
          if (deps.hasClaudeModels(directory)) return
        }
      } finally { active.delete(scope) }
    },
  }
}
