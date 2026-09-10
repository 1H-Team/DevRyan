import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { useConfigStore } from './useConfigStore';
import { useAgentsStore, type AgentWithExtras } from './useAgentsStore';
import { useSelectionStore } from '@/sync/selection-store';

const agent = (overrides: Partial<AgentWithExtras> = {}): AgentWithExtras => ({
  name: 'explorer', mode: 'subagent', permission: [], options: {},
  model: { providerID: 'example', modelID: 'original' },
  modelRefs: ['example/original'], scope: 'project', source: 'project',
  native: false, builtIn: false, prompt: 'Project A instructions',
  ...overrides,
});
const snapshot = (agents: Agent[]) => ({
  agents, providers: [], currentProviderId: '', currentModelId: '',
  currentAgentName: undefined, selectedProviderId: '', defaultProviders: {},
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const json = (body: unknown) => new Response(JSON.stringify(body));

let originalAgents: ReturnType<typeof useAgentsStore.getState>;
let originalConfig: ReturnType<typeof useConfigStore.getState>;
let originalProjects: ReturnType<typeof useProjectsStore.getState>;
let originalSelection: ReturnType<typeof useSelectionStore.getState>;
let originalDirectory: ReturnType<typeof useDirectoryStore.getState>;
let originalClientDirectory: string | undefined;
let originalFetch: typeof fetch;
let originalNow: typeof Date.now;
let directory: string;
let now: number;
let fixtureId = 0;

beforeEach(() => {
  originalAgents = useAgentsStore.getState();
  originalConfig = useConfigStore.getState();
  originalProjects = useProjectsStore.getState();
  originalSelection = useSelectionStore.getState();
  originalDirectory = useDirectoryStore.getState();
  originalClientDirectory = opencodeClient.getDirectory();
  originalFetch = globalThis.fetch;
  originalNow = Date.now;
  now = originalNow();
  Date.now = () => now;
  directory = `/agent-reconciliation-fixture/${++fixtureId}`;
  opencodeClient.setDirectory(directory);
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useDirectoryStore.setState({ currentDirectory: directory });
  useAgentsStore.setState({ agents: [], staleModelOverrides: [], isLoading: false });
  useConfigStore.setState({
    activeDirectoryKey: directory, agents: [], directoryScoped: {}, currentAgentName: undefined,
  });
  globalThis.fetch = async () => { throw new Error('Unexpected fixture request'); };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  opencodeClient.setDirectory(originalClientDirectory);
  useDirectoryStore.setState(originalDirectory);
  useProjectsStore.setState(originalProjects);
  useSelectionStore.setState(originalSelection);
  useConfigStore.setState(originalConfig);
  useAgentsStore.setState(originalAgents);
});

const fetchWith = (implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = implementation;
};

describe('directory-owned agent saves', () => {
  for (const action of ['save', 'reset'] as const) {
    test(`${action} changes only the originating directory and preserves other catalog references`, async () => {
      const other = `${directory}/other`;
      const original = agent();
      const sibling = agent({ name: 'oracle' });
      const otherAgent = agent({
        prompt: 'Project B instructions',
        permission: [{ permission: 'bash', pattern: '*', action: 'deny' }],
        model: { providerID: 'example', modelID: 'project-b' }, modelRefs: ['example/project-b'],
      });
      const otherSnapshot = snapshot([otherAgent]);
      const missingSnapshot = snapshot([sibling]);
      useAgentsStore.setState({ agents: [original, sibling] });
      useConfigStore.setState({
        agents: [original, sibling],
        directoryScoped: {
          [directory]: snapshot([original, sibling]), [other]: otherSnapshot, '/missing-agent': missingSnapshot,
        },
      });
      const saved = agent({ model: { providerID: 'example', modelID: action }, modelRefs: [`example/${action}`] });
      fetchWith(async (_input, init) => {
        expect(init?.method).toBe(action === 'save' ? 'PUT' : 'DELETE');
        return json({ success: true, agent: { config: saved } });
      });

      if (action === 'save') await useAgentsStore.getState().saveAgentModelOverride('explorer', { model: 'example/save' });
      else await useAgentsStore.getState().resetAgentModelOverride('explorer');

      const state = useConfigStore.getState();
      expect(state.agents[0]).toEqual(saved);
      expect(state.agents[1]).toBe(sibling);
      expect(state.directoryScoped[directory].agents[0]).toEqual(saved);
      expect(state.directoryScoped[other]).toBe(otherSnapshot);
      expect(state.directoryScoped[other].agents[0]).toBe(otherAgent);
      expect(state.directoryScoped['/missing-agent']).toBe(missingSnapshot);
    });

    test(`a late ${action} response cannot replace the newly active project`, async () => {
      const pending = deferred<Response>();
      const original = agent();
      useAgentsStore.setState({ agents: [original] });
      useConfigStore.setState({ agents: [original], directoryScoped: { [directory]: snapshot([original]) } });
      fetchWith(async () => pending.promise);
      const mutation = action === 'save'
        ? useAgentsStore.getState().saveAgentModelOverride('explorer', { model: 'example/saved' })
        : useAgentsStore.getState().resetAgentModelOverride('explorer');

      const other = `${directory}/other`;
      const otherAgents = [agent({ prompt: 'Project B instructions' })];
      const otherSnapshot = { ...snapshot(otherAgents), currentAgentName: 'explorer', currentModelId: 'project-b' };
      opencodeClient.setDirectory(other);
      useDirectoryStore.setState({ currentDirectory: other });
      useAgentsStore.setState({ agents: otherAgents });
      useConfigStore.setState({
        ...otherSnapshot, activeDirectoryKey: other,
        directoryScoped: { ...useConfigStore.getState().directoryScoped, [other]: otherSnapshot },
      });
      pending.resolve(json({ agent: { config: agent({ prompt: 'Saved project A instructions' }) } }));
      await mutation;

      expect(useAgentsStore.getState().agents).toBe(otherAgents);
      expect(useConfigStore.getState().agents).toBe(otherAgents);
      expect(useConfigStore.getState().currentModelId).toBe('project-b');
      expect(useConfigStore.getState().directoryScoped[other]).toBe(otherSnapshot);
      expect(useConfigStore.getState().directoryScoped[directory].agents[0].prompt).toBe('Saved project A instructions');
    });
  }

  test('success-only responses use the fallback captured before a project switch', async () => {
    const pending = deferred<Response>();
    const original = agent({ variant: 'high' });
    useAgentsStore.setState({ agents: [original] });
    useConfigStore.setState({ agents: [original], directoryScoped: { [directory]: snapshot([original]) } });
    fetchWith(async () => pending.promise);
    const saving = useAgentsStore.getState().saveAgentModelOverride('explorer', { model: 'example/saved', variant: null });
    opencodeClient.setDirectory(`${directory}/other`);
    const otherAgents = [agent({ prompt: 'Project B instructions' })];
    useAgentsStore.setState({ agents: otherAgents });
    useConfigStore.setState({ agents: otherAgents, activeDirectoryKey: `${directory}/other` });
    pending.resolve(json({ success: true }));
    await saving;
    expect(useAgentsStore.getState().agents).toBe(otherAgents);
    expect(useConfigStore.getState().directoryScoped[directory].agents[0]).toMatchObject({
      prompt: 'Project A instructions', model: { providerID: 'example', modelID: 'saved' },
    });
    expect(useConfigStore.getState().directoryScoped[directory].agents[0].variant).toBeUndefined();
  });

  test('saving unchanged configuration preserves catalogs and directory snapshots', async () => {
    const agents = [agent()];
    const scoped = { [directory]: snapshot(agents) };
    useAgentsStore.setState({ agents });
    useConfigStore.setState({
      agents, directoryScoped: scoped, currentAgentName: 'explorer',
      currentProviderId: 'example', currentModelId: 'original', currentVariant: undefined,
    });
    fetchWith(async () => json({ agent: { config: agent() } }));
    await useAgentsStore.getState().saveAgentModelOverride('explorer', { model: 'example/original' });
    expect(useAgentsStore.getState().agents).toBe(agents);
    expect(useConfigStore.getState().agents).toBe(agents);
    expect(useConfigStore.getState().directoryScoped).toBe(scoped);
  });

  for (const action of ['save', 'reset'] as const) {
    test(`a late backup ${action} leaves the newly selected catalog untouched`, async () => {
      const pending = deferred<Response>();
      useAgentsStore.setState({ agents: [agent()] });
      fetchWith(async () => pending.promise);
      const mutation = action === 'save'
        ? useAgentsStore.getState().saveAgentBackupModel('explorer', { model: 'example/backup' })
        : useAgentsStore.getState().resetAgentBackupModel('explorer');
      opencodeClient.setDirectory(`${directory}/other`);
      const other = [agent({ backupModel: { providerID: 'example', modelID: 'other-backup', variant: null } })];
      useAgentsStore.setState({ agents: other });
      pending.resolve(json({ success: true }));
      await mutation;
      expect(useAgentsStore.getState().agents).toBe(other);
    });
  }
});

describe('complete agent catalog reconciliation', () => {
  const changes: Array<[string, Partial<AgentWithExtras>]> = [
    ['prompt', { prompt: 'New instructions' }],
    ['permissions', { permission: [{ permission: 'bash', pattern: '*', action: 'deny' }] }],
    ['backup', { backupModel: { providerID: 'example', modelID: 'backup', variant: 'high' } }],
    ['councillor thinking', { councillors: [{ model: 'example/original', variant: 'high' }] }],
    ['provenance', { modelResolution: { presetName: 'review', source: 'preset', presetModelRef: 'example/original', presetVariant: null } }],
    ['explicit null', { backupModel: null }],
  ];
  for (const [label, change] of changes) {
    test(`loads a ${label}-only change without replacing unrelated agents`, async () => {
      let updated = false;
      fetchWith(async () => json({ agents: [agent(updated ? change : {}), agent({ name: 'oracle' })], staleOverrides: ['retired'] }));
      await useAgentsStore.getState().loadAgents();
      const initial = useAgentsStore.getState();
      now += 6000;
      updated = true;
      await useAgentsStore.getState().loadAgents();
      const current = useAgentsStore.getState();
      expect(current.agents[0]).toMatchObject(change);
      expect(current.agents[0]).not.toBe(initial.agents[0]);
      expect(current.agents[1]).toBe(initial.agents[1]);
      expect(current.staleModelOverrides).toBe(initial.staleModelOverrides);
    });
  }

  test('object key order is irrelevant but ordered councillors are significant', async () => {
    const original = agent({ options: { alpha: true, beta: false }, councillors: [{ model: 'example/one' }, { model: 'example/two' }] });
    let next = original;
    fetchWith(async () => json({ agents: [next], staleOverrides: [] }));
    await useAgentsStore.getState().loadAgents();
    const initial = useAgentsStore.getState().agents;
    next = { ...original, options: { beta: false, alpha: true } };
    now += 6000;
    await useAgentsStore.getState().loadAgents();
    expect(useAgentsStore.getState().agents).toBe(initial);
    next = { ...next, councillors: [{ model: 'example/two' }, { model: 'example/one' }] };
    now += 6000;
    await useAgentsStore.getState().loadAgents();
    expect(useAgentsStore.getState().agents[0]).toMatchObject({ councillors: next.councillors });
  });

  test('compares against state at response time, not the catalog captured before loading', async () => {
    const original = agent();
    useAgentsStore.setState({ agents: [original] });
    const pending = deferred<Response>();
    fetchWith(async () => pending.promise);
    const loading = useAgentsStore.getState().loadAgents();
    useAgentsStore.setState({ agents: [agent({ description: 'An intermediate catalog' })] });
    pending.resolve(json({ agents: [original] }));
    await loading;
    expect(useAgentsStore.getState().agents[0]).toEqual(original);
  });

  test('a late catalog response does not replace the current project and releases loading state', async () => {
    const pending = deferred<Response>();
    fetchWith(async () => pending.promise);
    const loading = useAgentsStore.getState().loadAgents();
    opencodeClient.setDirectory(`${directory}/other`);
    const otherAgents = [agent({ prompt: 'Project B instructions' })];
    const staleModelOverrides = ['project-b-only'];
    useAgentsStore.setState({ agents: otherAgents, staleModelOverrides });
    pending.resolve(json({ agents: [agent()], staleOverrides: [] }));
    expect(await loading).toBe(false);
    expect(useAgentsStore.getState().agents).toBe(otherAgents);
    expect(useAgentsStore.getState().staleModelOverrides).toBe(staleModelOverrides);
    expect(useAgentsStore.getState().isLoading).toBe(false);
  });
});
