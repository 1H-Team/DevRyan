import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import {
    formatTaskModelLabel,
    normalizeTaskSummaryEntries,
    type TaskToolSummaryEntry,
} from './message/parts/taskToolUtils';

const CURSOR_NATIVE_TASK_SCHEMA_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

const readString = (...candidates: unknown[]): string => {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return '';
};

export type CursorNativeTaskStatus = 'running' | 'completed' | 'error' | 'cancelled';

export type CursorNativeTaskDispatch = {
    partId: string;
    callId: string;
    description: string;
    agent: string;
    model: unknown;
    modelLabel: string;
    status: CursorNativeTaskStatus;
    text: string;
    output: string;
    error?: unknown;
    entries: TaskToolSummaryEntry[];
    stepCount: number;
    truncated: boolean;
};

const normalizeStatus = (value: unknown): CursorNativeTaskStatus => {
    const status = readString(value).toLowerCase();
    if (status === 'completed' || status === 'complete' || status === 'success' || status === 'finished') {
        return 'completed';
    }
    if (status === 'error' || status === 'failed' || status === 'failure') {
        return 'error';
    }
    if (status === 'cancelled' || status === 'canceled') {
        return 'cancelled';
    }
    return 'running';
};

const readSubagentLabel = (input: Record<string, unknown>): string => {
    const camel = input.subagentType;
    const snake = input.subagent_type;
    const candidate = isRecord(camel) ? camel : (isRecord(snake) ? snake : null);
    return readString(
        candidate?.name,
        candidate?.kind,
        camel,
        snake,
        'Cursor subagent',
    );
};

export const resolveCursorNativeTaskDispatches = (
    parts: readonly unknown[],
): CursorNativeTaskDispatch[] => {
    const tasks: CursorNativeTaskDispatch[] = [];
    for (const candidate of parts) {
        if (!isRecord(candidate) || candidate.type !== 'tool') continue;
        const part = candidate as unknown as ToolPartType;
        if (readString(part.tool).toLowerCase() !== 'task') continue;

        const state: Record<string, unknown> = isRecord(part.state) ? part.state : {};
        const metadata = {
            ...(isRecord((part as unknown as Record<string, unknown>).metadata)
                ? (part as unknown as Record<string, unknown>).metadata as Record<string, unknown>
                : {}),
            ...(isRecord(state.metadata) ? state.metadata : {}),
        };
        const projection = isRecord(metadata.cursorNativeTask) ? metadata.cursorNativeTask : null;
        if (
            !projection
            || projection.schemaVersion !== CURSOR_NATIVE_TASK_SCHEMA_VERSION
            || projection.source !== 'cursor-native'
        ) continue;

        const input = isRecord((part as unknown as Record<string, unknown>).input)
            ? (part as unknown as Record<string, unknown>).input as Record<string, unknown>
            : (isRecord(state.input) ? state.input : {});
        const partId = readString((part as unknown as { id?: unknown }).id);
        const callId = readString(projection.parentCallId, (part as unknown as { callID?: unknown }).callID, partId);
        if (!partId || !callId) continue;

        const model = input.model;
        tasks.push({
            partId,
            callId,
            description: readString(input.description, input.prompt, 'Cursor subagent task'),
            agent: readSubagentLabel(input),
            model,
            modelLabel: formatTaskModelLabel(model),
            status: normalizeStatus(state.status),
            text: readString(projection.text),
            output: readString(
                (part as unknown as Record<string, unknown>).output,
                state.output,
            ),
            ...(state.error !== undefined ? { error: state.error } : {}),
            entries: normalizeTaskSummaryEntries(projection.entries),
            stepCount: typeof projection.stepCount === 'number' && Number.isFinite(projection.stepCount)
                ? Math.max(0, Math.floor(projection.stepCount))
                : 0,
            truncated: projection.truncated === true,
        });
    }
    return tasks;
};
