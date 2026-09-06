import { getSafeStorage } from '@/stores/utils/safeStorage';
export const streamDebugEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return getSafeStorage().getItem('openchamber_stream_debug') === '1';
    } catch {
        return false;
    }
};

export const sessionStatusDebugEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return getSafeStorage().getItem('openchamber_session_status_debug') === '1';
    } catch {
        return false;
    }
};

const STREAM_PERF_STORAGE_KEY = 'openchamber_stream_perf';

type PerfCounter = {
    count: number;
    total: number;
    max: number;
    last: number;
};

type StreamPerfState = {
    counters: Map<string, PerfCounter>;
    startedAt: number;
    lastUpdatedAt: number;
};

export type StreamPerfEntry = {
    metric: string;
    count: number;
    avg: number;
    max: number;
    total: number;
    last: number;
};

export type StreamPerfSnapshot = {
    enabled: boolean;
    startedAt: number | null;
    lastUpdatedAt: number | null;
    durationMs: number;
    entries: StreamPerfEntry[];
};

declare global {
    interface Window {
        __openchamberStreamPerfState?: StreamPerfState;
        __openchamberResponsivenessPerfState?: StreamPerfState;

    }
}

export const streamPerfEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return getSafeStorage().getItem(STREAM_PERF_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

const nowMs = (): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
};

const ensureStreamPerfState = (): StreamPerfState | null => {
    if (!streamPerfEnabled() || typeof window === 'undefined') {
        return null;
    }

    if (!window.__openchamberStreamPerfState) {
        const startedAt = Date.now();
        window.__openchamberStreamPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt,
            lastUpdatedAt: startedAt,
        };
    }

    return window.__openchamberStreamPerfState;
};

const ensureResponsivenessPerfState = (): StreamPerfState | null => {
    if (!streamPerfEnabled() || typeof window === 'undefined') {
        return null;
    }

    if (!window.__openchamberResponsivenessPerfState) {
        const startedAt = Date.now();
        window.__openchamberResponsivenessPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt,
            lastUpdatedAt: startedAt,
        };
    }

    return window.__openchamberResponsivenessPerfState;
};

const normalizePerfEntries = (counters: Map<string, PerfCounter>): StreamPerfEntry[] => {
    return Array.from(counters.entries())
        .map(([metric, bucket]) => ({
            metric,
            count: bucket.count,
            avg: bucket.count > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
            max: Number(bucket.max.toFixed(3)),
            total: Number(bucket.total.toFixed(3)),
            last: Number(bucket.last.toFixed(3)),
        }))
        .sort((a, b) => b.total - a.total || b.count - a.count);
};

const updateCounter = (state: StreamPerfState | null, metric: string, amount: number): void => {
    if (!state) {
        return;
    }

    const bucket = state.counters.get(metric) ?? { count: 0, total: 0, max: 0, last: 0 };
    bucket.count += 1;
    bucket.total += amount;
    bucket.max = Math.max(bucket.max, amount);
    bucket.last = amount;
    state.counters.set(metric, bucket);
    state.lastUpdatedAt = Date.now();
};

const updatePerfCounter = (metric: string, amount: number): void => {
    updateCounter(ensureStreamPerfState(), metric, amount);
};

const updateResponsivenessPerfCounter = (metric: string, amount: number): void => {
    updateCounter(ensureResponsivenessPerfState(), `responsiveness.${metric}`, amount);
};

export const setStreamPerfEnabled = (enabled: boolean): void => {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        if (enabled) {
            getSafeStorage().setItem(STREAM_PERF_STORAGE_KEY, '1');
            window.__openchamberStreamPerfState = {
                counters: new Map<string, PerfCounter>(),
                startedAt: Date.now(),
                lastUpdatedAt: Date.now(),
            };
            window.__openchamberResponsivenessPerfState = {
                counters: new Map<string, PerfCounter>(),
                startedAt: Date.now(),
                lastUpdatedAt: Date.now(),
            };
            return;
        }

        getSafeStorage().removeItem(STREAM_PERF_STORAGE_KEY);
        delete window.__openchamberStreamPerfState;
        delete window.__openchamberResponsivenessPerfState;
    } catch {
        // ignore storage failures in debug helper
    }
};

export const resetStreamPerf = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    if (streamPerfEnabled()) {
        window.__openchamberStreamPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
        };
        window.__openchamberResponsivenessPerfState = {
            counters: new Map<string, PerfCounter>(),
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
        };
    }

};

