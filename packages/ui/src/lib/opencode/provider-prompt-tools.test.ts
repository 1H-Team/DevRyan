import { describe, expect, test } from "bun:test";
import { resolveProviderPromptTools } from "./provider-prompt-tools";

describe("resolveProviderPromptTools", () => {
  test("keeps GitHub Copilot prompts below the provider tool limit", () => {
    expect(resolveProviderPromptTools("github-copilot")).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
    });
  });

  test("supports the legacy Copilot provider alias", () => {
    expect(resolveProviderPromptTools("  COPILOT ")).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
    });
  });

  test("does not change the tool surface for other providers", () => {
    expect(resolveProviderPromptTools("openai")).toBe(undefined);
    expect(resolveProviderPromptTools("cursor-acp")).toBe(undefined);
  });

  test("keeps managed delegation root-owned without hiding plugins or MCP tools", () => {
    expect(resolveProviderPromptTools("openai", "orchestrator")).toEqual({
      task: false,
      invalid: false,
    });
  });

  test("merges Copilot and Orchestrator restrictions", () => {
    expect(resolveProviderPromptTools("github-copilot", "orchestrator")).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
      task: false,
      invalid: false,
    });
  });

  test("withholds unavailable Context Mode tools without a wildcard deny", () => {
    const tools = resolveProviderPromptTools("openai", "orchestrator", { planMode: true });

    expect({
      task: tools?.task,
      invalid: tools?.invalid,
      ctx_execute: tools?.ctx_execute,
      mcpExecute: tools?.mcp__context_mode__ctx_execute,
      ctx_batch_execute: tools?.ctx_batch_execute,
      mcpBatchExecute: tools?.mcp__context_mode__ctx_batch_execute,
      ctx_search: tools?.ctx_search,
      mcpSearch: tools?.mcp__context_mode__ctx_search,
      ctx_fetch_and_index: tools?.ctx_fetch_and_index,
      mcpFetchAndIndex: tools?.mcp__context_mode__ctx_fetch_and_index,
      ctx_index: tools?.ctx_index,
      mcpIndex: tools?.mcp__context_mode__ctx_index,
    }).toEqual({
      task: false,
      invalid: false,
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
    });
    expect(tools?.["*"]).toBe(undefined);
  });

  test("opens the safe read-only Context Mode surface for a verified managed runtime", () => {
    const tools = resolveProviderPromptTools("openai", "plan", {
      planMode: true,
      contextModeAvailable: true,
    });
    expect({
      ctx_index: tools?.ctx_index,
      mcpIndex: tools?.mcp__context_mode__ctx_index,
      ctx_search: tools?.ctx_search,
      mcpSearch: tools?.mcp__context_mode__ctx_search,
    }).toEqual({
      ctx_index: true,
      mcpIndex: true,
      ctx_search: true,
      mcpSearch: true,
    });
  });

  test("opens writable Context Mode tools in both naming forms", () => {
    const tools = resolveProviderPromptTools("openai", "orchestrator", {
      contextModeAvailable: true,
    });
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
      ctx_stats: tools?.ctx_stats,
      mcp__context_mode__ctx_stats: tools?.mcp__context_mode__ctx_stats,
      ctx_fetch_and_index: tools?.ctx_fetch_and_index,
      mcp__context_mode__ctx_fetch_and_index: tools?.mcp__context_mode__ctx_fetch_and_index,
      ctx_purge: tools?.ctx_purge,
      mcp__context_mode__ctx_purge: tools?.mcp__context_mode__ctx_purge,
      ctx_upgrade: tools?.ctx_upgrade,
      mcp__context_mode__ctx_upgrade: tools?.mcp__context_mode__ctx_upgrade,
      ctx_insight: tools?.ctx_insight,
      mcp__context_mode__ctx_insight: tools?.mcp__context_mode__ctx_insight,
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
    });
  });

  test("preserves Copilot caps while adding the Plan Mode Context policy", () => {
    const tools = resolveProviderPromptTools("github-copilot", "orchestrator", {
      planMode: true,
      contextModeAvailable: true,
    });
    expect({
      resend: tools?.["resend_*"],
      mcpResend: tools?.["mcp__resend__*"],
      task: tools?.task,
      invalid: tools?.invalid,
      ctx_execute_file: tools?.ctx_execute_file,
      ctx_search: tools?.ctx_search,
    }).toEqual({
      resend: false,
      mcpResend: false,
      task: false,
      invalid: false,
      ctx_execute_file: false,
      ctx_search: true,
    });
  });
});
