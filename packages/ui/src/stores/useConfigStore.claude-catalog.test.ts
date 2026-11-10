import { afterEach, expect, mock, test } from "bun:test"

let catalogs: unknown[] = []
const providerCalls: Array<{ directory?: string | null } | undefined> = []

const actualOpencodeClientModule = await import("@/lib/opencode/client")
mock.module("@/lib/opencode/client", () => ({
  ...actualOpencodeClientModule,
  opencodeClient: {
    setDirectory: () => {},
    getDirectory: () => "/repo",
    withDirectory: (_directory: string | undefined | null, fn: () => Promise<unknown>) => fn(),
    getProviders: async (options?: { directory?: string | null }) => {
      providerCalls.push(options)
      return catalogs.length > 1 ? catalogs.shift() : catalogs[0]
    },
    listAgentsStrict: async () => [],
    checkHealth: () => Promise.resolve(true),
    readHealth: () => Promise.resolve(null),
  },
}))

const { useConfigStore } = await import("./useConfigStore")

const provider = (id: string, models: string[]) => ({
  id, name: id, source: "api", env: [], options: {},
  models: Object.fromEntries(models.map(model => [model, { id: model, providerID: id, name: model }])),
})
const originalFetch = globalThis.fetch
const statusRequests: string[] = []
const answerClaudeStatus = (connected: boolean) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    // The store also fetches unrelated metadata; only Claude's status is under test.
    if (!String(input).includes("/provider/claude-agent/status")) return new Response("{}", { status: 404 })
    statusRequests.push(String(input))
    return new Response(JSON.stringify({ providerID: "claude-agent", available: true, connected }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}
const claudeModels = () => useConfigStore.getState().directoryScoped["/repo"]?.providers
  .find(entry => entry.id === "claude-agent")?.models.map(model => model.id)

afterEach(() => { globalThis.fetch = originalFetch; providerCalls.length = 0; statusRequests.length = 0 })

test("a connected Claude missing from the first catalog read is listed once its models arrive", async () => {
  answerClaudeStatus(true)
  catalogs = [
    { providers: [provider("openai", ["gpt"])], default: {} },
    { providers: [provider("openai", ["gpt"]), provider("claude-agent", ["opus", "sonnet"])], default: {} },
  ]
  await useConfigStore.getState().loadProviders({ directory: "/repo", force: true })
  expect(claudeModels()).toBeUndefined()
  const deadline = Date.now() + 15000
  while (!claudeModels() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  expect(claudeModels()).toEqual(["opus", "sonnet"])
  expect(providerCalls).toEqual([{ directory: "/repo" }, { directory: "/repo" }])
  expect(statusRequests).toEqual(["/api/provider/claude-agent/status?directory=%2Frepo"])
}, 20000)

test("a disconnected Claude causes no further catalog reads", async () => {
  answerClaudeStatus(false)
  catalogs = [{ providers: [provider("openai", ["gpt"])], default: {} }]
  await useConfigStore.getState().loadProviders({ directory: "/repo", force: true })
  await new Promise(resolve => setTimeout(resolve, 1300))
  expect(providerCalls).toEqual([{ directory: "/repo" }])
  expect(statusRequests).toHaveLength(1)
}, 20000)
