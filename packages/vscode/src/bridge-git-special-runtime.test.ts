import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as gitService from './gitService';

vi.mock('vscode', () => ({}));
vi.mock('./gitService', () => ({
  getGitStatus: vi.fn(),
  getGitLog: vi.fn(),
  getGitDiff: vi.fn(),
}));

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
  vi.resetAllMocks();
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
          choices: [{ message: { content: '{"subject":"fix(ui): generate source commit message","details":["Generate the commit draft","Avoid session startup"]}' } }],
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
      data: {
        subject: 'fix(ui): generate source commit message',
        highlights: ['Generate the commit draft', 'Avoid session startup'],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    const requestPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(requestPayload.model).toBe('nemotron-3.5-lightning-free');
    expect(requestPayload.max_tokens).toBe(220);
    expect(requestPayload.reasoning_effort).toBe('none');
    expect(requestPayload.stop).toBeUndefined();
    expect(timeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(20_000);
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
    expect(requestPayload.reasoning_effort).toBe('none');
  });

  it('collects the selected worktree context in the extension host with batched diffs', async () => {
    vi.mocked(gitService.getGitStatus).mockResolvedValue({
      current: 'main',
      tracking: 'origin/main',
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        { path: 'src/app.ts', index: 'M', working_dir: ' ' },
        { path: 'src/new.ts', index: '?', working_dir: '?' },
      ],
      mergeInProgress: null,
      rebaseInProgress: null,
    });
    vi.mocked(gitService.getGitLog).mockResolvedValue({
      all: [{
        hash: 'abc123',
        date: '2026-08-07T00:00:00.000Z',
        message: 'fix: previous subject',
        refs: '',
        body: '',
        author_name: 'Dev',
        author_email: 'dev@example.test',
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
      }],
      latest: null,
      total: 1,
    });
    vi.mocked(gitService.getGitDiff).mockImplementation(async (_directory, filePath) => ({
      diff: filePath === 'src/new.ts' ? 'Binary files differ' : '+const fast = true',
    }));
    const execGit = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
      void args;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: '{"subject":"perf(git): speed commit message drafts","details":["Batch selected diffs","Bound provider latency"]}' } }],
        }),
      } as Response;
    });
    globalThis.fetch = fetchMock;

    const result = await handleSpecialGitBridgeMessage(
      {
        id: 'draft-1',
        type: 'api:git/commit-message-draft',
        payload: {
          directory: '/repo',
          selectedFiles: ['./src/app.ts', 'src/app.ts', 'src/new.ts'],
          stagedOnly: true,
          guidance: 'Prefer a git scope',
        },
      },
      undefined,
      { readSettings: () => ({}), execGit },
    );

    expect(result).toEqual({
      id: 'draft-1',
      type: 'api:git/commit-message-draft',
      success: true,
      data: {
        status: 'complete',
        commits: [{
          subject: 'perf(git): speed commit message drafts',
          highlights: ['Batch selected diffs', 'Bound provider latency'],
        }],
      },
    });
    expect(gitService.getGitStatus).toHaveBeenCalledWith('/repo');
    expect(gitService.getGitLog).toHaveBeenCalledWith('/repo', { maxCount: 6 });
    expect(gitService.getGitDiff).not.toHaveBeenCalled();
    expect(execGit).toHaveBeenCalledTimes(2);
    expect(execGit).toHaveBeenCalledWith(['diff', '--cached', '--numstat'], '/repo');
    expect(execGit).toHaveBeenCalledWith(
      ['diff', '--no-color', '-U1', '--cached', '--', 'src/app.ts', 'src/new.ts'],
      '/repo',
    );
    const requestPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestPayload.messages[0].content).toContain('Prefer a git scope');
    expect(requestPayload.messages[0].content).toContain('src/new.ts');
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

describe('VS Code direct PR description generation', () => {
  it('uses the free Zen catalog without creating or prompting a session', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://opencode.ai/zen/v1/models') {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'free-a' }] }) } as Response;
      }
      if (url === 'https://models.dev/api.json') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ opencode: { models: { 'free-a': { cost: { input: 0, output: 0 } } } } }),
        } as Response;
      }
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody.model).toBe('free-a');
      expect(requestBody.max_tokens).toBe(1_200);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"title":"Generate PR directly","body":"## Summary\\n- Use free Zen"}' } }],
        }),
      } as Response;
    });
    globalThis.fetch = fetchMock;

    const result = await handleSpecialGitBridgeMessage(
      {
        id: 'pr-1',
        type: 'api:git/pr-description',
        payload: {
          directory: '/repo',
          base: 'main',
          head: 'feature/direct-pr',
          prompt: 'Return the Generate PR JSON',
        },
      },
      undefined,
      { readSettings: vi.fn(() => ({ gitModelId: 'paid-model' })), execGit: vi.fn() },
    );

    expect(result).toEqual({
      id: 'pr-1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'Generate PR directly', body: '## Summary\n- Use free Zen' },
    });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://opencode.ai/zen/v1/chat/completions');
    expect(urls.some((url) => /\/session(?:\/|$)|prompt_async/.test(url))).toBe(false);
  });
});
