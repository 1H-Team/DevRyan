import { beforeEach, describe, expect, mock, test } from 'bun:test';

type DraftOptions = Record<string, unknown>;

let slug: string | null = 'homepage-language-audit';
let isGitRepository = true;
const slugPrompts: string[] = [];
const createdWith: Array<Record<string, unknown>> = [];
const draftOverrides: DraftOptions[] = [];
const resolvedTargets: Array<{ requestId: string; directory: string | null }> = [];
const toastErrors: string[] = [];
let draft: DraftOptions & { open: boolean } = { open: true, directoryOverride: '/repo', title: 'Issue #12' };

const actualGitApi = await import('@/lib/gitApi');
mock.module('@/lib/gitApi', () => ({
  ...actualGitApi,
  checkIsGitRepository: async () => isGitRepository,
  generateBranchSlug: async (_directory: string, prompt: string) => { slugPrompts.push(prompt); return slug; },
  previewGitWorktree: async (_directory: string, payload: { worktreeName?: string }) => ({
    name: payload.worktreeName, path: `/worktrees/${payload.worktreeName}`,
  }),
}));
mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: async (_project: unknown, args: Record<string, unknown>) => {
    createdWith.push(args);
    return { path: `/worktrees/${String(args.worktreeName)}`, branch: args.branchName };
  },
}));
const actualDevryanConfig = await import('@/lib/devryanConfig');
mock.module('@/lib/devryanConfig', () => ({ ...actualDevryanConfig, getWorktreeSetupCommands: async () => [] }));
const actualAuthSession = await import('@/lib/authSession');
mock.module('@/lib/authSession', () => ({
  ...actualAuthSession,
  assertCanCreateBranches: () => undefined,
  assertCanCreateWorktrees: () => undefined,
}));
const actualUi = await import('@/components/ui');
mock.module('@/components/ui', () => ({
  ...actualUi,
  toast: { ...actualUi.toast, error: (message: string) => { toastErrors.push(message); } },
}));
const actualSessionUiStore = await import('@/sync/session-ui-store');
mock.module('@/sync/session-ui-store', () => ({
  ...actualSessionUiStore,
  useSessionUIStore: {
    setState: () => undefined,
    getState: () => ({
      currentSessionId: null,
      pendingSessionId: null,
      newSessionDraft: draft,
      overrideNewSessionDraftTarget: (options: DraftOptions) => {
        draftOverrides.push(options);
        draft = { ...draft, ...options };
      },
      openNewSessionDraft: () => { throw new Error('the draft is already open'); },
      resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null) => {
        resolvedTargets.push({ requestId, directory });
      },
    }),
  },
}));
const actualDirectoryStore = await import('@/stores/useDirectoryStore');
mock.module('@/stores/useDirectoryStore', () => ({
  ...actualDirectoryStore,
  useDirectoryStore: { getState: () => ({ setDirectory: () => undefined }) },
}));

const { createWorktreeDraftForPrompt } = await import('./worktreeSessionCreator');
const { waitForPendingDraftWorktreeRequest } = await import('./worktrees/pendingDraftWorktree');

const project = { id: 'project-1', path: '/repo' };

describe('createWorktreeDraftForPrompt', () => {
  beforeEach(() => {
    slug = 'homepage-language-audit';
    isGitRepository = true;
    slugPrompts.length = 0;
    createdWith.length = 0;
    draftOverrides.length = 0;
    resolvedTargets.length = 0;
    toastErrors.length = 0;
    draft = { open: true, directoryOverride: '/repo', title: 'Issue #12' };
  });

  test('locks the draft before returning, then creates DevRyan/<slug> from the prompt', async () => {
    expect(createWorktreeDraftForPrompt(project, 'Audit the homepage language')).toBe(true);
    const requestId = draft.pendingWorktreeRequestId;
    expect(typeof requestId).toBe('string');
    // A send started right now must see the lock; the title survives it.
    expect(draft.title).toBe('Issue #12');

    expect(await waitForPendingDraftWorktreeRequest(String(requestId))).toBe('/worktrees/homepage-language-audit');
    expect(slugPrompts).toEqual(['Audit the homepage language']);
    expect(createdWith[0]).toMatchObject({
      mode: 'new',
      branchName: 'DevRyan/homepage-language-audit',
      worktreeName: 'homepage-language-audit',
      idempotencyKey: requestId,
    });
    expect(draftOverrides.every((options) => !('title' in options))).toBe(true);
  });

  test('falls back to a random slug when the helper model returns nothing', async () => {
    slug = null;
    expect(createWorktreeDraftForPrompt(project, 'Something')).toBe(true);
    await waitForPendingDraftWorktreeRequest(String(draft.pendingWorktreeRequestId));
    expect(String(createdWith[0]?.branchName)).toMatch(/^DevRyan\/[a-z]+-[a-z]+$/);
  });

  test('rejects the pending request outside a Git repository', async () => {
    isGitRepository = false;
    expect(createWorktreeDraftForPrompt(project, 'Something')).toBe(true);
    const requestId = String(draft.pendingWorktreeRequestId);
    await expect(waitForPendingDraftWorktreeRequest(requestId)).rejects.toThrow('Git repositories');
    expect(createdWith).toHaveLength(0);
    expect(resolvedTargets).toContainEqual({ requestId, directory: null });
    expect(toastErrors).toEqual(['Failed to create worktree']);
  });

  test('does nothing without an open draft', () => {
    draft = { open: false };
    expect(createWorktreeDraftForPrompt(project, 'Something')).toBe(false);
    expect(draftOverrides).toHaveLength(0);
  });
});
