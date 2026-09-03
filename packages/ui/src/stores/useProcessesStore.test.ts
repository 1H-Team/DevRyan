import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ManagedProcessInfo, ProcessesAPI, ProcessesSnapshot, RuntimeAPIs } from '@/lib/api/types';
import {
  PROCESSES_TAB_ID,
  formatProcessAge,
  groupProcessesBySession,
  useProcessesStore,
} from './useProcessesStore';

const makeProcess = (overrides: Partial<ManagedProcessInfo>): ManagedProcessInfo => ({
  pid: 1,
  ppid: 0,
  pgid: 1,
  startedAt: 1_000,
  ageMs: 5_000,
  command: 'node server.js',
  category: 'other',
  ports: [],
  sessionId: null,
  ...overrides,
});

const makeSnapshot = (processes: ManagedProcessInfo[] = []): ProcessesSnapshot => ({
  supported: true,
  processes,
  orphanServers: [],
});

type FakeApi = ProcessesAPI & { listCalls: Array<string | null | undefined>; stopCalls: Array<[number, number | null]> };

const installFakeApi = (overrides: Partial<ProcessesAPI> = {}): FakeApi => {
  const api: FakeApi = {
    listCalls: [],
    stopCalls: [],
    async list(directory) {
      api.listCalls.push(directory);
      return makeSnapshot([makeProcess({ pid: 201, sessionId: 'ses_a', category: 'dev_server', ports: [5173] })]);
    },
    async stop(pid, startedAt) {
      api.stopCalls.push([pid, startedAt]);
      return { pid, terminated: true, stoppedDescendants: [] };
    },
    async getProjectSetting(directory) {
      return { directory, trackAgentProcesses: false, heavyCheckSlots: 2 };
    },
    async setProjectSetting(directory, value) {
      return { directory, trackAgentProcesses: value.trackAgentProcesses === true, heavyCheckSlots: value.heavyCheckSlots ?? 2 };
    },
    ...overrides,
  };
  registerRuntimeAPIs({ processes: api } as unknown as RuntimeAPIs);
  return api;
};

const waitFor = async (predicate: () => boolean, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition was not reached');
};

describe('useProcessesStore helpers', () => {
  test('groups processes by session, unattributed last', () => {
    const groups = groupProcessesBySession([
      makeProcess({ pid: 1, sessionId: null }),
      makeProcess({ pid: 2, sessionId: 'ses_b' }),
      makeProcess({ pid: 3, sessionId: 'ses_a' }),
      makeProcess({ pid: 4, sessionId: 'ses_b' }),
    ]);
    expect(groups.map((group) => group.sessionId)).toEqual(['ses_b', 'ses_a', null]);
    expect(groups[0].processes.map((entry) => entry.pid)).toEqual([2, 4]);
    expect(groups[2].processes.map((entry) => entry.pid)).toEqual([1]);
    expect(groupProcessesBySession([])).toEqual([]);
  });

  test('formats ages compactly', () => {
    expect(formatProcessAge(null)).toBe('—');
    expect(formatProcessAge(45_000)).toBe('45s');
    expect(formatProcessAge(5 * 60_000)).toBe('5m');
    expect(formatProcessAge(2 * 3_600_000 + 10 * 60_000)).toBe('2h 10m');
    expect(formatProcessAge(26 * 3_600_000)).toBe('1d 2h');
  });

  test('uses an id that can never collide with a terminal tab', () => {
    expect(PROCESSES_TAB_ID.startsWith('__')).toBe(true);
  });
});

describe('useProcessesStore', () => {
  beforeEach(() => {
    useProcessesStore.setState({
      snapshot: null,
      directory: null,
      isLoading: false,
      error: null,
      lastFetchedAt: null,
      stoppingPids: [],
    });
  });

  afterEach(() => {
    registerRuntimeAPIs(null);
  });

  test('refresh stores the snapshot for the requested directory', async () => {
    const api = installFakeApi();
    await useProcessesStore.getState().refresh('/repo');

    const state = useProcessesStore.getState();
    expect(api.listCalls).toEqual(['/repo']);
    expect(state.snapshot?.processes.map((entry) => entry.pid)).toEqual([201]);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.directory).toBe('/repo');
  });

  test('refresh records errors without dropping the last snapshot', async () => {
    installFakeApi();
    await useProcessesStore.getState().refresh('/repo');
    installFakeApi({
      async list() {
        throw new Error('boom');
      },
    });
    await useProcessesStore.getState().refresh();

    const state = useProcessesStore.getState();
    expect(state.error).toBe('boom');
    expect(state.snapshot?.processes).toHaveLength(1);
  });

  test('refresh is a no-op without a processes API', async () => {
    registerRuntimeAPIs(null);
    await useProcessesStore.getState().refresh('/repo');
    expect(useProcessesStore.getState().snapshot).toBeNull();
  });

  test('stop forwards pid and startedAt, then refreshes', async () => {
    const api = installFakeApi();
    await useProcessesStore.getState().refresh('/repo');

    const terminated = await useProcessesStore.getState().stop(201, 1_000);

    expect(terminated).toBe(true);
    expect(api.stopCalls).toEqual([[201, 1_000]]);
    expect(api.listCalls).toEqual(['/repo', '/repo']);
    expect(useProcessesStore.getState().stoppingPids).toEqual([]);
  });

  test('stop clears the stopping marker when the request fails', async () => {
    installFakeApi({
      async stop() {
        throw new Error('restarted');
      },
    });
    await expect(useProcessesStore.getState().stop(201, 1_000)).rejects.toThrow('restarted');
    expect(useProcessesStore.getState().stoppingPids).toEqual([]);
  });

  test('polling refreshes on an interval until the last subscriber releases it', async () => {
    const api = installFakeApi();
    const release = useProcessesStore.getState().startPolling('/repo', 5);
    await waitFor(() => api.listCalls.length >= 3);
    release();
    release();
    const settled = api.listCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.listCalls.length).toBe(settled);
    expect(api.listCalls.every((directory) => directory === '/repo')).toBe(true);
  });
});
