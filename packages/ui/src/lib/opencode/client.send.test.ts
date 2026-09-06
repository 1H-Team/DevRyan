import { beforeEach, describe, expect, mock, test } from "bun:test"

const waitForWorktreeBootstrapCalls: string[] = []
const fetchCalls: Array<{ url: string; init?: RequestInit; request?: Request }> = []
let waitForWorktreeBootstrapHandler: (directory: string) => Promise<void> = () => Promise.resolve()

mock.module("@/lib/worktrees/worktreeBootstrap", () => ({
  waitForWorktreeBootstrap: mock((directory: string) => {
    waitForWorktreeBootstrapCalls.push(directory)
    return waitForWorktreeBootstrapHandler(directory)
  }),
  waitForWorktreeBootstrapForSend: mock((directory: string) => {
    waitForWorktreeBootstrapCalls.push(directory)
    return waitForWorktreeBootstrapHandler(directory)
  }),
}))

;(globalThis as typeof globalThis & { window?: Window & typeof globalThis }).window = {
  location: {
    href: "http://127.0.0.1:5180/",
    origin: "http://127.0.0.1:5180",
  },
} as unknown as Window & typeof globalThis

const { createNoStoreApiFetch, opencodeClient, requestScopedSessionRevert } = await import("./client")

const getPromptBody = () => {
  const promptRequest = fetchCalls.find((call) => call.url.includes("/prompt_async"))
  return JSON.parse(String(promptRequest?.init?.body ?? "{}"))
}

