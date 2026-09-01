import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { useSessionCreationStore, type CreationAttempt } from '@/sync/session-creation';
import { SessionCreationRecoveryContent, SessionCreationRecoveryStatus, SessionCreationStatus } from './SessionCreationStatus';

const draftId = 'session-creation-status-test';

const attempt = (phase: CreationAttempt['phase'], sessionId?: string): CreationAttempt => ({
    id: `attempt-${phase}`,
    draftId,
    startedAt: 1,
    phase,
    sessionId,
});

const renderStatus = (value?: CreationAttempt) => {
    useSessionCreationStore.setState({ attempts: value ? { [draftId]: value } : {} });
    return renderToStaticMarkup(<SessionCreationStatus draftId={draftId} onRetry={() => undefined} />);
};

beforeEach(() => useSessionCreationStore.setState({ attempts: {} }));

describe('SessionCreationStatus', () => {
    test('does not render a normal preparation or creation banner', () => {
        expect(renderStatus(attempt('preparing'))).toBe('');
        expect(renderStatus(attempt('creating'))).toBe('');
        expect(renderStatus(attempt('failed'))).toBe('');
        expect(renderStatus()).toBe('');
    });

    test('keeps the unknown-outcome duplicate protection', () => {
        const markup = renderToStaticMarkup(<SessionCreationRecoveryStatus attempt={attempt('unknown')} onRetry={() => undefined} />);
        expect(markup).toContain('Creation outcome is unknown.');
        expect(markup).toContain('Retry as New Session');
        expect(markup).not.toContain('Creating session');

        const confirmation = renderToStaticMarkup(<SessionCreationRecoveryContent
            attempt={attempt('unknown')}
            onRetry={() => undefined}
            confirmRetry
            onConfirmRetryChange={() => undefined}
        />);
        expect(confirmation).toContain('This may create a duplicate session.');
        expect(confirmation).toContain('Confirm Retry as New Session');
        expect(confirmation).toContain('Keep Draft');
    });

    test('keeps late-created recovery and session navigation', () => {
        const markup = renderToStaticMarkup(<SessionCreationRecoveryStatus attempt={attempt('created', 'ses_late')} onRetry={() => undefined} />);
        expect(markup).toContain('A session was created.');
        expect(markup).toContain('Open Session');
        expect(markup).toContain('Retry as New Session');
    });
});
