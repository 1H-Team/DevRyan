import { describe, expect, test } from "bun:test"

;(globalThis as typeof globalThis & { window?: Window & typeof globalThis }).window = {
  location: {
    href: "http://127.0.0.1:5180/",
    origin: "http://127.0.0.1:5180",
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as Window & typeof globalThis

const { resolveSubmitPromptTools } = await import("./submit")

const input = {
  agent: "plan",
  model: { providerID: "openai", modelID: "gpt-5.5" },
  planMode: true,
}

describe("alternate SDK prompt tool transport", () => {
  test("preserves Plan Mode while failing closed on unavailable Context Mode", () => {
    const tools = resolveSubmitPromptTools(input, false)

    expect({
      execute: tools?.ctx_execute,
      mcpExecute: tools?.mcp__context_mode__ctx_execute,
      search: tools?.ctx_search,
      mcpSearch: tools?.mcp__context_mode__ctx_search,
      index: tools?.ctx_index,
      mcpIndex: tools?.mcp__context_mode__ctx_index,
    }).toEqual({
      execute: false,
      mcpExecute: false,
      search: false,
      mcpSearch: false,
      index: false,
      mcpIndex: false,
    })
  })

  test("opens only the safe read-only Context Mode surface for the verified capability", () => {
    const tools = resolveSubmitPromptTools(input, true)

    expect(tools?.ctx_index).toBe(true)
    expect(tools?.mcp__context_mode__ctx_index).toBe(true)
    expect(tools?.ctx_search).toBe(true)
    expect(tools?.mcp__context_mode__ctx_search).toBe(true)
    expect(tools?.ctx_execute).toBe(false)
    expect(tools?.mcp__context_mode__ctx_execute).toBe(false)
  })

  test("opens writable Context Mode for primary SDK submissions", () => {
    const tools = resolveSubmitPromptTools({ ...input, agent: "builder", planMode: false }, true)

    expect({
      ctx_execute: tools?.ctx_execute,
      mcp__context_mode__ctx_execute: tools?.mcp__context_mode__ctx_execute,
      ctx_execute_file: tools?.ctx_execute_file,
      mcp__context_mode__ctx_execute_file: tools?.mcp__context_mode__ctx_execute_file,
      ctx_batch_execute: tools?.ctx_batch_execute,
      mcp__context_mode__ctx_batch_execute: tools?.mcp__context_mode__ctx_batch_execute,
      ctx_index: tools?.ctx_index,
      mcp__context_mode__ctx_index: tools?.mcp__context_mode__ctx_index,
      ctx_search: tools?.ctx_search,
      mcp__context_mode__ctx_search: tools?.mcp__context_mode__ctx_search,
    }).toEqual({
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
    })
  })
})
