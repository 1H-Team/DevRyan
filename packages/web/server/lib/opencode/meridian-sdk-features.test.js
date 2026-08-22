import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyManagedMeridianSdkFeaturePolicy,
  readMeridianPromptMode,
  setMeridianPromptCompatibilityMode,
} from './meridian-sdk-features.js';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('managed Meridian SDK feature policy', () => {
  let root;
  let settingsPath;
  let markerPath;

  const applyPolicy = () => applyManagedMeridianSdkFeaturePolicy({
    fs,
    path,
    settingsPath,
    markerPath,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-meridian-policy-'));
    settingsPath = path.join(root, 'meridian', 'sdk-features.json');
    markerPath = path.join(root, 'opencode', '.openchamber', 'meridian-sdk-features-policy.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readPromptMode = () => readMeridianPromptMode({ fs, path, settingsPath, markerPath });
  const setCompatibilityMode = (enabled, overrides = {}) => setMeridianPromptCompatibilityMode(
    enabled,
    { fs, path, settingsPath, markerPath, ...overrides },
  );

  it('seeds combined prompting into a blank configuration and is idempotent', () => {
    const first = applyPolicy();
    const second = applyPolicy();

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      settingsChanged: true,
      migrated: false,
      promptMode: 'combined',
      managedFields: ['codeSystemPrompt', 'clientSystemPrompt'],
    });
    expect(second).toMatchObject({
      ok: true,
      changed: false,
      settingsChanged: false,
      markerChanged: false,
      promptMode: 'combined',
    });
    expect(readJson(settingsPath)).toEqual({
      opencode: {
        codeSystemPrompt: true,
        clientSystemPrompt: true,
      },
    });
  });

  it('migrates the exact legacy OpenCode defaults once and preserves other adapters', () => {
    writeJson(settingsPath, {
      opencode: {
        codeSystemPrompt: true,
        clientSystemPrompt: true,
        claudeMd: 'off',
        memory: false,
        dreaming: false,
      },
      codex: {
        clientSystemPrompt: false,
        custom: 'keep',
      },
      unknown: { enabled: true },
    });

    const result = applyPolicy();
    const settings = readJson(settingsPath);

    expect(result).toMatchObject({
      ok: true,
      migrated: true,
      promptMode: 'combined',
    });
    expect(settings.opencode).toEqual({
      codeSystemPrompt: true,
      clientSystemPrompt: true,
      claudeMd: 'off',
      memory: false,
      dreaming: false,
    });
    expect(settings.codex).toEqual({
      clientSystemPrompt: false,
      custom: 'keep',
    });
    expect(settings.unknown).toEqual({ enabled: true });
  });

  it('preserves pre-existing non-default prompt choices and reports combined prompting', () => {
    writeJson(settingsPath, {
      opencode: {
        codeSystemPrompt: true,
        clientSystemPrompt: true,
        claudeMd: 'project',
        memory: false,
        dreaming: false,
      },
    });

    const result = applyPolicy();

    expect(result).toMatchObject({
      ok: true,
      migrated: false,
      promptMode: 'combined',
      managedFields: [],
      preservedFields: ['codeSystemPrompt', 'clientSystemPrompt'],
    });
    expect(result.warning).toBeNull();
    expect(readJson(settingsPath).opencode.codeSystemPrompt).toBe(true);
  });

  it('releases ownership when the user changes a managed field', () => {
    applyPolicy();
    const settings = readJson(settingsPath);
    settings.opencode.clientSystemPrompt = false;
    writeJson(settingsPath, settings);

    const userOverride = applyPolicy();
    const afterOverride = readJson(settingsPath);
    const nextRun = applyPolicy();

    expect(userOverride).toMatchObject({
      ok: true,
      promptMode: 'claude-only',
      managedFields: ['codeSystemPrompt'],
      preservedFields: ['clientSystemPrompt'],
    });
    expect(afterOverride.opencode.clientSystemPrompt).toBe(false);
    expect(nextRun).toMatchObject({
      ok: true,
      changed: false,
      promptMode: 'claude-only',
    });
  });

  it('migrates a previously owned client-only baseline to combined prompting', () => {
    writeJson(settingsPath, {
      opencode: { codeSystemPrompt: false, clientSystemPrompt: true },
    });
    writeJson(markerPath, {
      version: 1,
      migrationVersion: 1,
      fields: { codeSystemPrompt: false, clientSystemPrompt: true },
    });

    const result = applyPolicy();

    expect(result).toMatchObject({ ok: true, promptMode: 'combined' });
    expect(readJson(settingsPath).opencode).toEqual({
      codeSystemPrompt: true,
      clientSystemPrompt: true,
    });
  });

  it('persists explicit compatibility choices and preserves unrelated settings', () => {
    applyPolicy();
    const settings = readJson(settingsPath);
    settings.opencode.claudeMd = 'project';
    settings.codex = { clientSystemPrompt: false, custom: 'keep' };
    writeJson(settingsPath, settings);

    const enabled = setCompatibilityMode(true);
    const afterEnabled = readJson(settingsPath);
    const provisionedAgain = applyPolicy();
    const disabled = setCompatibilityMode(false);

    expect(enabled).toMatchObject({
      ok: true,
      compatibilityMode: true,
      mode: 'claude-only',
    });
    expect(afterEnabled.opencode).toEqual({
      codeSystemPrompt: true,
      clientSystemPrompt: false,
      claudeMd: 'project',
    });
    expect(afterEnabled.codex).toEqual({ clientSystemPrompt: false, custom: 'keep' });
    expect(readJson(markerPath).fields).toEqual({});
    expect(provisionedAgain).toMatchObject({
      ok: true,
      changed: false,
      promptMode: 'claude-only',
    });
    expect(disabled).toMatchObject({
      ok: true,
      compatibilityMode: false,
      mode: 'combined',
    });
    expect(readPromptMode()).toEqual({
      ok: true,
      compatibilityMode: false,
      mode: 'combined',
    });
  });

  it('fails compatibility writes without changing settings when the marker write fails', () => {
    applyPolicy();
    const originalSettings = fs.readFileSync(settingsPath, 'utf8');
    const failingFs = {
      ...fs,
      writeFileSync(filePath, ...args) {
        if (filePath === markerPath) throw new Error('marker is read-only');
        return fs.writeFileSync(filePath, ...args);
      },
    };

    const result = setCompatibilityMode(true, { fs: failingFs });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      code: 'meridian_prompt_mode_write_failed',
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(originalSettings);
  });

  it('does not touch unrelated credential and profile files', () => {
    const credentialsPath = path.join(root, 'meridian', 'credentials.json');
    const profilesPath = path.join(root, 'meridian', 'profiles.json');
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, 'credential sentinel\n', 'utf8');
    fs.writeFileSync(profilesPath, 'profile sentinel\n', 'utf8');

    applyPolicy();

    expect(fs.readFileSync(credentialsPath, 'utf8')).toBe('credential sentinel\n');
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe('profile sentinel\n');
  });

  it('fails visibly without overwriting malformed settings or markers', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{invalid\n', 'utf8');

    const invalidSettings = applyPolicy();

    expect(invalidSettings).toMatchObject({
      ok: false,
      changed: false,
      code: 'meridian_sdk_features_invalid_json',
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{invalid\n');
    expect(fs.existsSync(markerPath)).toBe(false);

    writeJson(settingsPath, {});
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '{invalid marker\n', 'utf8');

    const invalidMarker = applyPolicy();

    expect(invalidMarker).toMatchObject({
      ok: false,
      changed: false,
      code: 'meridian_policy_marker_invalid_json',
    });
    expect(readJson(settingsPath)).toEqual({});
  });
});
