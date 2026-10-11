import { expect, test } from "bun:test"
import { directoryBootstrapRequest } from "./directory-bootstrap-request"

test("bounds a hung transport, aborts it and records a bounded failure measure", async () => {
  let requestSignal: AbortSignal | undefined
  const result = directoryBootstrapRequest("sessions", signal => {
    requestSignal = signal
    return new Promise<never>(() => {})
  }, { timeoutMs: 10 })
  await expect(result).rejects.toThrow("sessions timed out")
  expect(requestSignal?.aborted).toBe(true)
  const measures = performance.getEntriesByName("devryan-directory-sessions", "measure")
  expect(measures).toHaveLength(1)
  expect((measures[0] as PerformanceMeasure).detail).toEqual({ outcome: "failed" })
})

test("cancels an obsolete attempt even when its transport ignores cancellation", async () => {
  const owner = new AbortController()
  const request = directoryBootstrapRequest("path", () => new Promise<never>(() => {}), { signal: owner.signal })
  owner.abort(new Error("superseded"))
  await expect(request).rejects.toThrow("superseded")
})

test("retains transient recovery within the request deadline", async () => {
  let attempts = 0
  const value = await directoryBootstrapRequest("config", async () => {
    if (++attempts === 1) throw Object.assign(new Error("unavailable"), { status: 503 })
    return "ready"
  })
  expect(value).toBe("ready")
  expect(attempts).toBe(2)
})
