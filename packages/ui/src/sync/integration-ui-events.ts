/** Low-frequency, authenticated host integration effects. No transcript state. */
export const IMAGES_SKIPPED_MESSAGE = 'Observer agent is disabled, so images can\'t be analyzed. Set image_routing to "direct" to send images to your model, or enable observer.'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const INTERVIEW_PATH = /^\/api\/openchamber\/interviews\/[a-f0-9]{64}\/interview\/[A-Za-z0-9_-]{1,128}$/

type Dependencies = {
  origin: () => string
  canOpenBrowser: () => boolean
  supportsBrowserPanel: () => boolean
  openBrowserPanel: (directory: string, url: string) => void
  openExternal: (url: string) => Promise<boolean>
  imagesSkipped: (eventID: string) => void
  openBlocked: (eventID: string, retry: () => void) => void
}

export function createIntegrationUIEvents(deps: Dependencies) {
  const seen = new Map<string, string>()
  let active = true
  const open = async (directory: string, url: string, eventID: string) => {
    if (!active || !deps.canOpenBrowser()) return
    if (deps.supportsBrowserPanel()) { deps.openBrowserPanel(directory, url); return }
    const opened = await deps.openExternal(url)
    if (active && !opened) deps.openBlocked(eventID, () => { void open(directory, url, eventID) })
  }
  return {
    handle(directory: string, payload: unknown): boolean {
      if (!active || !record(payload) || payload.type !== 'openchamber:integration' || !record(payload.properties)) return false
      const p = payload.properties
      if (typeof directory !== 'string' || !directory || directory.length > 4096 || directory.includes('\0') || p.directory !== directory
        || typeof p.sessionID !== 'string' || !/^ses[A-Za-z0-9_-]{1,128}$/.test(p.sessionID)
        || typeof p.eventID !== 'string' || !UUID.test(p.eventID)) return false
      let url: string | undefined
      if (p.kind === 'images-skipped') {
        if (Object.keys(p).some(key => !['directory', 'sessionID', 'eventID', 'kind'].includes(key))) return false
      } else if (p.kind === 'interview-open') {
        if (Object.keys(p).some(key => !['directory', 'sessionID', 'eventID', 'kind', 'path'].includes(key))
          || typeof p.path !== 'string' || !INTERVIEW_PATH.test(p.path)) return false
        try {
          const origin = new URL(deps.origin())
          if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return false
          const target = new URL(p.path, origin.origin)
          if (target.origin !== origin.origin) return false
          url = target.href
        } catch { return false }
      } else return false
      if (seen.has(p.eventID)) return true
      seen.set(p.eventID, directory)
      while (seen.size > 512) seen.delete(seen.keys().next().value!)
      if (url) void open(directory, url, p.eventID)
      else deps.imagesSkipped(p.eventID)
      return true
    },
    releaseDirectory(directory: string) { for (const [id, owner] of seen) if (owner === directory) seen.delete(id) },
    dispose() { active = false; seen.clear() },
  }
}
