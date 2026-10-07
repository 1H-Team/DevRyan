import { afterEach, describe, expect, test } from 'bun:test';
import { getAuthPrincipal, hasAuthCapability, setAuthPrincipal } from '../authSession';
import { createManagedOrchestrationApi } from '../orchestrationApi';
import { fetchScheduledTasks } from '../scheduledTasksApi';
import { getWorktreeBootstrapState, primeWorktreeBootstrap, waitForWorktreeBootstrapForSend } from '../worktrees/worktreeBootstrap';
import { opencodeClient } from './client';
import { RUNTIME_FEATURE_KEYS, assertRuntimeFeatureAvailable, beginRuntimeCapabilityRead,
  invalidateRuntimeCapabilities, isRuntimeFeatureAvailable, loadRuntimeCapabilities,
  observeRuntimeCapabilityHealth, parseRuntimeCapabilitySnapshot, resetRuntimeCapabilitiesForTests,
} from './runtime-capabilities';

const previewHealth = { openCode: { generation: 2, runtimeMode: 'standard-preview', ordinaryUserPermissions: true,
  capabilities: Object.fromEntries([...RUNTIME_FEATURE_KEYS, 'share', 'sessionShell', 'mcpOAuth'].map(key => [key, true])),
} };
const activate = () => observeRuntimeCapabilityHealth(previewHealth, beginRuntimeCapabilityRead());
afterEach(() => { resetRuntimeCapabilitiesForTests(); setAuthPrincipal(null); });

describe('Standard Preview capability contract', () => {
  test('allows only explicit ordinary features and refuses forged protected grants', () => {
    const snapshot = parseRuntimeCapabilitySnapshot(previewHealth);
    for (const key of ['chat', 'sessions', 'files', 'providerApiKey'] as const) expect(isRuntimeFeatureAvailable(key, snapshot)).toBe(true);
    for (const key of ['revert', 'nativeExecution', 'managedChildTasks', 'providerOAuth', 'bots', 'browser', 'media', 'terminal'] as const) expect(isRuntimeFeatureAvailable(key, snapshot)).toBe(false);
    expect(snapshot.capabilities.share).toBe(false);
    expect(snapshot.capabilities.sessionShell).toBe(false);
    expect(snapshot.capabilities.mcpOAuth).toBe(false);
    const malformed = parseRuntimeCapabilitySnapshot({ openCode: { ...previewHealth.openCode, ordinaryUserPermissions: 'true' } });
    expect(isRuntimeFeatureAvailable('chat', malformed)).toBe(false);
  });
  test('native health retains existing behavior and unchanged preview reads retain references', async () => {
    const native = parseRuntimeCapabilitySnapshot({ openCode: { generation: 2, capabilities: { sessionShell: true } } });
    expect(native.capabilities.sessionShell).toBe(true);
    for (const key of RUNTIME_FEATURE_KEYS) expect(isRuntimeFeatureAvailable(key, native)).toBe(true);
    const initial = activate(), principal = getAuthPrincipal();
    const refreshed = await loadRuntimeCapabilities({ force: true, fetchImpl: async () => Response.json(previewHealth) });
    expect(refreshed).toBe(initial);
    expect(getAuthPrincipal()).toBe(principal);
  });
  test('disconnect and malformed replacement health cannot restore protected UI', () => {
    activate(); invalidateRuntimeCapabilities();
    expect(isRuntimeFeatureAvailable('revert')).toBe(false);
    expect(isRuntimeFeatureAvailable('terminal')).toBe(false);
    observeRuntimeCapabilityHealth({ status: 'ok' }, beginRuntimeCapabilityRead());
    expect(isRuntimeFeatureAvailable('providerOAuth')).toBe(false);
    expect(() => assertRuntimeFeatureAvailable('revert')).toThrow('unavailable in Standard Preview');
  });
  test('availability intersects local administrator permissions without changing project rights', () => {
    const nativePrincipal = getAuthPrincipal(); activate(); const principal = getAuthPrincipal();
    for (const capability of ['terminal', 'browser', 'bots'] as const) {
      expect(hasAuthCapability(principal, capability)).toBe(false);
      expect(hasAuthCapability(nativePrincipal, capability)).toBe(false);
    }
    expect(hasAuthCapability(principal, 'files')).toBe(true);
    expect(hasAuthCapability(principal, 'manageProjects')).toBe(true);
    expect(hasAuthCapability(principal, 'createBranches')).toBe(true);
  });
  test('ordinary preview sends do not require native worktree bootstrap requests or receipts', async () => {
    activate();
    await primeWorktreeBootstrap('/preview/project');
    await waitForWorktreeBootstrapForSend('/preview/project');
    expect(getWorktreeBootstrapState('/preview/project')).toBeNull();
  });
  test('protected client requests fail before transport while native requests remain callable', async () => {
    activate(); let calls = 0;
    const api = createManagedOrchestrationApi({ fetchImpl: async () => { calls += 1; return Response.json({ tasks: [] }); } });
    await expect(api.getSnapshot()).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(fetchScheduledTasks('project')).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(opencodeClient.revertSessionScoped('session', 'message', '/project')).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(opencodeClient.unrevertSessionScoped('session', '/project')).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(opencodeClient.getSessionTreeChanges('session', '/project')).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(opencodeClient.sessionChangesAction('session', '/project', 'revision', 'undo')).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(calls).toBe(0); resetRuntimeCapabilitiesForTests(); await api.getSnapshot(); expect(calls).toBe(1);
  });
});
