import React, { act } from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { useSessionCreationStore, type CreationAttempt } from '@/sync/session-creation';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { withDom, type HostElement } from '@/test/mountedDom';
import { SessionCreationRecoveryContent, SessionCreationRecoveryStatus, SessionCreationStatus } from './SessionCreationStatus';

const draftId = 'session-creation-status-test';

const attempt = (phase: CreationAttempt['phase'], sessionId?: string): CreationAttempt => ({
    id: `attempt-${phase}`,
    draftId,
    startedAt: 1,
    phase,
    sessionId,
});

beforeEach(() => {
    useSessionCreationStore.setState({ attempts: {} });
    useSessionUIStore.setState({ abortControllers: new Map() });
});

const withStatus = async (run: (container: HostElement, navigate: () => Promise<void>) => Promise<void>) => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
        await act(async () => { root.render(<SessionCreationStatus draftId={draftId} onRetry={() => undefined} />); });
        await run(container, async () => {
            await act(async () => { root.render(<SessionCreationStatus draftId={null} onRetry={() => undefined} />); });
        });
    } finally {
        await act(async () => { root.unmount(); });
    }
});

const setAttempt = (phase: CreationAttempt['phase'], sessionId?: string) => {
    useSessionCreationStore.setState({ attempts: { [draftId]: attempt(phase, sessionId) } });
};

describe('SessionCreationStatus', () => {
    test('never renders recovery during creation, send promotion, or composer navigation', async () => withStatus(async (container, navigate) => {
        await act(async () => { useSessionUIStore.getState().claimPendingSendAbort(`draft:${draftId}`); });
        for (const phase of ['preparing', 'creating', 'created'] as const) {
            await act(async () => { setAttempt(phase, phase === 'created' ? 'ses_sending' : undefined); });
            expect(container.textContent).toBe('');
        }
        await act(async () => { useSessionUIStore.getState().promotePendingSendAbort(`draft:${draftId}`, 'ses_sending'); });
        expect(container.textContent).toBe('');
        await navigate();
        await act(async () => { useSessionUIStore.getState().clearPendingSendAbort('ses_sending'); });
        expect(container.textContent).toBe('');
    }));

    test('reveals interrupted and late-created recovery when the owning send ends', async () => withStatus(async (container) => {
        await act(async () => {
            useSessionUIStore.getState().claimPendingSendAbort(`draft:${draftId}`);
            setAttempt('unknown');
        });
        expect(container.textContent).toBe('');
        await act(async () => { useSessionUIStore.getState().abortPendingSend(`draft:${draftId}`); });
        expect(container.textContent).toContain('Creation outcome is unknown.');
        const retry = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Retry as New Session');
        expect(retry).not.toBeNull();
        await act(async () => { retry!.click(); });
        expect(container.textContent).toContain('This may create a duplicate session.');
        expect(container.textContent).toContain('Confirm Retry as New Session');
        await act(async () => { setAttempt('created', 'ses_late'); });
        expect(container.textContent).toContain('A session was created.');
        expect(container.textContent).toContain('Open Session');
        await act(async () => {
            useSessionUIStore.getState().claimPendingSendAbort('ses_late');
        });
        expect(container.textContent).toBe('');
        await act(async () => { useSessionUIStore.getState().clearPendingSendAbort('ses_late'); });
        expect(container.textContent).toContain('A session was created.');
    }));

    test('another draft or session send does not hide this draft recovery', async () => withStatus(async (container) => {
        await act(async () => {
            setAttempt('created', 'ses_retained');
            useSessionUIStore.getState().claimPendingSendAbort('draft:other');
            useSessionUIStore.getState().claimPendingSendAbort('ses_other');
        });
        expect(container.textContent).toContain('A session was created.');
        await act(async () => { setAttempt('unknown'); });
        expect(container.textContent).toContain('Creation outcome is unknown.');
    }));

    test('does not render a normal preparation or creation banner', async () => withStatus(async (container) => {
        expect(container.textContent).toBe('');
        for (const phase of ['preparing', 'creating', 'failed'] as const) {
            await act(async () => { setAttempt(phase); });
            expect(container.textContent).toBe('');
        }
    }));

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
