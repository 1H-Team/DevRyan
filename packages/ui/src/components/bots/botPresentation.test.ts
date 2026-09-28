import { describe, expect, test } from 'bun:test';
import {
  canOpenDockerDesktop,
  resolveBotCatalogReadiness,
} from './botPresentation';

type Input = Parameters<typeof resolveBotCatalogReadiness>[0];

const base: Input = {
  capabilities: null,
  capabilitiesErrorCode: null,
  catalogLoaded: false,
  catalogErrorCode: null,
};

const closed = (
  state: string,
  database: string | null = 'unavailable',
  code: string | null = null,
): Input['capabilities'] => ({
  state,
  code,
  catalogAvailable: false,
  database: database ? { state: database as never, code } : null,
});

const open: Input['capabilities'] = {
  state: 'healthy', code: null, catalogAvailable: true, database: { state: 'ready', code: null },
};

describe('resolveBotCatalogReadiness', () => {
  test('explains a stopped Docker Desktop instead of loading', () => {
    expect(resolveBotCatalogReadiness({
      ...base,
      capabilities: closed('docker_stopped', 'unavailable', 'bot_runtime_docker_unavailable'),
    })).toEqual({
      kind: 'blocked',
      messageKey: 'bots.runtime.dockerStopped',
      code: 'bot_runtime_docker_unavailable',
      pending: false,
      canRetry: true,
    });
  });

  test('reports disabled access without a retry', () => {
    expect(resolveBotCatalogReadiness({
      ...base,
      capabilities: { state: 'unavailable', code: 'bots_access_disabled' },
    })).toMatchObject({ kind: 'blocked', messageKey: 'bots.sidebar.accessDisabled', pending: false, canRetry: false });
  });

  test('keeps waiting while Bot storage starts', () => {
    for (const capabilities of [closed('bots_starting', null), closed('healthy', 'starting')]) {
      expect(resolveBotCatalogReadiness({ ...base, capabilities })).toMatchObject({
        kind: 'starting', messageKey: 'bots.runtime.progress.starting_database', pending: true, canRetry: false,
      });
    }
  });

  test('keeps waiting during maintenance', () => {
    for (const capabilities of [closed('bots_maintenance', null), closed('healthy', 'maintenance')]) {
      expect(resolveBotCatalogReadiness({ ...base, capabilities })).toMatchObject({
        kind: 'maintenance', messageKey: 'bots.runtime.storageMaintenance', pending: true, canRetry: false,
      });
    }
  });

  test('asks for recovery', () => {
    for (const capabilities of [closed('database_recovery_required', null), closed('healthy', 'recovery_required')]) {
      expect(resolveBotCatalogReadiness({ ...base, capabilities })).toMatchObject({
        kind: 'recovery', messageKey: 'bots.runtime.storageRecovery', pending: false, canRetry: true,
      });
    }
  });

  test('does not offer a retry on an unsupported host', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilities: closed('unsupported_host', null) })).toMatchObject({
      kind: 'blocked', messageKey: 'bots.runtime.unsupportedHost', pending: false, canRetry: false,
    });
  });

  test('names unavailable storage', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilities: closed('catalog_unavailable') })).toMatchObject({
      kind: 'blocked', messageKey: 'bots.runtime.storageUnavailable', canRetry: true,
    });
    // `healthy` has no runtime message, so a closed gate falls back to storage.
    expect(resolveBotCatalogReadiness({ ...base, capabilities: closed('healthy') })).toMatchObject({
      kind: 'blocked', messageKey: 'bots.runtime.storageUnavailable', canRetry: true,
    });
  });

  test('reuses the runtime message for other blocked states', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilities: closed('docker_not_installed') }).messageKey)
      .toBe('bots.runtime.dockerNotInstalled');
    expect(resolveBotCatalogReadiness({ ...base, capabilities: closed('setup_required', 'setup_required') }).messageKey)
      .toBe('bots.runtime.setupRequired');
  });

  test('keeps waiting when the catalog read reports starting', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilities: open, catalogErrorCode: 'bots_starting' })).toMatchObject({
      kind: 'starting', pending: true, canRetry: false,
    });
  });

  test('reports a failed catalog read', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilities: open, catalogErrorCode: 'network_error' })).toEqual({
      kind: 'load_failed', messageKey: 'bots.sidebar.loadFailed', code: 'network_error', pending: false, canRetry: true,
    });
  });

  test('is ready once the catalog was read, even before capabilities arrive', () => {
    expect(resolveBotCatalogReadiness({ ...base, catalogLoaded: true })).toMatchObject({ kind: 'ready', messageKey: null });
    expect(resolveBotCatalogReadiness({ ...base, catalogLoaded: true, capabilitiesErrorCode: 'network_error' }).kind)
      .toBe('ready');
  });

  test('reports a failed capability check', () => {
    expect(resolveBotCatalogReadiness({ ...base, capabilitiesErrorCode: 'network_error' })).toEqual({
      kind: 'capabilities_failed', messageKey: 'bots.sidebar.checkFailed', code: 'network_error', pending: false, canRetry: true,
    });
  });

  test('loads while the first read is in flight', () => {
    expect(resolveBotCatalogReadiness(base)).toMatchObject({ kind: 'checking', pending: true, canRetry: false });
    expect(resolveBotCatalogReadiness({ ...base, capabilities: open })).toMatchObject({ kind: 'loading', pending: true });
  });

  test('never reads as pending without a cause that resolves on its own', () => {
    const blocked = [
      'docker_stopped', 'docker_not_installed', 'setup_required', 'image_update_available', 'runtime_degraded',
      'catalog_unavailable', 'migration_required', 'encryption_unavailable', 'unsupported_host', 'healthy',
    ];
    for (const state of blocked) {
      const readiness = resolveBotCatalogReadiness({ ...base, capabilities: closed(state) });
      expect(readiness.pending).toBe(false);
      expect(readiness.messageKey).not.toBeNull();
    }
  });

  test('reaches the empty state only after a successful read', () => {
    const inputs: Input[] = [
      base,
      { ...base, capabilities: open },
      { ...base, capabilities: closed('docker_stopped') },
      { ...base, capabilities: closed('docker_stopped'), catalogLoaded: true },
      { ...base, capabilitiesErrorCode: 'network_error' },
      { ...base, capabilities: open, catalogLoaded: true, catalogErrorCode: 'network_error' },
    ];
    for (const input of inputs) expect(resolveBotCatalogReadiness(input).kind).not.toBe('ready');
    expect(resolveBotCatalogReadiness({ ...base, capabilities: open, catalogLoaded: true }).kind).toBe('ready');
  });
});

describe('canOpenDockerDesktop', () => {
  test('is offered only by the native shell while Docker is stopped', () => {
    expect(canOpenDockerDesktop({ state: 'docker_stopped' }, true)).toBe(true);
    expect(canOpenDockerDesktop({ state: 'docker_stopped' }, false)).toBe(false);
    expect(canOpenDockerDesktop({ state: 'docker_not_installed' }, true)).toBe(false);
    expect(canOpenDockerDesktop(null, true)).toBe(false);
  });
});
