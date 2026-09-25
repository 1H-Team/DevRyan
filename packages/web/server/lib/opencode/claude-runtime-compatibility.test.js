import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_RUNTIME_CANDIDATE,
  CLAUDE_RUNTIME_CONTROL,
  CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
  CLAUDE_RUNTIME_MANAGED_OVERRIDES,
  CLAUDE_RUNTIME_SELECTION,
  inspectClaudeRuntimeCompatibility,
  mergeManagedClaudeRuntimeDependencies,
  mergeManagedClaudeRuntimeOverrides,
} from './claude-runtime-compatibility.js';

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('Claude runtime compatibility', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-claude-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects Claude Code 2.1.281 while preserving the historical control tuple', () => {
    expect(CLAUDE_RUNTIME_CONTROL.claudeCode).toBe('2.1.215');
    expect(CLAUDE_RUNTIME_CANDIDATE.claudeCode).toBe('2.1.281');
    expect(CLAUDE_RUNTIME_SELECTION).toMatchObject({
      channel: 'candidate',
      compatibilityStatus: 'upstream_blocked',
      versions: CLAUDE_RUNTIME_CANDIDATE,
    });
  });

  it('updates a previously managed override while preserving unrelated overrides', () => {
    const result = mergeManagedClaudeRuntimeOverrides(
      {
        overrides: {
          '@anthropic-ai/claude-agent-sdk': '0.2.140',
          '@anthropic-ai/claude-code': '2.1.200',
          unrelated: '3.0.0',
        },
      },
      { overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES },
      {
        managedOverrides: {
          '@anthropic-ai/claude-agent-sdk': '0.2.140',
          '@anthropic-ai/claude-code': '2.1.200',
        },
        sources: {
          '@anthropic-ai/claude-agent-sdk': 'managed',
          '@anthropic-ai/claude-code': 'managed',
        },
      },
    );

    expect(result.overrides).toEqual({
      ...CLAUDE_RUNTIME_MANAGED_OVERRIDES,
      unrelated: '3.0.0',
    });
    expect(result.sources).toEqual({
      '@anthropic-ai/claude-agent-sdk': 'managed',
      '@anthropic-ai/claude-code': 'managed',
    });
  });

  // Real-world upgrade: profiles provisioned while DevRyan selected Claude Code
  // 2.1.251 carry that exact managed pin in both package.json and the marker.
  const LEGACY_MANAGED_CLAUDE_CODE = '2.1.251';

  it('upgrades a marker-recorded managed Claude Code 2.1.251 override to the selected release', () => {
    expect(LEGACY_MANAGED_CLAUDE_CODE).not.toBe(CLAUDE_RUNTIME_CANDIDATE.claudeCode);
    const result = mergeManagedClaudeRuntimeOverrides(
      {
        overrides: {
          '@anthropic-ai/claude-agent-sdk': CLAUDE_RUNTIME_CANDIDATE.agentSdk,
          '@anthropic-ai/claude-code': LEGACY_MANAGED_CLAUDE_CODE,
          unrelated: '3.0.0',
        },
      },
      { overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES },
      {
        managedOverrides: {
          '@anthropic-ai/claude-agent-sdk': CLAUDE_RUNTIME_CANDIDATE.agentSdk,
          '@anthropic-ai/claude-code': LEGACY_MANAGED_CLAUDE_CODE,
        },
        sources: {
          '@anthropic-ai/claude-agent-sdk': 'managed',
          '@anthropic-ai/claude-code': 'managed',
        },
      },
    );

    expect(result.overrides).toEqual({
      '@anthropic-ai/claude-agent-sdk': CLAUDE_RUNTIME_CANDIDATE.agentSdk,
      '@anthropic-ai/claude-code': CLAUDE_RUNTIME_CANDIDATE.claudeCode,
      unrelated: '3.0.0',
    });
    expect(result.sources).toEqual({
      '@anthropic-ai/claude-agent-sdk': 'managed',
      '@anthropic-ai/claude-code': 'managed',
    });
  });

  it('reports a managed install still at Claude Code 2.1.251 as drifted from the selected release', () => {
    const configDirectory = path.join(root, 'config');
    const installedVersions = {
      'opencode-with-claude': CLAUDE_RUNTIME_CANDIDATE.opencodeWithClaude,
      '@rynfar/meridian': CLAUDE_RUNTIME_CANDIDATE.meridian,
      '@anthropic-ai/claude-agent-sdk': CLAUDE_RUNTIME_CANDIDATE.agentSdk,
      '@anthropic-ai/claude-code': LEGACY_MANAGED_CLAUDE_CODE,
    };
    for (const [name, version] of Object.entries(installedVersions)) {
      writeJson(path.join(configDirectory, 'node_modules', ...name.split('/'), 'package.json'), { name, version });
    }

    const result = inspectClaudeRuntimeCompatibility({
      configDirectory,
      packageJson: {
        dependencies: CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
        overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES,
      },
      sources: Object.fromEntries(Object.keys(installedVersions).map((name) => [name, 'managed'])),
      fs,
      path,
    });

    expect(result).toMatchObject({
      source: 'managed',
      compatibilityStatus: 'drifted',
      runtimeStatus: 'drifted',
      expected: { claudeCode: CLAUDE_RUNTIME_CANDIDATE.claudeCode },
      installed: { claudeCode: LEGACY_MANAGED_CLAUDE_CODE },
      missingPackages: [],
      versionMismatches: ['claudeCode'],
    });
  });

  it('treats an unmarked pre-existing exact pin as user-managed', () => {
    const result = mergeManagedClaudeRuntimeOverrides(
      { overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES },
      { overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES },
      null,
    );

    expect(result.overrides).toEqual(CLAUDE_RUNTIME_MANAGED_OVERRIDES);
    expect(result.sources).toEqual({
      '@anthropic-ai/claude-agent-sdk': 'user-managed',
      '@anthropic-ai/claude-code': 'user-managed',
    });
  });

  it('preserves an override that differs from the last managed value', () => {
    const result = mergeManagedClaudeRuntimeOverrides(
      { overrides: { '@anthropic-ai/claude-code': '2.1.214' } },
      { overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES },
      { managedOverrides: { '@anthropic-ai/claude-code': '2.1.200' } },
    );

    expect(result.overrides['@anthropic-ai/claude-code']).toBe('2.1.214');
    expect(result.sources['@anthropic-ai/claude-code']).toBe('user-managed');
    expect(result.sources['@anthropic-ai/claude-agent-sdk']).toBe('managed');
  });

  it('upgrades manifest-owned Claude dependencies while preserving unrelated dependencies', () => {
    const result = mergeManagedClaudeRuntimeDependencies(
      {
        dependencies: {
          '@rynfar/meridian': '1.57.0',
          'opencode-with-claude': '1.6.18',
          'profile-managed-plugin': '1.0.0',
          unrelated: '3.0.0',
        },
      },
      {
        dependencies: {
          ...CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
          'profile-managed-plugin': '2.0.0',
        },
      },
      null,
      { assumePreviouslyManaged: true },
    );

    expect(result.dependencies).toEqual({
      ...CLAUDE_RUNTIME_MANAGED_DEPENDENCIES,
      'profile-managed-plugin': '2.0.0',
      unrelated: '3.0.0',
    });
    expect(result.sources).toEqual({
      'opencode-with-claude': 'managed',
      '@rynfar/meridian': 'managed',
    });
  });

  it('preserves explicit unowned Claude dependency pins', () => {
    const result = mergeManagedClaudeRuntimeDependencies(
      {
        dependencies: {
          '@rynfar/meridian': '1.61.0',
          'opencode-with-claude': '1.7.0',
        },
      },
      { dependencies: CLAUDE_RUNTIME_MANAGED_DEPENDENCIES },
      null,
    );

    expect(result.dependencies).toMatchObject({
      '@rynfar/meridian': '1.61.0',
      'opencode-with-claude': '1.7.0',
    });
    expect(result.sources).toEqual({
      'opencode-with-claude': 'user-managed',
      '@rynfar/meridian': 'user-managed',
    });
  });

  it('reports missing and corrupt installed package metadata without throwing', () => {
    const configDirectory = path.join(root, 'config');
    writeJson(path.join(configDirectory, 'package.json'), {
      dependencies: {
        '@rynfar/meridian': '1.62.6',
        'opencode-with-claude': '1.8.0',
      },
      overrides: CLAUDE_RUNTIME_MANAGED_OVERRIDES,
    });
    writeJson(
      path.join(configDirectory, 'node_modules', '@rynfar', 'meridian', 'package.json'),
      { version: '1.62.6' },
    );
    writeJson(
      path.join(configDirectory, 'node_modules', 'opencode-with-claude', 'package.json'),
      { version: '1.8.0' },
    );
    const corruptPath = path.join(
      configDirectory,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    );
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, '{invalid\n', 'utf8');

    const result = inspectClaudeRuntimeCompatibility({ configDirectory, fs, path });

    expect(result).toMatchObject({
      source: 'managed',
      compatibilityStatus: 'drifted',
      runtimeStatus: 'missing',
      installed: {
        opencodeWithClaude: '1.8.0',
        meridian: '1.62.6',
        agentSdk: null,
        claudeCode: null,
      },
      missingPackages: ['agentSdk', 'claudeCode'],
    });
  });
});
