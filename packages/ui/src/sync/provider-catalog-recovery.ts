const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Catalog success invalidates only the visible configuration scope. */
export function createProviderCatalogRecovery(deps: {
  directory: () => string
  loadProviders: (options: { directory: string | null; force: true }) => Promise<void>
}) {
  const pending = new Map<string, Promise<void>>()
  let active = true
  return {
    handle(directory: string, payload: unknown): boolean {
      if (!active || !record(payload) || payload.type !== 'devryan:provider-catalog' || !record(payload.properties)) return false
      const p = payload.properties
      if (Object.keys(p).some(key => !['providerID', 'directory', 'source'].includes(key))
        || p.providerID !== 'cursor-acp' || p.source !== 'sdk' || typeof p.directory !== 'string'
        || p.directory.length > 4096 || p.directory.trim() !== p.directory || p.directory.includes('\0')) return false
      const scope = p.directory
      if (directory !== scope && !(scope === '' && directory === 'global')) return false
      if (deps.directory() !== scope) return false
      if (pending.has(scope)) return true
      const operation = Promise.resolve().then(async () => {
        if (!active || deps.directory() !== scope) return
        // Supersede any fallback response still in flight when success arrives.
        await deps.loadProviders({ directory: scope || null, force: true })
      }).catch(() => {}).finally(() => { pending.delete(scope) })
      pending.set(scope, operation)
      return true
    },
    dispose() { active = false; pending.clear() },
  }
}
