import { describe, expect, test } from "bun:test";
import { getToolMetadata } from "./toolHelpers";

describe("getToolMetadata", () => {
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
});
