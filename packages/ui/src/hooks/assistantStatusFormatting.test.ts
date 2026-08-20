import { describe, expect, test } from "bun:test";

import { getAssistantToolStatusPhrase } from "./assistantStatusFormatting";

describe("getAssistantToolStatusPhrase", () => {
    test("formats MCP tool names through shared tool metadata", () => {
        expect(getAssistantToolStatusPhrase("linear_save_issue")).toBe("using Linear Save Issue");
        expect(getAssistantToolStatusPhrase("Linear_get_issue")).toBe("using Linear Get Issue");
        expect(getAssistantToolStatusPhrase("Linear_save_issue")).toBe("using Linear Save Issue");
    });

    test("prefixes Context Mode tool names", () => {
        expect(getAssistantToolStatusPhrase("ctx_execute_file")).toBe("using Context Mode: Execute File");
        expect(getAssistantToolStatusPhrase("mcp__context-mode__ctx_execute")).toBe("using Context Mode: Execute");
    });

    test("keeps built-in status phrases unchanged", () => {
        expect(getAssistantToolStatusPhrase("bash")).toBe("running command");
        expect(getAssistantToolStatusPhrase("apply_patch")).toBe("applying patch");
    });

    test("normalizes compatibility tool names before formatting status", () => {
        expect(getAssistantToolStatusPhrase("oc_bash")).toBe("running command");
        expect(getAssistantToolStatusPhrase("oc_read")).toBe("reading file");
    });

    test("uses the subagent waiting phrase for managed task tools case-insensitively", () => {
        expect(getAssistantToolStatusPhrase("devryan_task")).toBe("waiting for subagent output");
        expect(getAssistantToolStatusPhrase("DEVRYAN_TASK")).toBe("waiting for subagent output");
    });

    test("keeps managed browser activity generic", () => {
        expect(getAssistantToolStatusPhrase("devryan_browser")).toBe("using DevRyan Browser");
        expect(getAssistantToolStatusPhrase("DEVRYAN_BROWSER")).toBe("using DevRyan Browser");
    });

    test("matches built-in tool names case-insensitively", () => {
        expect(getAssistantToolStatusPhrase("Bash")).toBe("running command");
    });
});
