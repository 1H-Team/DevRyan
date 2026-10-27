import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient, type Message, type Part, type ToolPart } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { isToolOutputOmitted, type OmittedToolOutputState } from "./tool-output"

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
const DIRECTORY = "/repo/tool-output"
const SESSION = "ses_tool_output"
const USER = "msg_0001_user"
const ASSISTANT = "msg_0002_assistant"

const userInfo: Message = { id: USER, sessionID: SESSION, role: "user", time: { created: 1 } } as Message
const assistantInfo: Message = {
  id: ASSISTANT, sessionID: SESSION, role: "assistant", parentID: USER, modelID: "m", providerID: "p", mode: "build",
  agent: "build", path: { cwd: DIRECTORY, root: DIRECTORY }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 },
} as Message
const userText: Part = { id: "prt_0001_text", sessionID: SESSION, messageID: USER, type: "text", text: "read the files" }
const read = (id: string, output: string): ToolPart => ({
  id, sessionID: SESSION, messageID: ASSISTANT, type: "tool", callID: `call_${id}`, tool: "read",
  state: { status: "completed", input: { filePath: `/repo/${id}.ts` }, output, title: id, metadata: {}, time: { start: 2, end: 3 } },
})
const omit = (part: ToolPart): ToolPart => {
  if (part.state.status !== "completed") throw new Error("fixture must be completed")
  const state: OmittedToolOutputState = { ...part.state, output: "", outputOmitted: true, outputBytes: part.state.output.length }
  return { ...part, state }
}
const fullReads = [read("prt_0002_a", "body a"), read("prt_0003_b", "body b")]

/** A real SDK client over a fake fetch that serves the DevRyan facade's two routes. */
const serveFacade = (options: { failMessage?: number } = {}) => {
  const requests: URL[] = []
  let messageFailures = options.failMessage ?? 0
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    requests.push(url)
    if (url.pathname === `/session/${SESSION}/message`) {
      const omitOutput = url.searchParams.get("toolOutput") === "omit"
      return Response.json([
        { info: userInfo, parts: [userText] },
        { info: assistantInfo, parts: omitOutput ? fullReads.map(omit) : fullReads },
      ])
    }
    if (url.pathname === `/session/${SESSION}/message/${ASSISTANT}`) {
      if (messageFailures > 0) {
        messageFailures -= 1
        return Response.json({ name: "NotFoundError", data: { message: "gone" } }, { status: 404 })
      }
      return Response.json({ info: assistantInfo, parts: fullReads })
    }
    return Response.json({ error: "unexpected" }, { status: 404 })
  }
  const sdk = createOpencodeClient({ baseUrl: "http://facade.test", fetch })
  Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: () => sdk })
  return { requests, messageReads: () => requests.filter((url) => url.pathname.endsWith(`/message/${ASSISTANT}`)).length }
}

afterEach(() => {
  Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: originalGetScopedSdkClient })
})

describe("history pages without finished tool output", () => {
  test("pages opt in, and expanding restores output by message id once", async () => {
    const { requests, messageReads } = serveFacade()
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    const target = { directory: DIRECTORY, sessionID: SESSION }
    try {
      await loader.ensure(target, { force: true })
      expect(requests[0].searchParams.get("toolOutput")).toBe("omit")
      const store = stores.getChild(DIRECTORY)!
      const trimmed = store.getState().part[ASSISTANT]
      expect(trimmed.every(isToolOutputOmitted)).toBe(true)
      const userParts = store.getState().part[USER]

      // Two rows of the same message expanded together share one read.
      await Promise.all([
        loader.loadToolOutput({ sessionID: SESSION, messageID: ASSISTANT }),
        loader.loadToolOutput({ sessionID: SESSION, messageID: ASSISTANT }),
      ])
      expect(messageReads()).toBe(1)
      const restored = store.getState().part[ASSISTANT]
      expect(restored.map((part) => part.type === "tool" && part.state.status === "completed" ? part.state.output : null))
        .toEqual(["body a", "body b"])
      expect(store.getState().part[USER]).toBe(userParts)

      // Nothing is left to restore, so a later expand reads nothing.
      await loader.loadToolOutput({ sessionID: SESSION, messageID: ASSISTANT })
      expect(messageReads()).toBe(1)

      // A tail refresh delivers trimmed parts again; the restored output stays.
      const pageReads = () => requests.filter((url) => url.pathname === `/session/${SESSION}/message`).length
      const before = pageReads()
      await loader.ensure(target, { force: true })
      expect(pageReads()).toBe(before + 1)
      expect(store.getState().part[ASSISTANT]).toBe(restored)
    } finally {
      loader.dispose()
      stores.disposeAll()
    }
  })

  test("a failed expand read leaves the row trimmed and can be retried", async () => {
    const { messageReads } = serveFacade({ failMessage: 1 })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    try {
      await loader.ensure({ directory: DIRECTORY, sessionID: SESSION }, { force: true })
      const store = stores.getChild(DIRECTORY)!
      await expect(loader.loadToolOutput({ sessionID: SESSION, messageID: ASSISTANT })).rejects.toThrow("session.message failed")
      expect(store.getState().part[ASSISTANT].every(isToolOutputOmitted)).toBe(true)
      await loader.loadToolOutput({ sessionID: SESSION, messageID: ASSISTANT })
      expect(messageReads()).toBe(2)
      expect(store.getState().part[ASSISTANT].some(isToolOutputOmitted)).toBe(false)
    } finally {
      loader.dispose()
      stores.disposeAll()
    }
  })
})
