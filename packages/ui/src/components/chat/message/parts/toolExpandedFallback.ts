import { coerceRuntimeText } from './runtimeText';

export type ToolExpandedPrimaryKind = 'structured' | 'input' | 'output' | 'failure' | 'empty';

export type ToolExpandedDetails = {
    primaryKind: ToolExpandedPrimaryKind;
    hasInput: boolean;
    hasOutput: boolean;
    isFailure: boolean;
    failureReason?: string;
    failureStatus?: string;
    showEmpty: boolean;
    showResult: boolean;
};

type ResolveToolExpandedDetailsInput = {
    hasStructuredDetails: boolean;
    inputText?: unknown;
    output?: unknown;
    error?: unknown;
    status?: unknown;
    isFinalized?: boolean;
};

const FAILURE_STATUSES = new Set([
    'error',
    'failed',
    'aborted',
    'timeout',
    'timedout',
    'cancelled',
    'canceled',
]);

const normalizeStatus = (status: unknown): string | undefined => {
    if (typeof status !== 'string') {
        return undefined;
    }
    const normalized = status.toLowerCase().trim().replace(/[\s_-]+/g, '');
    return normalized || undefined;
};

const readFailureReason = (error: unknown): string | undefined => {
    if (typeof error === 'string') {
        return error.trim() || undefined;
    }
    if (error instanceof Error) {
        return error.message.trim() || undefined;
    }
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason']) {
        const value = record[key];
        const text = coerceRuntimeText(value).trim();
        if (text) {
            return text;
        }
    }
    return coerceRuntimeText(error).trim() || undefined;
};

const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

export const resolveToolExpandedDetails = ({
    hasStructuredDetails,
    inputText,
    output,
    error,
    status,
    isFinalized = false,
}: ResolveToolExpandedDetailsInput): ToolExpandedDetails => {
    const hasInput = hasText(inputText);
    const hasOutput = hasText(output);
    const failureReason = readFailureReason(error);
    const normalizedStatus = normalizeStatus(status);
    const failureStatus = normalizedStatus && FAILURE_STATUSES.has(normalizedStatus)
        ? normalizedStatus
        : undefined;
    const isFailure = Boolean(failureStatus || failureReason);
    let primaryKind: ToolExpandedPrimaryKind = 'empty';
    if (hasStructuredDetails) {
        primaryKind = 'structured';
    } else if (hasInput) {
        primaryKind = 'input';
    } else if (hasOutput) {
        primaryKind = 'output';
    } else if (isFailure) {
        primaryKind = 'failure';
    }

    const showEmpty = isFinalized && primaryKind === 'empty';

    return {
        primaryKind,
        hasInput,
        hasOutput,
        isFailure,
        ...(failureReason ? { failureReason } : {}),
        ...(failureStatus ? { failureStatus } : {}),
        showEmpty,
        showResult: hasStructuredDetails || hasOutput || showEmpty,
    };
};
