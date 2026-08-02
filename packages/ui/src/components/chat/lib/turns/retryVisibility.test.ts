import { describe, expect, test } from 'bun:test';

import {
    RETRY_VISIBILITY_GRACE_MS,
    TRANSIENT_PROVIDER_RETRY_VISIBILITY_GRACE_MS,
    getRetryVisibilityIdentity,
    getRetryVisibilityStartTime,
    shouldShowRetryVisibility,
    type RetryVisibilityStatus,
} from './retryVisibility';

const retry = (overrides: Partial<RetryVisibilityStatus> = {}): RetryVisibilityStatus => ({
    sessionId: 'session-1',
    message: 'failed to connect, retry after 10000ms',
    ...overrides,
});

describe('retry visibility', () => {
    test('hides retry status inside the grace window', () => {
        const status = retry();
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(status, state, 1000 + RETRY_VISIBILITY_GRACE_MS - 1)).toBe(false);
    });

    test('shows retry status after the grace window', () => {
        const status = retry();
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(status, state, 1000 + RETRY_VISIBILITY_GRACE_MS)).toBe(true);
    });

    test('uses confirmedAt as the retry start time when present', () => {
        const status = retry({ confirmedAt: 500 });

        expect(getRetryVisibilityStartTime(status, 1000)).toBe(500);
    });

    test('does not show when the retry identity changes', () => {
        const status = retry({ attempt: 2 });
        const previous = retry({ attempt: 1 });
        const state = { identity: getRetryVisibilityIdentity(previous), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(status, state, 1000 + RETRY_VISIBILITY_GRACE_MS)).toBe(false);
    });

    test('clearing retry before the grace window leaves no visible retry', () => {
        const status = retry();
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(null, state, 1000 + RETRY_VISIBILITY_GRACE_MS + 1)).toBe(false);
    });

    test('keeps already-visible retries visible across attempt updates for the same session', () => {
        const status = retry({ attempt: 2, next: 20_000 });
        const previous = retry({ attempt: 1, next: 10_000 });
        const state = {
            identity: getRetryVisibilityIdentity(previous),
            firstSeenAt: 1000,
            visibleSessionId: 'session-1',
        };

        expect(shouldShowRetryVisibility(status, state, 1100)).toBe(true);
    });

    test('hides transient provider response header timeouts during the default retry grace', () => {
        const status = retry({
            message: 'Provider response headers timed out after 1000 milliseconds.',
        });
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(status, state, 1000 + RETRY_VISIBILITY_GRACE_MS)).toBe(false);
    });

    test('shows transient provider response header timeouts only after the longer grace window', () => {
        const status = retry({
            message: 'Provider response headers timed out after 1000 milliseconds.',
        });
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(status, state, 1000 + TRANSIENT_PROVIDER_RETRY_VISIBILITY_GRACE_MS)).toBe(true);
    });

    test('hides transient provider overload responses during the longer grace window', () => {
        const status = retry({
            message: 'Our servers are currently overloaded. Please try again later.',
        });
        const state = { identity: getRetryVisibilityIdentity(status), firstSeenAt: 1000 };

        expect(shouldShowRetryVisibility(
            status,
            state,
            1000 + RETRY_VISIBILITY_GRACE_MS,
        )).toBe(false);
        expect(shouldShowRetryVisibility(
            status,
            state,
            1000 + TRANSIENT_PROVIDER_RETRY_VISIBILITY_GRACE_MS,
        )).toBe(true);
    });
});