describe("opencode client sends", () => {
  beforeEach(() => {
    waitForWorktreeBootstrapCalls.length = 0
    fetchCalls.length = 0
    waitForWorktreeBootstrapHandler = () => Promise.resolve()
    opencodeClient.setDirectory(undefined)
    opencodeClient.setContextModeAvailable(false)
    ;(opencodeClient as unknown as { baseUrl: string }).baseUrl = "http://127.0.0.1:5180/api"
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch
  })

  test("times out scoped reverts even when the fetch adapter ignores AbortSignal", async () => {
    let capturedSignal: AbortSignal | undefined
    const ignoredFetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as typeof fetch

    const startedAt = Date.now()
    let thrown: unknown = null
    try {
      await requestScopedSessionRevert({
        baseUrl: "http://127.0.0.1:5180/api",
        sessionId: "session-a",
        messageId: "msg-a",
        directory: "/repo/project",
        timeoutMs: 20,
        fetchImpl: ignoredFetch,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe("Scoped session revert timed out")
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(capturedSignal?.aborted).toBe(true)
    expect((capturedSignal?.reason as { code?: string } | undefined)?.code).toBe("SCOPED_REVERT_TIMEOUT")
  })

  test("keeps the scoped revert watchdog active while parsing the response", async () => {
    const stalledResponse = new Response("{}", { status: 200 })
    Object.defineProperty(stalledResponse, "json", {
      value: () => new Promise<never>(() => {}),
    })
    const stalledBodyFetch = mock(() => Promise.resolve(stalledResponse)) as typeof fetch

    const request = requestScopedSessionRevert({
      baseUrl: "http://127.0.0.1:5180/api",
      sessionId: "session-a",
      messageId: "msg-a",
      timeoutMs: 20,
      fetchImpl: stalledBodyFetch,
    }).then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )

    const outcome = await Promise.race([
      request,
      new Promise<string>((resolve) => setTimeout(() => resolve("body parser remained pending"), 200)),
    ])

    expect(outcome).toBe("Scoped session revert timed out")
  })

  test("forces generated SDK GET requests to bypass the browser HTTP cache", async () => {
    const noStoreFetch = createNoStoreApiFetch()
    const baseRequest = new Request("http://127.0.0.1:5180/api/session/session-a/message?limit=500", {
      headers: { accept: "application/json" },
    })

    await noStoreFetch(baseRequest)

    expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:5180/api/session/session-a/message?limit=500")
    expect(fetchCalls[0]?.request?.cache).toBe("no-store")
    expect(fetchCalls[0]?.init).toBe(undefined)
  })

  test("adds no-store cache mode to normal GET fetch inputs", async () => {
    const noStoreFetch = createNoStoreApiFetch()

    await noStoreFetch("http://127.0.0.1:5180/api/session")

    expect(fetchCalls[0]).toEqual({
      url: "http://127.0.0.1:5180/api/session",
      init: { cache: "no-store" },
    })
  })

  test("does not rewrite non-cacheable SDK requests", async () => {
    const noStoreFetch = createNoStoreApiFetch()
    const body = JSON.stringify({ text: "hello" })
    const request = new Request("http://127.0.0.1:5180/api/session/session-a/prompt_async", {
      method: "POST",
      body,
    })

    await noStoreFetch(request)

    expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:5180/api/session/session-a/prompt_async")
    expect(fetchCalls[0]?.request?.cache).toBe("default")
    expect(fetchCalls[0]?.init).toBe(undefined)
  })

  test("can request providers without the saved directory", async () => {
    opencodeClient.setDirectory("/projects/stale/main")
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      return Promise.resolve(new Response(JSON.stringify({ providers: [], default: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    }) as typeof fetch

    await opencodeClient.getProviders({ directory: null })

    const requestUrl = new URL(fetchCalls[0]?.url ?? "http://127.0.0.1:5180")
    expect(requestUrl.pathname).toBe("/api/config/providers")
    expect(requestUrl.searchParams.has("directory")).toBe(false)
  })

  test("leaves Cursor provider-default transport unchanged", async () => {
    await opencodeClient.sendMessage({
      id: "session-cursor", providerID: "cursor-acp", modelID: "composer", agent: "Builder", text: "hello", variant: null,
    })
    expect(Object.hasOwn(getPromptBody(), "variant")).toBe(false)
    await opencodeClient.sendCommand({
      id: "session-cursor", providerID: "cursor-acp", modelID: "composer", agent: "Builder", command: "check", variant: null,
    })
    const commandCall = fetchCalls.find((call) => call.url.includes("/command"))
    expect(commandCall).toBeDefined()
    const command = JSON.parse(String(commandCall?.init?.body))
    expect(Object.hasOwn(command, "variant")).toBe(false)
  })

  for (const variant of [undefined, null, "high"]) {
    test(`serializes captured thinking ${String(variant)} consistently for prompts and commands`, async () => {
      await opencodeClient.sendMessage({
        id: "session-thinking", providerID: "openai", modelID: "gpt", agent: "Builder", text: "hello", variant,
      })
      const prompt = getPromptBody()
      expect(Object.hasOwn(prompt, "variant")).toBe(variant !== undefined)
      expect(prompt.variant).toBe(variant === null ? "" : variant)

      await opencodeClient.sendCommand({
        id: "session-thinking", providerID: "openai", modelID: "gpt", agent: "Builder", command: "check", variant,
      })
      const command = JSON.parse(String(fetchCalls.find((call) => call.url.includes("/command"))?.init?.body ?? "{}"))
      expect(Object.hasOwn(command, "variant")).toBe(variant !== undefined)
      expect(command.variant).toBe(variant === null ? "" : variant)
    })
  }

  test("waits for worktree bootstrap before slash commands", async () => {
    await opencodeClient.sendCommand({
      id: "session-a",
      providerID: "provider-a",
      modelID: "model-a",
      command: "build",
      arguments: "now",
      directory: "/repo/project",
    })

    expect(waitForWorktreeBootstrapCalls).toEqual(["/repo/project"])
    expect(fetchCalls[0]?.url).toContain("/api/session/session-a/command")
    expect(fetchCalls[0]?.url).toContain("directory=%2Frepo%2Fproject")
  })

  test("rechecks send admission after stalled preflight before starting transport", async () => {
    let releaseBootstrap: (() => void) | undefined
    waitForWorktreeBootstrapHandler = () => new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    let revertPending = false

    const send = opencodeClient.sendMessage({
      id: "session-racing-revert",
      providerID: "openai",
      modelID: "gpt-5.6",
      text: "must not reach transport",
      directory: "/repo/project",
      beforeTransport: () => {
        if (revertPending) throw new Error("Cannot send while this chat is being reverted")
      },
    })
    while (!releaseBootstrap) {
      await Promise.resolve()
    }
    revertPending = true
    releaseBootstrap()

    let thrown: unknown = null
    try {
      await send
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe("Cannot send while this chat is being reverted")
    expect(fetchCalls).toHaveLength(0)
  })

  test("sends Cursor SDK prompts without workspace repair", async () => {
    await opencodeClient.sendMessage({
      id: "session-cursor",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      text: "what model are you",
      directory: "/repo/cursor",
    })

    expect(fetchCalls.some((call) => call.url.includes("/api/provider/cursor-acp/workspace"))).toBe(false)
    expect(fetchCalls[0]?.url).toContain("/api/session/session-cursor/prompt_async")
  })

  test("does not add Cursor ACP compatibility instructions to prompt sends", async () => {
    await opencodeClient.sendMessage({
      id: "session-cursor",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      text: "move these fields",
      directory: "/repo/cursor",
      additionalParts: [{ text: "plan mode instruction", synthetic: true }],
    })

    const promptRequest = fetchCalls.find((call) => call.url.includes("/prompt_async"))
    const body = JSON.parse(String(promptRequest?.init?.body ?? "{}"))

    const partTexts = body.parts.map((part: { text?: string }) => part.text)
    expect(partTexts).toEqual([
      "move these fields",
      "plan mode instruction",
    ])
    expect(JSON.stringify(body)).not.toContain("Cursor ACP compatibility instructions")
  })

  test("sends synthetic preface text before the visible user prompt", async () => {
    await opencodeClient.sendMessage({
      id: "session-openai",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "make a plan",
      prefaceText: "plan mode instruction",
      prefaceTextSynthetic: true,
      directory: "/repo/openai",
    })

    const body = getPromptBody()
    expect(body.parts.map((part: { text?: string }) => part.text)).toEqual([
      "plan mode instruction",
      "make a plan",
    ])
    expect(body.parts[0]?.synthetic).toBe(true)
  })

  test("does not repair workspace for non-Cursor prompt sends", async () => {
    await opencodeClient.sendMessage({
      id: "session-openai",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "hello",
      directory: "/repo/openai",
    })

    expect(fetchCalls.some((call) => call.url.includes("/api/provider/cursor-acp/workspace"))).toBe(false)
    expect(fetchCalls[0]?.url).toContain("/api/session/session-openai/prompt_async")
    const body = JSON.parse(String(fetchCalls[0]?.init?.body ?? "{}"))
    expect(body.parts.map((part: { text?: string }) => part.text)).toEqual(["hello"])
  })

  test("keeps GitHub Copilot prompts below the provider tool limit", async () => {
    await opencodeClient.sendMessage({
      id: "session-copilot",
      providerID: "github-copilot",
      modelID: "gpt-4.1",
      text: "hello",
      directory: "/repo/copilot",
    })

    expect(getPromptBody().tools).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
    })
  })

  test("keeps Orchestrator prompts on the managed harness surface and merges provider restrictions", async () => {
    await opencodeClient.sendMessage({
      id: "session-copilot-orchestrator",
      providerID: "github-copilot",
      modelID: "gpt-4.1",
      agent: "orchestrator",
      text: "delegate this",
      directory: "/repo/copilot",
    })

    expect(getPromptBody().tools).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
      task: false,
      invalid: false,
    })
  })

  test("does not restrict prompt tools for providers without a tool limit", async () => {
    await opencodeClient.sendMessage({
      id: "session-openai",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "hello",
      directory: "/repo/openai",
    })

    expect(getPromptBody().tools).toBe(undefined)
  })

  test("adds writable Context Mode grants to primary prompt transport", async () => {
    opencodeClient.setContextModeAvailable(true)

    await opencodeClient.sendMessage({
      id: "session-openai-context-mode",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "analyze the repository",
      directory: "/repo/openai",
    })

    expect(getPromptBody().tools).toEqual({
      ctx_execute: true,
      mcp__context_mode__ctx_execute: true,
      ctx_execute_file: true,
      mcp__context_mode__ctx_execute_file: true,
      ctx_batch_execute: true,
      mcp__context_mode__ctx_batch_execute: true,
      ctx_index: true,
      mcp__context_mode__ctx_index: true,
      ctx_search: true,
      mcp__context_mode__ctx_search: true,
      ctx_stats: true,
      mcp__context_mode__ctx_stats: true,
      ctx_fetch_and_index: true,
      mcp__context_mode__ctx_fetch_and_index: true,
      ctx_purge: false,
      mcp__context_mode__ctx_purge: false,
      ctx_upgrade: false,
      mcp__context_mode__ctx_upgrade: false,
      ctx_insight: false,
      mcp__context_mode__ctx_insight: false,
    })
  })

  test("applies the safe Plan Mode Context policy and fails closed on workspace indexing", async () => {
    await opencodeClient.sendMessage({
      id: "session-plan-unverified",
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "plan",
      text: "analyze the repository",
      planMode: true,
      directory: "/repo/openai",
    })

    const tools = getPromptBody().tools
    expect({
      ctx_execute: tools.ctx_execute,
      mcpExecute: tools.mcp__context_mode__ctx_execute,
      ctx_batch_execute: tools.ctx_batch_execute,
      mcpBatchExecute: tools.mcp__context_mode__ctx_batch_execute,
      ctx_search: tools.ctx_search,
      mcpSearch: tools.mcp__context_mode__ctx_search,
      ctx_fetch_and_index: tools.ctx_fetch_and_index,
      mcpFetchAndIndex: tools.mcp__context_mode__ctx_fetch_and_index,
      ctx_index: tools.ctx_index,
      mcpIndex: tools.mcp__context_mode__ctx_index,
    }).toEqual({
      ctx_execute: false,
      mcpExecute: false,
      ctx_batch_execute: false,
      mcpBatchExecute: false,
      ctx_search: false,
      mcpSearch: false,
      ctx_fetch_and_index: false,
      mcpFetchAndIndex: false,
      ctx_index: false,
      mcpIndex: false,
    })
  })

  test("allows Plan Mode workspace indexing after managed-runtime verification", async () => {
    opencodeClient.setContextModeAvailable(true)

    await opencodeClient.sendMessage({
      id: "session-plan-verified",
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "plan",
      text: "analyze the repository",
      planMode: true,
      directory: "/repo/openai",
    })

    const tools = getPromptBody().tools
    expect({
      ctx_index: tools.ctx_index,
      mcpIndex: tools.mcp__context_mode__ctx_index,
    }).toEqual({
      ctx_index: true,
      mcpIndex: true,
    })
  })

  test("updates the Context Mode capability from health and accepts the compatibility alias", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      isOpenCodeReady: true,
      contextModeReadOnlyIndexing: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))) as typeof fetch

    expect(await opencodeClient.checkHealth()).toBe(true)
    expect(opencodeClient.getContextModeAvailable()).toBe(true)

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      isOpenCodeReady: true,
      contextModeAvailable: false,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))) as typeof fetch

    expect(await opencodeClient.checkHealth()).toBe(true)
    expect(opencodeClient.getContextModeAvailable()).toBe(false)
  })

  test("re-resolves Plan Mode indexing permission for transport retries", async () => {
    opencodeClient.setContextModeAvailable(true)
    let attempt = 0
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      attempt += 1
      if (attempt === 1) {
        opencodeClient.setContextModeAvailable(false)
        return Promise.reject(new TypeError("temporary connection failure"))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch

    await opencodeClient.sendMessage({
      id: "session-plan-retry",
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "plan",
      text: "analyze the repository",
      planMode: true,
      directory: "/repo/openai",
    })

    const promptBodies = fetchCalls
      .filter((call) => call.url.includes("/prompt_async"))
      .map((call) => JSON.parse(String(call.init?.body ?? "{}")))
    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[0]?.tools?.ctx_index).toBe(true)
    expect(promptBodies[1]?.tools?.ctx_index).toBe(false)
  })

  test("sends active subtask follow-ups through the v2 immediate prompt endpoint", async () => {
    await opencodeClient.sendImmediateSubtaskPrompt({
      id: "session-child",
      text: "continue from here",
      directory: "/repo/subtask",
      files: [{
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,iVBORw0KGgo=",
      }],
      agentMentions: [{ name: "builder" }],
    })

    expect(waitForWorktreeBootstrapCalls).toEqual(["/repo/subtask"])
    expect(fetchCalls.some((call) => call.url.includes("/prompt_async"))).toBe(false)
    expect(fetchCalls[0]?.url).toContain("/api/session/session-child/prompt")
    expect(fetchCalls[0]?.url).toContain("directory=%2Frepo%2Fsubtask")
    const body = JSON.parse(String(fetchCalls[0]?.init?.body ?? "{}"))
    expect(body).toEqual({
      prompt: {
        text: "continue from here",
        files: [{
          uri: "data:image/png;base64,iVBORw0KGgo=",
          mime: "image/png",
          name: "screenshot.png",
        }],
        agents: [{ name: "builder" }],
      },
      delivery: "immediate",
    })
  })

  test("rejects active subtask follow-ups with synthetic hidden text", async () => {
    let error: unknown = null
    try {
      await opencodeClient.sendImmediateSubtaskPrompt({
        id: "session-child",
        text: "continue from here",
        directory: "/repo/subtask",
        additionalParts: [{ text: "hidden plan instructions", synthetic: true }],
      })
    } catch (caught) {
      error = caught
    }

    expect(error instanceof Error ? error.message : String(error)).toContain("Active subtask follow-ups do not support hidden synthetic text")

    expect(fetchCalls).toHaveLength(0)
  })

  test("preserves raw PDF file parts", async () => {
    await opencodeClient.sendMessage({
      id: "session-pdf",
      providerID: "openai",
      modelID: "gpt-pdf",
      text: "read this PDF",
      directory: "/repo/pdf",
      files: [{
        type: "file",
        mime: "application/pdf",
        filename: "document.pdf",
        url: "data:application/pdf;base64,JVBERi0xLjQ=",
      }],
    })

    const body = JSON.parse(String(fetchCalls[0]?.init?.body ?? "{}"))
    const pdfPart = body.parts.find((part: { type?: string; mime?: string }) =>
      part.type === "file" && part.mime === "application/pdf"
    )
    expect(pdfPart).toEqual({
      type: "file",
      mime: "application/pdf",
      filename: "document.pdf",
      url: "data:application/pdf;base64,JVBERi0xLjQ=",
    })
  })

  test("inlines local markdown data attachments as synthetic text parts", async () => {
    await opencodeClient.sendMessage({
      id: "session-md",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "use this export",
      directory: "/repo/markdown",
      files: [{
        type: "file",
        mime: "text/markdown",
        filename: "auth-email-carryover-plan-2026-06-23.md",
        url: "data:text/markdown;base64,IyBQbGFuCg==",
      }],
    })

    const body = getPromptBody()
    const fileParts = body.parts.filter((part: { type?: string }) => part.type === "file")
    const attachmentPart = body.parts.find((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic === true && String(part.text ?? "").includes("auth-email-carryover-plan-2026-06-23.md")
    )

    expect(fileParts).toEqual([])
    expect(body.parts[0]).toEqual({ type: "text", text: "use this export" })
    expect(body.parts[1]).toEqual({ type: "text", text: "Attached file: auth-email-carryover-plan-2026-06-23.md" })
    expect(attachmentPart?.type).toBe("text")
    expect(attachmentPart?.synthetic).toBe(true)
    expect(attachmentPart?.text).toContain("# Plan")
    expect(attachmentPart?.text).toContain("<file_content>")
  })

  test("adds a visible document summary when prompt text includes a local markdown attachment", async () => {
    await opencodeClient.sendMessage({
      id: "session-md-with-prompt",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "summarize this",
      directory: "/repo/markdown",
      files: [{
        type: "file",
        mime: "text/markdown",
        filename: "auth-email-carryover-plan-2026-06-23.md",
        url: "data:text/markdown;base64,IyBQbGFuCg==",
      }],
    })

    const body = getPromptBody()
    const fileParts = body.parts.filter((part: { type?: string }) => part.type === "file")
    const visibleSummaries = body.parts.filter((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic !== true && String(part.text ?? "").startsWith("Attached file:")
    )
    const syntheticAttachmentPart = body.parts.find((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic === true && String(part.text ?? "").includes("auth-email-carryover-plan-2026-06-23.md")
    )

    expect(fileParts).toEqual([])
    expect(body.parts[0]).toEqual({ type: "text", text: "summarize this" })
    expect(visibleSummaries).toEqual([
      { type: "text", text: "Attached file: auth-email-carryover-plan-2026-06-23.md" },
    ])
    expect(syntheticAttachmentPart?.text).toContain("<file_content>")
    expect(syntheticAttachmentPart?.text).toContain("# Plan")
  })

  test("adds visible summaries for multiple local text attachments", async () => {
    await opencodeClient.sendMessage({
      id: "session-multiple-text-files",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "compare these files",
      directory: "/repo/markdown",
      files: [
        {
          type: "file",
          mime: "text/markdown",
          filename: "notes.md",
          url: "data:text/markdown;base64,IyBOb3Rlcw==",
        },
        {
          type: "file",
          mime: "text/plain",
          filename: "requirements.txt",
          url: "data:text/plain;base64,UmVxdWlyZW1lbnRzCg==",
        },
      ],
    })

    const body = getPromptBody()
    const visibleSummaries = body.parts.filter((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic !== true && String(part.text ?? "").startsWith("Attached file:")
    )
    const syntheticAttachmentParts = body.parts.filter((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic === true && String(part.text ?? "").includes("<file_content>")
    )

    expect(visibleSummaries).toEqual([
      { type: "text", text: "Attached file: notes.md" },
      { type: "text", text: "Attached file: requirements.txt" },
    ])
    expect(syntheticAttachmentParts).toHaveLength(2)
    expect(syntheticAttachmentParts[0]?.text).toContain("# Notes")
    expect(syntheticAttachmentParts[1]?.text).toContain("Requirements")
  })

  test("classifies missing-MIME markdown data attachments by extension", async () => {
    await opencodeClient.sendMessage({
      id: "session-md-extension",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "read this",
      directory: "/repo/markdown",
      files: [{
        type: "file",
        mime: "",
        filename: "notes.md",
        url: "data:;base64,IyBOb3Rlcw==",
      }],
    })

    const body = getPromptBody()
    const fileParts = body.parts.filter((part: { type?: string }) => part.type === "file")
    const attachmentPart = body.parts.find((part: { text?: string; synthetic?: boolean }) =>
      part.synthetic === true && String(part.text ?? "").includes("notes.md")
    )

    expect(fileParts).toEqual([])
    expect(attachmentPart?.text).toContain("# Notes")
  })

  test("keeps server-resolved markdown attachments as file parts", async () => {
    await opencodeClient.sendMessage({
      id: "session-file-md",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "read this",
      directory: "/repo/markdown",
      files: [{
        type: "file",
        mime: "text/markdown",
        filename: "server-plan.md",
        url: "file:///repo/server-plan.md",
      }],
    })

    const body = getPromptBody()
    const filePart = body.parts.find((part: { type?: string; filename?: string }) =>
      part.type === "file" && part.filename === "server-plan.md"
    )

    expect(filePart).toEqual({
      type: "file",
      mime: "text/plain",
      filename: "server-plan.md",
      url: "file:///repo/server-plan.md",
    })
  })

  test("preserves image data attachments as file parts", async () => {
    await opencodeClient.sendMessage({
      id: "session-image",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "inspect this image",
      directory: "/repo/image",
      files: [{
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,iVBORw0KGgo=",
      }],
    })

    const body = getPromptBody()
    const imagePart = body.parts.find((part: { type?: string; mime?: string }) =>
      part.type === "file" && part.mime === "image/png"
    )

    expect(imagePart).toEqual({
      type: "file",
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    })
  })

  test("adds a visible summary when only text data attachments are sent", async () => {
    await opencodeClient.sendMessage({
      id: "session-attachment-only",
      providerID: "openai",
      modelID: "gpt-5.5",
      text: "",
      directory: "/repo/markdown",
      files: [{
        type: "file",
        mime: "text/markdown",
        filename: "only-plan.md",
        url: "data:text/markdown;base64,IyBQbGFuCg==",
      }],
    })

    const body = getPromptBody()

    expect(body.parts[0]).toEqual({
      type: "text",
      text: "Attached file: only-plan.md",
    })
    expect(body.parts[1]?.type).toBe("text")
    expect(body.parts[1]?.synthetic).toBe(true)
    expect(body.parts[1]?.text).toContain("# Plan")
  })

  test("does not call Cursor workspace repair across repeated sends", async () => {
    await opencodeClient.sendMessage({
      id: "session-cursor-a",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      text: "first",
      directory: "/repo/cached",
    })
    await opencodeClient.sendMessage({
      id: "session-cursor-b",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      text: "second",
      directory: "/repo/cached",
    })

    expect(fetchCalls.filter((call) => call.url.includes("/api/provider/cursor-acp/workspace"))).toHaveLength(0)
    expect(fetchCalls.filter((call) => call.url.includes("/prompt_async"))).toHaveLength(2)
  })

  test("returns null for direct session status fetch failures while wrappers coerce to empty maps", async () => {
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      return Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }))
    }) as typeof fetch

    expect(await opencodeClient.getSessionStatusForDirectory("/repo/project")).toBe(null)
    expect(await opencodeClient.getSessionStatus()).toEqual({})
    expect(await opencodeClient.getGlobalSessionStatus()).toEqual({})
  })

  test("bypasses browser cache for direct session status reads", async () => {
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      return Promise.resolve(new Response(JSON.stringify({ "session-a": { type: "idle" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
    }) as typeof fetch

    expect(await opencodeClient.getSessionStatusForDirectory("/repo/project")).toEqual({
      "session-a": { type: "idle" },
    })
    expect(fetchCalls[0]?.url).toContain("/api/session/status")
    expect(fetchCalls[0]?.url).toContain("directory=%2Frepo%2Fproject")
    expect(fetchCalls[0]?.init?.cache).toBe("no-store")
  })
})
