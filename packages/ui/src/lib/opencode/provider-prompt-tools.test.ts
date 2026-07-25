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

  test("keeps Orchestrator root prompts on the managed harness surface", () => {
    expect(resolveProviderPromptTools("openai", "orchestrator")).toEqual({
      task: false,
      invalid: false,
      "mcp__*": false,
      "resend_*": false,
    });
  });

  test("merges Copilot and Orchestrator restrictions", () => {
    expect(resolveProviderPromptTools("github-copilot", "orchestrator")).toEqual({
      "resend_*": false,
      "mcp__resend__*": false,
      task: false,
      invalid: false,
      "mcp__*": false,
    });
  });
});
