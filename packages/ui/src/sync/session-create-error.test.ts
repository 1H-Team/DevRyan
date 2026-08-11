import { describe, expect, test } from "bun:test"
import { createSessionCreateError, isTransientSessionCreateError } from "./session-actions"

describe("createSessionCreateError", () => {
  test("renders `{error: string}` bodies instead of [object Object]", () => {
    const error = createSessionCreateError({ error: "OpenCode service unavailable" }, 503)
    expect(error.message).toBe("session.create failed (503): OpenCode service unavailable")
  })

  test("renders restarting bodies and copies the flag", () => {
    const error = createSessionCreateError({ error: "OpenCode is restarting", restarting: true }, 503)
    expect(error.message).toBe("session.create failed (503): OpenCode is restarting")
    expect((error as Error & { restarting?: boolean }).restarting).toBe(true)
  })

  test("copies code, retryable, and status onto the error", () => {
    const error = createSessionCreateError(
      { error: "Identity service unavailable", code: "identity_unavailable", retryable: false },
      503,
    )
    expect(error.message).toBe("session.create failed (503): Identity service unavailable")
    const annotated = error as Error & { code?: string; retryable?: boolean; status?: number }
    expect(annotated.code).toBe("identity_unavailable")
    expect(annotated.retryable).toBe(false)
    expect(annotated.status).toBe(503)
  })

  test("keeps `{message: string}` and plain Error inputs unchanged", () => {
    expect(createSessionCreateError({ message: "boom" }, 500).message)
      .toBe("session.create failed (500): boom")
    expect(createSessionCreateError(new Error("boom")).message)
      .toBe("session.create failed: boom")
    expect(createSessionCreateError("returned no data").message)
      .toBe("session.create failed: returned no data")
  })
})

describe("isTransientSessionCreateError", () => {
  const wrap = (body: unknown, status?: number) => createSessionCreateError(body, status)

  test("identity_unavailable is never retried", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "Identity service unavailable", code: "identity_unavailable" }, 503),
    )).toBe(false)
  })

  test("explicit retryable: false wins over the transient fallback", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "nope", retryable: false }, 503),
    )).toBe(false)
  })

  test("restarting bodies are retried", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "OpenCode is restarting", restarting: true }, 503),
    )).toBe(true)
  })

  test("explicit retryable: true is retried", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "OpenCode service unavailable", retryable: true }, 503),
    )).toBe(true)
  })

  test("proxy-down 503 without flags is retried via the transient fallback", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "OpenCode service unavailable" }, 503),
    )).toBe(true)
  })

  test("harness-initializing 503 is retried", () => {
    expect(isTransientSessionCreateError(
      wrap({ error: "DevRyan harness is still initializing", code: "HARNESS_INITIALIZING" }, 503),
    )).toBe(true)
  })

  test("non-transient errors are not retried", () => {
    expect(isTransientSessionCreateError(wrap({ error: "invalid directory" }, 400))).toBe(false)
    expect(isTransientSessionCreateError(new Error("validation failed"))).toBe(false)
  })
})
