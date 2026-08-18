import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, OpencodeClient } from '@opencode-ai/sdk/v2/client';

import { useConfigStore } from '@/stores/useConfigStore';

import { ChildStoreManager } from './child-store';
import { clearSyncRefs, setSyncRefs } from './sync-refs';
import { useSessionUIStore } from './session-ui-store';
import { useSessionWorktreeStore } from './session-worktree-store';

const ROOT_DIRECTORY = '/repo';
const WORKTREE_DIRECTORY = '/repo/.worktrees/feature';
const SESSION_ID = 'ses_context_worktree';

const assistantMessage = (
    id: string,
    input: number,
    cacheRead: number,
): Message => ({
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    providerID: 'openai',
    modelID: 'gpt-context-test',
    time: { created: input + cacheRead },
    tokens: {
        total: input + cacheRead,
        input,
        output: 0,
        reasoning: 0,
        cache: { read: cacheRead, write: 0 },
    },
} as Message);

describe('session-scoped context usage', () => {
    let childStores: ChildStoreManager;
    let originalProviders: ReturnType<typeof useConfigStore.getState>['providers'];
    let originalDraft: ReturnType<typeof useSessionUIStore.getState>['newSessionDraft'];

    beforeEach(() => {
        childStores = new ChildStoreManager();
        setSyncRefs({} as OpencodeClient, childStores, ROOT_DIRECTORY);
        originalProviders = useConfigStore.getState().providers;
        originalDraft = useSessionUIStore.getState().newSessionDraft;
        useConfigStore.setState({
            providers: [{
                id: 'openai',
                name: 'OpenAI',
                models: [{
                    id: 'gpt-context-test',
                    name: 'Context Test',
                    limit: { input: 2_000, context: 4_000, output: 1_000 },
                }],
            }] as unknown as ReturnType<typeof useConfigStore.getState>['providers'],
        });

        childStores.ensureChild(ROOT_DIRECTORY, { bootstrap: false }).setState((state) => ({
            message: {
                ...state.message,
                [SESSION_ID]: [assistantMessage('msg_root_stale', 50, 0)],
            },
        }));
        childStores.ensureChild(WORKTREE_DIRECTORY, { bootstrap: false }).setState((state) => ({
            message: {
                ...state.message,
                [SESSION_ID]: [
                    assistantMessage('msg_worktree_complete', 1_000, 200),
                    assistantMessage('msg_worktree_shell', 0, 0),
                ],
            },
        }));
        useSessionWorktreeStore.getState().setAttachment(SESSION_ID, {
            worktreeRoot: WORKTREE_DIRECTORY,
            cwd: WORKTREE_DIRECTORY,
            branch: 'feature',
            headState: 'branch',
            worktreeStatus: 'ready',
            worktreeSource: 'existing',
            legacy: false,
            degraded: false,
        });
    });

    afterEach(() => {
        clearSyncRefs(childStores);
        useSessionWorktreeStore.getState().clearAttachment(SESSION_ID);
        useConfigStore.setState({ providers: originalProviders });
        useSessionUIStore.setState({ newSessionDraft: originalDraft });
    });

    test('reads the attached worktree instead of the globally active directory', () => {
        const usage = useSessionUIStore.getState().getContextUsageForSession(SESSION_ID);

        expect(usage?.lastMessageId).toBe('msg_worktree_complete');
        expect(usage?.activeInputTokens).toBe(1_200);
        expect(usage?.capacityLimit).toBe(2_000);
        expect(usage?.percentage).toBe(60);
    });

    test('honors an explicit directory and ignores unrelated draft state', () => {
        useSessionUIStore.setState((state) => ({
            newSessionDraft: { ...state.newSessionDraft, open: true },
        }));

        const usage = useSessionUIStore.getState().getContextUsageForSession(
            SESSION_ID,
            WORKTREE_DIRECTORY,
        );

        expect(usage?.activeInputTokens).toBe(1_200);
        expect(useSessionUIStore.getState().getContextUsageForSession(null, WORKTREE_DIRECTORY)).toBeNull();
    });
});
