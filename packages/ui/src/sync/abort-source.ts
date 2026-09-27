import { ABORT_SOURCE_HEADER, type AbortSource } from "@openchamber/orchestration-runtime"

/**
 * Which UI path asked for a session abort. The shared contract lives in
 * @openchamber/orchestration-runtime (abort-sources.js); the server journals it
 * so an unexpected "Tool execution aborted" can be attributed after the fact.
 */
export type { AbortSource }
export { ABORT_SOURCE_HEADER }

export function abortSourceHeaders(source: AbortSource | undefined): { headers: Record<string, string> } | undefined {
  return source ? { headers: { [ABORT_SOURCE_HEADER]: source } } : undefined
}
