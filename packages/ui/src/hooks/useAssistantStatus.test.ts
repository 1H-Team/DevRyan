import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk/v2";

import {
    getAssistantActivePartStatus,
    hasAssistantStreamedActivity,
    selectAssistantStatusMessageId,
    selectAssistantStatusRecord,
} from "./useAssistantStatus";

const toolPart = (id: string, tool: string, status: string, action?: string): Part => ({
    id,
    sessionID: "ses_1",
    messageID: "msg_assistant",
    type: "tool",
    tool,
    state: {
        status,
        ...(action ? { input: { action } } : {}),
        time: {
            start: 1,
            ...(status === "completed" ? { end: 2 } : {}),
        },
    },
} as unknown as Part);

const textPart = (id: string, text: string, ended = false): Part => ({
    id,
    sessionID: "ses_1",
    messageID: "msg_assistant",
    type: "text",
    text,
    time: {
        start: 1,
        ...(ended ? { end: 2 } : {}),
    },
} as unknown as Part);

const reasoningPart = (id: string, text: string, ended = false): Part => ({
    id,
    sessionID: "ses_1",
    messageID: "msg_assistant",
    type: "reasoning",
    text,
    time: {
        start: 1,
        ...(ended ? { end: 2 } : {}),
    },
} as unknown as Part);

const message = (id: string, role: "user" | "assistant", finish?: string): Message => ({
    id,
    role,
    time: { created: 1 },
    ...(finish ? { finish } : {}),
} as unknown as Message);

describe("getAssistantActivePartStatus", () => {
    test("ignores older running search tools after newer completed work", () => {
        expect(getAssistantActivePartStatus([
            toolPart("grep_1", "grep", "running"),
            toolPart("read_1", "read", "completed"),
            toolPart("shell_1", "shell", "completed"),
        ])).toEqual({
            activePartType: undefined,
            activeToolName: undefined,
        });
    });

    test("keeps the latest running shell and edit tools specific", () => {
        expect(getAssistantActivePartStatus([
            toolPart("grep_1", "grep", "running"),
            toolPart("shell_1", "shell", "running"),
        ])).toEqual({
            activePartType: "tool",
            activeToolName: "shell",
        });

        expect(getAssistantActivePartStatus([
            toolPart("shell_1", "shell", "completed"),
            toolPart("edit_1", "edit", "running"),
        ])).toEqual({
            activePartType: "editing",
            activeToolName: "edit",
        });
    });

    test("exposes the active tool action for phase-aware managed dispatch copy", () => {
        expect(getAssistantActivePartStatus([
            toolPart("dispatch_1", "devryan_task", "running", "start"),
        ])).toEqual({
            activePartType: "tool",
            activeToolName: "devryan_task",
            activeToolAction: "start",
        });
    });

    test("keeps latest open text and reasoning parts active", () => {
        expect(getAssistantActivePartStatus([
            toolPart("read_1", "read", "completed"),
            textPart("text_1", "writing"),
        ])).toEqual({
            activePartType: "text",
            activeToolName: undefined,
        });

        expect(getAssistantActivePartStatus([
            textPart("text_1", "done", true),
            reasoningPart("reasoning_1", "thinking"),
        ])).toEqual({
            activePartType: "reasoning",
            activeToolName: undefined,
        });
    });

    test("reports no live part in the gap after a closed reasoning block", () => {
        expect(getAssistantActivePartStatus([
            reasoningPart("reasoning_1", "thought", true),
        ])).toEqual({
            activePartType: undefined,
            activeToolName: undefined,
        });
    });

    test("suppresses stale live part labels when the assistant message is terminal", () => {
        expect(getAssistantActivePartStatus([
            reasoningPart("reasoning_1", "thinking"),
            toolPart("edit_1", "edit", "running"),
        ], { isTerminalAssistantMessage: true })).toEqual({
            activePartType: undefined,
            activeToolName: undefined,
        });
    });
});

