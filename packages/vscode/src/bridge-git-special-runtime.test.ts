import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('vscode', () => ({}));
vi.mock('./gitService', () => ({}));

const originalFetch = globalThis.fetch;
let handleSpecialGitBridgeMessage: typeof import('./bridge-git-special-runtime').handleSpecialGitBridgeMessage;
let normalizeBridgeCommitSubject: typeof import('./bridge-git-special-runtime').normalizeBridgeCommitSubject;

const payload = {
  directory: '/repo',
  context: {
    branch: 'main',
    tracking: 'origin/main',
    scope: 'staged-only',
    stagedOnly: true,
    recentCommitSubjects: [],
    selectedFiles: [{
      path: 'src/app.ts',
      index: 'M',
      workingDir: ' ',
      diff: '+export const updated = true',
    }],
  },
};

beforeAll(async () => {
  const runtime = await import('./bridge-git-special-runtime');
  handleSpecialGitBridgeMessage = runtime.handleSpecialGitBridgeMessage;
  normalizeBridgeCommitSubject = runtime.normalizeBridgeCommitSubject;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('VS Code direct commit message generation', () => {
  it('uses the commit-specific free Zen model instead of the global utility setting', async () => {
    const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
      void args;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: 'fix(ui): generate source commit message' } }],
        }),
      } as Response;
    });
    globalThis.fetch = fetchMock;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);

    const result = await handleSpecialGitBridgeMessage(
      { id: '1', type: 'api:git/commit-message', payload },
      undefined,
      {
        readSettings: () => ({ zenModel: 'big-pickle' }),
        execGit: vi.fn(),
      },
    );

    expect(result).toEqual({
      id: '1',
      type: 'api:git/commit-message',
      success: true,
      data: { subject: 'fix(ui): generate source commit message', highlights: [] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    const requestPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(requestPayload.model).toBe('deepseek-v4-flash-free');
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(requestedUrl).not.toMatch(/session|prompt_async/);
  });

  it('collects no-index diffs for untracked worktree files', () => {
    const gitServiceSource = readFileSync(fileURLToPath(new URL('./gitService.ts', import.meta.url)), 'utf8');

    expect(gitServiceSource).toContain("['ls-files', '--error-unmatch', '--', filePath]");
    expect(gitServiceSource).toContain("noIndexArgs.push('--no-index', '--', '/dev/null', filePath)");
    expect(gitServiceSource).toContain('return { diff: untracked.stdout || untracked.stderr };');
  });

  it('supports chat-completion Zen models and explicit model overrides', async () => {
    const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
      void args;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: 'chore: update source fixture' } }] }),
      } as Response;
    });
    globalThis.fetch = fetchMock;

    const result = await handleSpecialGitBridgeMessage(
      {
        id: '2',
        type: 'api:git/commit-message',
        payload: { ...payload, zenModel: 'big-pickle' },
      },
      undefined,
      {
        readSettings: () => ({ zenModel: 'gpt-5-nano' }),
        execGit: vi.fn(),
      },
    );

    expect(result?.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/chat/completions');
    const requestPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestPayload.model).toBe('big-pickle');
  });

  it('rejects malformed output and missing worktree context', async () => {
    expect(() => normalizeBridgeCommitSubject('write a useful commit')).toThrow(/conventional commit/);

    const result = await handleSpecialGitBridgeMessage(
      { id: '3', type: 'api:git/commit-message', payload: { directory: '/repo' } },
      undefined,
      {
        readSettings: () => ({}),
        execGit: vi.fn(),
      },
    );
    expect(result).toEqual({
      id: '3',
      type: 'api:git/commit-message',
      success: false,
      error: 'Worktree context is required',
    });
  });
});
