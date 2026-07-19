import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { getSafeStorage } from './utils/safeStorage';

let statusData: Record<string, McpStatus> = {};
let connectError: Error | null = null;
let clientDirectory: string | undefined;

const api = {
  mcp: {
    status: mock(async () => ({ data: statusData })),
    connect: mock(async () => {
      if (connectError) throw connectError;
      return { data: true };
    }),
    disconnect: mock(async () => {
      statusData = { linear: { status: 'disabled' } };
      return { data: true };
    }),
    auth: {
      start: mock(async () => ({ data: { authorizationUrl: 'https://example.test/auth' } })),
      callback: mock(async () => ({ data: true })),
      remove: mock(async () => ({ data: true })),
    },
  },
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: (directory: string | undefined) => {
      clientDirectory = directory;
    },
    getDirectory: () => clientDirectory,
    getApiClient: () => api,
    getScopedApiClient: () => api,
  },
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: null }),
  },
}));

const {
  reconcileMcpIssueKinds,
  useMcpStore,
} = await import('./useMcpStore');

const STORAGE_KEY = 'mcp-runtime-issues';

describe('useMcpStore issue memory', () => {
  beforeEach(() => {
    statusData = {};
    connectError = null;
    clientDirectory = undefined;
    getSafeStorage().removeItem(STORAGE_KEY);
    useMcpStore.setState({
      byDirectory: {},
      diagnosticsByDirectory: {},
      issueKindsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},
    });
  });

  test('records every runtime issue kind and keeps it when the server becomes disabled', () => {
    const issueKinds = reconcileMcpIssueKinds({}, {
      failedServer: { status: 'failed', error: 'transport failed' },
      authServer: { status: 'needs_auth' },
      registrationServer: { status: 'needs_client_registration', error: 'registration failed' },
    });

    expect(issueKinds).toEqual({
      failedServer: 'failed',
      authServer: 'needs_auth',
      registrationServer: 'needs_client_registration',
    });
    expect(reconcileMcpIssueKinds(issueKinds, {
      failedServer: { status: 'disabled' },
      authServer: { status: 'disabled' },
      registrationServer: { status: 'disabled' },
    })).toBe(issueKinds);
  });

  test('a successful connection clears only that server issue', () => {
    const current = {
      linear: 'failed' as const,
      github: 'needs_auth' as const,
    };

    expect(reconcileMcpIssueKinds(current, {
      linear: { status: 'connected' },
      github: { status: 'disabled' },
    })).toEqual({ github: 'needs_auth' });
  });

  test('persists only sanitized issue kinds and rehydrates them across restarts', async () => {
    const secretError = 'Authorization: Bearer super-secret-token';
    statusData = { linear: { status: 'failed', error: secretError } };

    await useMcpStore.getState().refresh({ directory: '/repo/one', silent: true });

    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/one')).toEqual({ linear: 'failed' });
    expect(useMcpStore.getState().getDiagnosticForDirectory('/repo/one').linear?.error).toBe(secretError);

    const persisted = getSafeStorage().getItem(STORAGE_KEY);
    expect(persisted).toContain('failed');
    expect(persisted).not.toContain(secretError);

    useMcpStore.setState({ issueKindsByDirectory: {} });
    getSafeStorage().setItem(STORAGE_KEY, persisted ?? '');
    await useMcpStore.persist.rehydrate();

    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/one')).toEqual({ linear: 'failed' });
  });

  test('keeps issue history isolated by normalized directory', async () => {
    statusData = { linear: { status: 'needs_auth' } };
    await useMcpStore.getState().refresh({ directory: '/repo/one/', silent: true });

    statusData = { github: { status: 'needs_client_registration', error: 'register first' } };
    await useMcpStore.getState().refresh({ directory: '/repo/two', silent: true });

    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/one')).toEqual({ linear: 'needs_auth' });
    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/two')).toEqual({
      github: 'needs_client_registration',
    });
  });

  test('records failed connection attempts without changing configured enablement', async () => {
    connectError = new Error('missing credentials');
    let observedError: unknown;

    try {
      await useMcpStore.getState().connect('linear', '/repo/one');
    } catch (error) {
      observedError = error;
    }

    expect(observedError instanceof Error).toBe(true);
    expect((observedError as Error).message).toBe('missing credentials');
    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/one')).toEqual({ linear: 'failed' });
  });

  test('a successful connection test clears remembered issues before cleanup disconnect', async () => {
    useMcpStore.setState({
      issueKindsByDirectory: { '/repo/one': { linear: 'failed' } },
      byDirectory: { '/repo/one': { linear: { status: 'disabled' } } },
    });
    statusData = { linear: { status: 'connected' } };

    const result = await useMcpStore.getState().testConnection('linear', '/repo/one');

    expect(result.status).toEqual({ status: 'connected' });
    expect(useMcpStore.getState().getIssueKindsForDirectory('/repo/one')).toEqual({});
  });

  test('clearIssue removes only the selected server in the selected directory', () => {
    useMcpStore.setState({
      issueKindsByDirectory: {
        '/repo/one': { linear: 'failed', github: 'needs_auth' },
        '/repo/two': { linear: 'needs_client_registration' },
      },
    });

    useMcpStore.getState().clearIssue('linear', '/repo/one');

    expect(useMcpStore.getState().issueKindsByDirectory).toEqual({
      '/repo/one': { github: 'needs_auth' },
      '/repo/two': { linear: 'needs_client_registration' },
    });
  });
});
