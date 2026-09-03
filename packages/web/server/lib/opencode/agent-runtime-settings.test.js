import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUNTIME_SETTINGS_CACHE_TTL_MS,
  AGENT_RUNTIME_SETTINGS_KEY,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
  clearAgentRuntimeSettingsCache,
  normalizeAgentRuntimeSettings,
  readAgentRuntimeSettings,
  writeAgentRuntimeSettings,
} from './agent-runtime-settings.js';
import { getOpenchamberSidecarPath } from './openchamber-sidecar.js';

describe('agent runtime settings sidecar', () => {
  let tempRoot;
  let userConfigPath;
  let sidecarPath;

  const readSidecar = async () => JSON.parse(await fs.readFile(sidecarPath, 'utf8'));

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-runtime-settings-'));
    userConfigPath = path.join(tempRoot, 'opencode.json');
    sidecarPath = getOpenchamberSidecarPath(userConfigPath);
    clearAgentRuntimeSettingsCache();
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearAgentRuntimeSettingsCache();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('defaults to lsp enabled when no sidecar exists', () => {
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: true });
    expect(DEFAULT_AGENT_RUNTIME_SETTINGS).toEqual({ lsp: true });
  });

  it('normalizes unknown, missing, and non-boolean values to the defaults', () => {
    expect(normalizeAgentRuntimeSettings(undefined)).toEqual({ lsp: true });
    expect(normalizeAgentRuntimeSettings(null)).toEqual({ lsp: true });
    expect(normalizeAgentRuntimeSettings('nope')).toEqual({ lsp: true });
    expect(normalizeAgentRuntimeSettings({ lsp: 'false' })).toEqual({ lsp: true });
    expect(normalizeAgentRuntimeSettings({ lsp: 0 })).toEqual({ lsp: true });
    expect(normalizeAgentRuntimeSettings({ lsp: false, extra: 1 })).toEqual({ lsp: false });
    expect(normalizeAgentRuntimeSettings({ lsp: true })).toEqual({ lsp: true });
  });

  it('writes the setting under openchamber.agentRuntime without touching other sidecar keys', async () => {
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({
      agentOverrides: { builder: { model: 'openai/gpt-5.5' } },
      agentBackupModels: { builder: { model: 'openai/gpt-5.4-mini' } },
    }), 'utf8');

    expect(writeAgentRuntimeSettings({ lsp: false }, { userConfigPath })).toEqual({ lsp: false });

    await expect(readSidecar()).resolves.toEqual({
      agentOverrides: { builder: { model: 'openai/gpt-5.5' } },
      agentBackupModels: { builder: { model: 'openai/gpt-5.4-mini' } },
      [AGENT_RUNTIME_SETTINGS_KEY]: { lsp: false },
    });
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: false });
    // The user's opencode config file itself is never created or modified.
    await expect(fs.stat(userConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates the sidecar when none exists and merges partial writes', async () => {
    writeAgentRuntimeSettings({ lsp: false }, { userConfigPath });
    await expect(readSidecar()).resolves.toEqual({ [AGENT_RUNTIME_SETTINGS_KEY]: { lsp: false } });

    writeAgentRuntimeSettings({}, { userConfigPath });
    await expect(readSidecar()).resolves.toEqual({ [AGENT_RUNTIME_SETTINGS_KEY]: { lsp: false } });

    writeAgentRuntimeSettings({ lsp: true }, { userConfigPath });
    await expect(readSidecar()).resolves.toEqual({ [AGENT_RUNTIME_SETTINGS_KEY]: { lsp: true } });
  });

  it('rejects unknown keys and non-boolean values without writing', async () => {
    expect(() => writeAgentRuntimeSettings({ lsp: 'off' }, { userConfigPath }))
      .toThrow('Agent runtime setting "lsp" must be a boolean');
    expect(() => writeAgentRuntimeSettings({ formatter: false }, { userConfigPath }))
      .toThrow('Unknown agent runtime setting: formatter');
    expect(() => writeAgentRuntimeSettings(null, { userConfigPath }))
      .toThrow('Agent runtime settings must be a plain object');
    expect(() => writeAgentRuntimeSettings(['lsp'], { userConfigPath }))
      .toThrow('Agent runtime settings must be a plain object');
    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('caches reads for five seconds and invalidates the cache on write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));

    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: true });

    // An out-of-band sidecar edit is invisible while the cache is warm...
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({ [AGENT_RUNTIME_SETTINGS_KEY]: { lsp: false } }), 'utf8');
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: true });

    // ...and visible once the TTL has elapsed.
    vi.advanceTimersByTime(AGENT_RUNTIME_SETTINGS_CACHE_TTL_MS + 1);
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: false });

    // A write through the module invalidates immediately.
    writeAgentRuntimeSettings({ lsp: true }, { userConfigPath });
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: true });
  });

  it('returns defensive copies so callers cannot mutate the cache', () => {
    const first = readAgentRuntimeSettings({ userConfigPath });
    first.lsp = false;
    expect(readAgentRuntimeSettings({ userConfigPath })).toEqual({ lsp: true });
  });
});