describe("hasAssistantStreamedActivity", () => {
    test("counts finished output so post-part gaps are not mistaken for a silent turn", () => {
        expect(hasAssistantStreamedActivity([reasoningPart("reasoning_1", "thought", true)])).toBe(true);
        expect(hasAssistantStreamedActivity([textPart("text_1", "done", true)])).toBe(true);
        expect(hasAssistantStreamedActivity([toolPart("read_1", "read", "completed")])).toBe(true);
        expect(hasAssistantStreamedActivity([toolPart("read_1", "read", "running")])).toBe(true);
    });

    test("counts any reasoning part, even closed and text-less (xai/Grok emits those)", () => {
        expect(hasAssistantStreamedActivity([reasoningPart("reasoning_1", "", true)])).toBe(true);
        expect(hasAssistantStreamedActivity([reasoningPart("reasoning_1", "   ", true)])).toBe(true);
        expect(hasAssistantStreamedActivity([reasoningPart("reasoning_1", "", false)])).toBe(true);
    });

    test("ignores empty text parts and empty part lists", () => {
        expect(hasAssistantStreamedActivity([textPart("text_1", "")])).toBe(false);
        expect(hasAssistantStreamedActivity([])).toBe(false);
        expect(hasAssistantStreamedActivity(undefined)).toBe(false);
    });
});

describe("assistant status message selection", () => {
    test("skips a trailing empty assistant shell when the previous assistant has renderable context", () => {
        const messages = [
            message("msg_user", "user"),
            message("msg_assistant_tools", "assistant", "tool-calls"),
            message("msg_assistant_empty", "assistant"),
        ];

        expect(selectAssistantStatusMessageId(messages, {
            msg_assistant_tools: [toolPart("edit_1", "edit", "running")],
            msg_assistant_empty: [],
        })).toBe("msg_assistant_tools");
    });

    test("keeps the trailing assistant selected once it has parts", () => {
        const messages = [
            message("msg_user", "user"),
            message("msg_assistant_tools", "assistant", "tool-calls"),
            message("msg_assistant_text", "assistant"),
        ];

        expect(selectAssistantStatusMessageId(messages, {
            msg_assistant_tools: [toolPart("edit_1", "edit", "completed")],
            msg_assistant_text: [textPart("text_1", "writing")],
        })).toBe("msg_assistant_text");
    });

    test("selects the record with renderable context for parsed status", () => {
        const selected = selectAssistantStatusRecord([
            {
                info: message("msg_user", "user"),
                parts: [],
            },
            {
                info: message("msg_assistant_tools", "assistant", "tool-calls"),
                parts: [toolPart("edit_1", "edit", "running")],
            },
            {
                info: message("msg_assistant_empty", "assistant"),
                parts: [],
            },
        ]);

        expect(selected?.info.id).toBe("msg_assistant_tools");
    });
});


describe('current prompt status isolation', () => {
    test('clears an old running wait immediately on send and while the new assistant is empty', () => {
        const old = message('old', 'assistant');
        const user = message('new-user', 'user');
        const records = [
            { info: old, parts: [toolPart('wait', 'devryan_task', 'running', 'wait')] },
            { info: user, parts: [] },
        ];
        expect(selectAssistantStatusRecord(records)).toBeNull();
        const empty = { info: message('new-assistant', 'assistant'), parts: [] };
        expect(selectAssistantStatusRecord([...records, empty])).toBe(empty);
    });

    test('rejects a late previous-turn event by parent and session identity', () => {
        const old = message('old', 'assistant');
        if (old.role !== 'assistant') throw new Error('Invalid fixture');
        old.parentID = 'previous-user';
        old.time.created = 20;
        const user = message('new-user', 'user');
        user.time.created = 10;
        expect(selectAssistantStatusRecord([
            { info: user, parts: [] },
            { info: old, parts: [toolPart('wait', 'devryan_task', 'running', 'wait')] },
        ])).toBeNull();
        old.parentID = user.id;
        old.sessionID = 'another-session';
        expect(selectAssistantStatusRecord([{ info: user, parts: [] }, { info: old, parts: [] }])).toBeNull();
    });
});


test('a failed skill yields activity to the next dispatch after live update or history reload', () => {
    const parts = [toolPart('skill', 'skill', 'error'), toolPart('dispatch', 'devryan_task', 'running', 'wait')];
    for (const restored of [parts, JSON.parse(JSON.stringify(parts))]) {
        expect(getAssistantActivePartStatus(restored)).toMatchObject({ activeToolName: 'devryan_task', activeToolAction: 'wait' });
    }
});
