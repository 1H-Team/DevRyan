import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { bootstrapGlobal } from "./bootstrap"
import type { GlobalState } from "./types"

const originalFetch = globalThis.fetch

const failingSdk = (message = "Failed to fetch"): OpencodeClient => {
  const fail = async () => ({ error: { message } })
  return {
    path: { get: fail },
    global: { config: { get: fail } },
    project: { list: fail },
    provider: { list: fail },
  } as unknown as OpencodeClient
}

const successfulSdk = (pathReady = Promise.resolve()): OpencodeClient => ({
  path: { get: async () => { await pathReady; return { data: { state: "/state", config: "/config", worktree: "/", directory: "/", home: "/home" } } } },
  global: { config: { get: async () => ({ data: {} }) } },
  project: { list: async () => ({ data: [] }) },
  provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
} as unknown as OpencodeClient)

const capturePatches = () => {
  const patches: Array<Partial<GlobalState>> = []
  return {
    patches,
    set: (patch: Partial<GlobalState>) => {
      patches.push(patch)
    },
  }
}

describe("bootstrapGlobal", () => {
  test("keeps transient all-endpoint failures retryable when health has no terminal error", async () => {
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        openCodeRunning: true,
        lastOpenCodeError: null,
      }), { status: 200 })) as typeof fetch
      const { patches, set } = capturePatches()

      const result = await bootstrapGlobal(failingSdk(), set)

      expect(result).toEqual({ ready: false, retryable: true, error: "path.get failed: Failed to fetch" })
      expect(patches.at(-1)).toEqual({ ready: false, error: undefined })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("surfaces authoritative health failures instead of retrying forever", async () => {
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        openCodeRunning: true,
        lastOpenCodeError: "OpenCode crashed during startup",
      }), { status: 200 })) as typeof fetch
      const { patches, set } = capturePatches()

      const result = await bootstrapGlobal(failingSdk(), set)

      expect(result).toEqual({ ready: false, retryable: false, error: "OpenCode crashed during startup" })
      expect(patches.at(-1)).toEqual({ ready: true, error: { type: "init", message: "OpenCode crashed during startup" } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("marks global sync ready after successful requests", async () => {
    const { patches, set } = capturePatches()

    const result = await bootstrapGlobal(successfulSdk(), set)

    expect(result).toEqual({ ready: true, retryable: false })
    expect(patches.at(-1)).toEqual({ ready: true, error: undefined })
  })
})

test('a delayed native startup remains retryable even before its process exists', async () => {
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ openCodeRunning: false,
      openCodeStartup: { state: 'starting', attempt: 1, code: null } }))) as typeof fetch
    const { set, patches } = capturePatches()
    expect(await bootstrapGlobal(failingSdk('503 warming up'), set)).toMatchObject({ ready: false, retryable: true })
    expect(patches.at(-1)).toEqual({ ready: false, error: undefined })
    expect(await bootstrapGlobal(successfulSdk(), set)).toEqual({ ready: true, retryable: false })
  } finally { globalThis.fetch = originalFetch }
})

test('one transient path failure cannot publish global readiness', async () => {
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ openCodeRunning: true,
      openCodeStartup: { state: 'starting', attempt: 2, code: null } }))) as typeof fetch
    const sdk = successfulSdk()
    sdk.path.get = failingSdk('502 restarting').path.get
    const { set, patches } = capturePatches()
    expect(await bootstrapGlobal(sdk, set)).toMatchObject({ ready: false, retryable: true })
    expect(patches.at(-1)?.ready).toBe(false)
    expect(await bootstrapGlobal(successfulSdk(), set)).toMatchObject({ ready: true })
  } finally { globalThis.fetch = originalFetch }
})

test('cancelled global bootstrap cannot publish late snapshots or failure', async () => {
  const controller = new AbortController()
  let release!: () => void
  const sdk = successfulSdk(new Promise<void>(resolve => { release = resolve }))
  const { set, patches } = capturePatches()
  const pending = bootstrapGlobal(sdk, set, controller.signal).catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  const count = patches.length
  release()
  expect((await pending).name).toBe('AbortError')
  expect(patches.length).toBe(count)
})
