import { describe, expect, test } from "bun:test";
import { getToolMetadata } from "./toolHelpers";

describe("getToolMetadata", () => {
  test("covers the current built-in and orchestration presentation families", () => {
    const expectedNames = new Map([
      ["read", "Read File"],
      ["apply_patch", "Apply Patch"],
      ["bash", "Shell Command"],
      ["skill", "Loading Skill:"],
      ["question", "Question"],
      ["plan_enter", "Plan Mode"],
      ["plan_exit", "Build Mode"],
      ["todowrite", "Update Todo List:"],
      ["structuredoutput", "Structured Output"],
      ["StructuredOutput", "Structured Output"],
      ["council", "Council"],
      ["devryan_task", "Devryan Task"],
      ["gpt_imagegen", "GPT Image Generation"],
    ])

    for (const [tool, displayName] of expectedNames) {
      expect(getToolMetadata(tool).displayName).toBe(displayName)
    }
  })

  test("labels skill tool activity as loading a skill", () => {
    expect(getToolMetadata("skill").displayName).toBe("Loading Skill:");
  });

  test("labels task tool activity as a subagent task", () => {
    expect(getToolMetadata("task").displayName).toBe("Subagent Task:");
  });

  test("labels todo updates with a separator before the task count", () => {
    expect(getToolMetadata("todowrite").displayName).toBe("Update Todo List:");
  });

  test("formats canonical MCP tool names without the transport prefix", () => {
    expect(getToolMetadata("mcp__resend__list_emails").displayName).toBe("Resend List Emails");
    expect(getToolMetadata("mcp__linear__get_issue").displayName).toBe("Linear Get Issue");
  });

  test("formats unknown tool names with title-cased words", () => {
    expect(getToolMetadata("Linear_get_issue").displayName).toBe("Linear Get Issue");
    expect(getToolMetadata("linear_save_issue").displayName).toBe("Linear Save Issue");
    expect(getToolMetadata("custom_tool").displayName).toBe("Custom Tool");
  });

  test("prefixes direct Context Mode tool names", () => {
    expect(getToolMetadata("ctx_execute_file").displayName).toBe("Context Mode: Execute File");
    expect(getToolMetadata("ctx_execute").displayName).toBe("Context Mode: Execute");
    expect(getToolMetadata("ctx_future_action").displayName).toBe("Context Mode: Future Action");
  });

  test("prefixes canonical MCP-wrapped Context Mode tool names", () => {
    expect(getToolMetadata("mcp__context-mode__ctx_execute_file").displayName).toBe("Context Mode: Execute File");
    expect(getToolMetadata("mcp__context_mode__ctx_execute").displayName).toBe("Context Mode: Execute");
  });
});
