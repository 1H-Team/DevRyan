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
});
