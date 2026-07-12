import { beforeEach, describe, expect, mock, test } from "bun:test"

const waitForWorktreeBootstrapCalls: string[] = []
const fetchCalls: Array<{ url: string; init?: RequestInit; request?: Request }> = []

mock.module("@/lib/worktrees/worktreeBootstrap", () => ({
  waitForWorktreeBootstrap: mock((directory: string) => {
    waitForWorktreeBootstrapCalls.push(directory)
    return Promise.resolve()
  }),
}))

;(globalThis as typeof globalThis & { window?: Window & typeof globalThis }).window = {
  location: {
    href: "http://127.0.0.1:5180/",
    origin: "http://127.0.0.1:5180",
  },
} as unknown as Window & typeof globalThis

const { createNoStoreApiFetch, opencodeClient } = await import("./client")

const getPromptBody = () => {
  const promptRequest = fetchCalls.find((call) => call.url.includes("/prompt_async"))
  return JSON.parse(String(promptRequest?.init?.body ?? "{}"))
}

describe("opencode client sends", () => {
  beforeEach(() => {
    waitForWorktreeBootstrapCalls.length = 0
    fetchCalls.length = 0
    opencodeClient.setDirectory(undefined)
    ;(opencodeClient as unknown as { baseUrl: string }).baseUrl = "http://127.0.0.1:5180/api"
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const request = typeof Request !== "undefined" && url instanceof Request ? url : undefined
      fetchCalls.push({ url: request?.url ?? String(url), init, request })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch
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
