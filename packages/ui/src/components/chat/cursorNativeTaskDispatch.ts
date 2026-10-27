import { isRecord, readTrimmedString, type UnknownRecord } from '@/lib/decoders/guards';
import {
    formatTaskModelLabel,
    normalizeTaskSummaryEntries,
    type TaskToolSummaryEntry,
} from './message/parts/taskToolUtils';

const CURSOR_NATIVE_TASK_SCHEMA_VERSION = 1;

const readString = readTrimmedString;

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
        const part = candidate;
        if (readString(part.tool).toLowerCase() !== 'task') continue;

        // Metadata merges both levels, the tool state's winning.
        const state: UnknownRecord = isRecord(part.state) ? part.state : {};
        const metadata = {
            ...(isRecord(part.metadata) ? part.metadata : {}),
            ...(isRecord(state.metadata) ? state.metadata : {}),
        };
        const projection = isRecord(metadata.cursorNativeTask) ? metadata.cursorNativeTask : null;
        if (
            !projection
            || projection.schemaVersion !== CURSOR_NATIVE_TASK_SCHEMA_VERSION
            || projection.source !== 'cursor-native'
        ) continue;

        const input = isRecord(part.input)
            ? part.input
            : (isRecord(state.input) ? state.input : {});
        const partId = readString(part.id);
        const callId = readString(projection.parentCallId, part.callID, partId);
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
            output: readString(part.output, state.output),
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
