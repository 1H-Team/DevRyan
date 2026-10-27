import { isTransientError, retry } from "./retry"

type DirectoryBootstrapRequest = "project" | "providers" | "config" | "path" | "status" | "sessions"

/** Bound the whole retry sequence, including a transport that never settles. */
export async function directoryBootstrapRequest<T>(
  name: DirectoryBootstrapRequest,
  request: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const startedAt = performance.now()
  const timer = setTimeout(() => controller.abort(new Error(`Preparing directory: ${name} timed out. Retry to reconnect.`)), options.timeoutMs ?? 30_000)
  let onAbort: (() => void) | undefined
  let outcome = "failed"
  try {
    signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const work = retry(() => {
      signal.throwIfAborted()
      return request(signal)
    }, { retryIf: error => !signal.aborted && isTransientError(error) })
    const result = await Promise.race([work, aborted])
    outcome = "completed"
    return result
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener("abort", onAbort)
    const measure = `devryan-directory-${name}`
    performance.clearMeasures(measure)
    performance.measure(measure, { start: startedAt, end: performance.now(), detail: { outcome } })
  }
}
