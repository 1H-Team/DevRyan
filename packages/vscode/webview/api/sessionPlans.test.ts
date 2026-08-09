import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FilesAPI } from '@openchamber/ui/lib/api/types';

import { createVSCodeSessionPlansAPI } from './sessionPlans';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

const createFiles = () => ({
  statFile: vi.fn(async () => ({ path: '', exists: false, isFile: false, size: 0 })),
  createDirectory: vi.fn(async (path: string) => ({ success: true, path })),
  writeFile: vi.fn(async (path: string) => ({ success: true, path })),
  readFile: vi.fn(async (path: string) => ({ path, content: '# Plan' })),
}) as unknown as FilesAPI;

const identity = {
  sessionId: 'session-a',
  sourceMessageId: 'msg-plan-1',
  directory: '/repo',
  sessionCreated: 123,
  sessionSlug: 'Plan route',
};

describe('createVSCodeSessionPlansAPI', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    vi.restoreAllMocks();
  });

  test('keeps session plans behind the bridge-backed files adapter', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __OPENCHAMBER_HOME__: '/Users/example' },
    });
    const files = createFiles();
    const api = createVSCodeSessionPlansAPI(files);

    const created = await api.ensureRevision({ ...identity, markdown: '# Plan' });
    expect(created.created).toBe(true);
    expect(created.path.endsWith('/plans/123-Plan-route-msg-plan-1.md')).toBe(true);
    expect(files.createDirectory).toHaveBeenCalledOnce();
    expect(files.writeFile).toHaveBeenCalledWith(created.path, '# Plan');
  });

  test('preserves an existing revision and supports read/update', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __OPENCHAMBER_HOME__: '/Users/example' },
    });
    const files = createFiles();
    (files.statFile as ReturnType<typeof vi.fn>).mockResolvedValue({ path: '', exists: true, isFile: true, size: 10 });
    const api = createVSCodeSessionPlansAPI(files);

    const ensured = await api.ensureRevision({ ...identity, markdown: '# Must not overwrite' });
    expect(ensured.created).toBe(false);
    expect(files.writeFile).not.toHaveBeenCalled();
    await expect(api.readRevision(identity)).resolves.toMatchObject({ content: '# Plan' });
    await expect(api.updateRevision({ ...identity, markdown: '# Edited' })).resolves.toMatchObject({ saved: true });
    expect(files.writeFile).toHaveBeenCalledWith(ensured.path, '# Edited');
  });

  test('rejects malformed revision identities before bridge storage', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __OPENCHAMBER_HOME__: '/Users/example' },
    });
    const files = createFiles();
    const api = createVSCodeSessionPlansAPI(files);

    await expect(api.ensureRevision({
      ...identity,
      sourceMessageId: '../escape',
      markdown: '# Plan',
    })).rejects.toThrow('Plan file identity is incomplete');
    expect(files.statFile).not.toHaveBeenCalled();
  });
});