export const getStreamPerfSnapshot = (): StreamPerfSnapshot => {
    if (typeof window === 'undefined') {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    const state = window.__openchamberStreamPerfState;
    if (!streamPerfEnabled() || !state) {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    return {
        enabled: true,
        startedAt: state.startedAt,
        lastUpdatedAt: state.lastUpdatedAt,
        durationMs: Math.max(0, Date.now() - state.startedAt),
        entries: normalizePerfEntries(state.counters),
    };
};

export const getResponsivenessPerfSnapshot = (): StreamPerfSnapshot => {
    if (typeof window === 'undefined') {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    const state = window.__openchamberResponsivenessPerfState;
    if (!streamPerfEnabled() || !state) {
        return {
            enabled: false,
            startedAt: null,
            lastUpdatedAt: null,
            durationMs: 0,
            entries: [],
        };
    }

    return {
        enabled: true,
        startedAt: state.startedAt,
        lastUpdatedAt: state.lastUpdatedAt,
        durationMs: Math.max(0, Date.now() - state.startedAt),
        entries: normalizePerfEntries(state.counters),
    };
};

export const streamPerfCount = (metric: string, count = 1): void => {
    updatePerfCounter(metric, count);
};

export const streamPerfObserve = (metric: string, value: number): void => {
    updatePerfCounter(metric, value);
};

export const responsivenessPerfCount = (metric: string, count = 1): void => {
    updateResponsivenessPerfCounter(metric, count);
};

export const responsivenessPerfObserve = (metric: string, value: number): void => {
    updateResponsivenessPerfCounter(metric, value);
};

export const streamDebugMark = (name: string, detail?: Record<string, unknown>): void => {
    if (!streamDebugEnabled()) {
        return;
    }

    const markName = `devryan-${name}`;
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
        try {
            performance.mark(markName);
        } catch {
            // ignore unsupported mark names
        }
    }

    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug('[stream-debug]', markName, detail ?? {});
    }
};

export type TurnTimingMarkInput = {
    sessionId?: string;
    messageId?: string;
    assistantMessageId?: string;
    mark: string;
    directory?: string | null;
    metadata?: Record<string, unknown>;
};

const sanitizeRendererTimingMetadata = (
    mark: string,
    metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }

    const sanitized: Record<string, unknown> = {};
    const stringKeys = mark === 'renderer_long_running_tool_confirmed'
        ? ['source', 'tool']
        : ['runtime', 'transport', 'visibilityState', 'source', 'tool'];
    for (const key of stringKeys) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            sanitized[key] = value.trim();
        }
    }

    if (mark !== 'renderer_long_running_tool_confirmed') {
        const stalledForMs = metadata.stalledForMs;
        if (typeof stalledForMs === 'number' && Number.isFinite(stalledForMs) && stalledForMs >= 0) {
            sanitized.stalledForMs = Math.trunc(stalledForMs);
        }
    }
    if (mark === 'renderer_long_running_tool_confirmed') {
        const elapsedMs = metadata.elapsedMs;
        if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
            sanitized.elapsedMs = Math.trunc(elapsedMs);
        }
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

export const postTurnTimingMark = (input: TurnTimingMarkInput): void => {
    const recordsOperationalIncident = input.mark === 'renderer_tool_input_stall_confirmed'
        || input.mark === 'renderer_provider_inference_stall_confirmed'
        || input.mark === 'renderer_long_running_tool_confirmed';
    if ((!recordsOperationalIncident && !streamDebugEnabled()) || typeof fetch !== 'function') {
        return;
    }

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    const assistantMessageId = typeof input.assistantMessageId === 'string' ? input.assistantMessageId.trim() : '';
    const mark = typeof input.mark === 'string' ? input.mark.trim() : '';
    if ((!sessionId && !assistantMessageId) || !mark) {
        return;
    }

    const body: Record<string, unknown> = {
        mark,
    };
    if (sessionId) {
        body.sessionId = sessionId;
    }
    if (typeof input.messageId === 'string' && input.messageId.trim().length > 0) {
        body.messageId = input.messageId.trim();
    }
    if (assistantMessageId) {
        body.assistantMessageId = assistantMessageId;
    }
    if (typeof input.directory === 'string' && input.directory.trim().length > 0) {
        body.directory = input.directory.trim();
    }
    if (input.metadata && typeof input.metadata === 'object') {
        body.metadata = input.metadata;
    }

    void fetch('/api/diagnostics/turn-timing/mark', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    }).catch(() => undefined);
};

export const postRendererTurnTimingMark = (input: TurnTimingMarkInput): void => {
    postTurnTimingMark({
        ...input,
        metadata: sanitizeRendererTimingMetadata(input.mark, input.metadata),
    });
};

export const streamPerfMeasure = <T>(metric: string, fn: () => T): T => {
    if (!streamPerfEnabled()) {
        return fn();
    }

    const start = nowMs();
    try {
        return fn();
    } finally {
        updatePerfCounter(metric, nowMs() - start);
    }
};
