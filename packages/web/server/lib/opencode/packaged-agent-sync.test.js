import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { syncPackagedAgents } from './packaged-agent-sync.js';

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

const agentContent = (name, prompt) => [
  '---',
  `name: ${name}`,
  'mode: primary',
  '---',
  '',
  prompt,
  '',
].join('\n');

const readAgentFrontmatter = async (agentDirectory, name) => {
  const content = await fs.readFile(path.join(agentDirectory, `${name}.md`), 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).toBeTruthy();
  return yaml.parse(match[1]) || {};
};

describe('syncPackagedAgents', () => {
  let tempRoot;
  let packagedAgentDirectory;
  let targetAgentDirectory;
  let manifestPath;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-packaged-agent-sync-'));
    packagedAgentDirectory = path.join(tempRoot, 'packaged-agents');
    targetAgentDirectory = path.join(tempRoot, 'runtime-agents');
    manifestPath = path.join(tempRoot, '.openchamber', 'packaged-agents.json');
    await fs.mkdir(packagedAgentDirectory, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  const writePackagedAgent = async (name, content) => {
    await fs.writeFile(path.join(packagedAgentDirectory, `${name}.md`), content, 'utf8');
  };

  const writeTargetAgent = async (name, content) => {
    await fs.mkdir(targetAgentDirectory, { recursive: true });
    await fs.writeFile(path.join(targetAgentDirectory, `${name}.md`), content, 'utf8');
  };

  const writeManifest = async (manifest) => {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  };

  const readManifest = async () => JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  it('materializes packaged agents into an empty runtime agent directory', async () => {
    const builder = agentContent('builder', 'Builder prompt v1');
    await writePackagedAgent('builder', builder);

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8')).resolves.toBe(builder);
    const manifest = await readManifest();
    expect(typeof manifest.packagedSetHash).toBe('string');
    expect(manifest).toMatchObject({
      version: 1,
      agents: {
        builder: {
          hash: hashContent(builder),
          packagedHash: hashContent(builder),
        },
      },
    });
    expect(result).toMatchObject({
      changed: true,
      written: ['builder'],
      updated: [],
      removed: [],
      conflicts: [],
    });
  });

  it('uses the packaged set hash fast path without reading unchanged target agent files', async () => {
    const builder = agentContent('builder', 'Builder prompt v1');
    const explorer = agentContent('explorer', 'Explorer prompt v1');
    await writePackagedAgent('builder', builder);
    await writePackagedAgent('explorer', explorer);

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    const builderTargetPath = path.join(targetAgentDirectory, 'builder.md');
    const explorerTargetPath = path.join(targetAgentDirectory, 'explorer.md');
    const readFileSpy = vi.spyOn(fs, 'readFile');

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    expect(result).toMatchObject({
      changed: false,
      written: [],
      updated: [],
      removed: [],
      conflicts: [],
    });
    const readPaths = readFileSpy.mock.calls.map(([filePath]) => String(filePath));
    expect(readPaths).not.toContain(builderTargetPath);
    expect(readPaths).not.toContain(explorerTargetPath);
  });

  it('does not use the set hash fast path when an applied model override changes runtime content', async () => {
    await writePackagedAgent('explorer', [
      '---',
      'name: explorer',
      'mode: subagent',
      'model: opencode-go/deepseek-v4-flash',
      '---',
      '',
      'Explorer prompt',
      '',
    ].join('\n'));

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      agentOverrides: {
        explorer: {
          model: 'openai/gpt-5.4',
        },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      agentOverrides: {
        explorer: {
          model: 'openai/gpt-5.5',
        },
      },
    });

    const frontmatter = await readAgentFrontmatter(targetAgentDirectory, 'explorer');
    expect(result.updated).toEqual(['explorer']);
    expect(frontmatter.model).toBe('openai/gpt-5.5');
  });

  it('does not use the set hash fast path when a managed target file is missing', async () => {
    const builder = agentContent('builder', 'Builder prompt v1');
    await writePackagedAgent('builder', builder);

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });
    await fs.rm(path.join(targetAgentDirectory, 'builder.md'));

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8')).resolves.toBe(builder);
    expect(result.written).toEqual(['builder']);
  });

  it('rewrites missing runtime files even when the manifest already contains packaged hashes', async () => {
    const builder = agentContent('builder', 'Builder prompt v2');
    await writePackagedAgent('builder', builder);
    await writeManifest({
      version: 1,
      agents: {
        builder: {
          hash: hashContent('old builder'),
          packagedHash: hashContent('old builder'),
        },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8')).resolves.toBe(builder);
    const manifest = await readManifest();
    expect(manifest.agents.builder.hash).toBe(hashContent(builder));
    expect(result.written).toEqual(['builder']);
  });

  it('updates managed runtime files when the packaged source changes', async () => {
    const oldBuilder = agentContent('builder', 'Builder prompt v1');
    const newBuilder = agentContent('builder', 'Builder prompt v2');
    await writePackagedAgent('builder', newBuilder);
    await writeTargetAgent('builder', oldBuilder);
    await writeManifest({
      version: 1,
      agents: {
        builder: {
          hash: hashContent(oldBuilder),
          packagedHash: hashContent(oldBuilder),
        },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8')).resolves.toBe(newBuilder);
    expect((await readManifest()).agents.builder.hash).toBe(hashContent(newBuilder));
    expect(result.updated).toEqual(['builder']);
  });

  it('propagates question-policy updates to unmodified managed primary agents', async () => {
    const oldBuilder = agentContent('builder', 'Ask only when truly blocked.');
    const oldOrchestrator = agentContent('orchestrator', 'Ask only for consequential ambiguity.');
    const newBuilder = agentContent('builder', 'Ask whenever user-answerable ambiguity remains.');
    const newOrchestrator = agentContent('orchestrator', 'Ask whenever user-answerable ambiguity remains.');
    await writePackagedAgent('builder', newBuilder);
    await writePackagedAgent('orchestrator', newOrchestrator);
    await writeTargetAgent('builder', oldBuilder);
    await writeTargetAgent('orchestrator', oldOrchestrator);
    await writeManifest({
      version: 1,
      agents: {
        builder: { hash: hashContent(oldBuilder), packagedHash: hashContent(oldBuilder) },
        orchestrator: { hash: hashContent(oldOrchestrator), packagedHash: hashContent(oldOrchestrator) },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8'))
      .resolves.toContain('Ask whenever user-answerable ambiguity remains.');
    await expect(fs.readFile(path.join(targetAgentDirectory, 'orchestrator.md'), 'utf8'))
      .resolves.toContain('Ask whenever user-answerable ambiguity remains.');
    expect(result.updated).toEqual(['builder', 'orchestrator']);
    expect(result.conflicts).toEqual([]);
  });

  it('removes stale managed runtime files that no longer exist in the packaged source', async () => {
    const stale = agentContent('stale', 'Stale prompt');
    await writeTargetAgent('stale', stale);
    await writeManifest({
      version: 1,
      agents: {
        stale: {
          hash: hashContent(stale),
          packagedHash: hashContent(stale),
        },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.stat(path.join(targetAgentDirectory, 'stale.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readManifest()).toEqual({
      version: 1,
      packagedSetHash: hashContent(''),
      agents: {},
    });
    expect(result.removed).toEqual(['stale']);
  });

  it('reports conflicts instead of overwriting user-modified same-name files', async () => {
    const oldBuilder = agentContent('builder', 'Builder prompt v1');
    const newBuilder = agentContent('builder', 'Builder prompt v2');
    const userModifiedBuilder = agentContent('builder', 'User modified prompt');
    await writePackagedAgent('builder', newBuilder);
    await writeTargetAgent('builder', userModifiedBuilder);
    await writeManifest({
      version: 1,
      agents: {
        builder: {
          hash: hashContent(oldBuilder),
          packagedHash: hashContent(oldBuilder),
        },
      },
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    await expect(fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8')).resolves.toBe(userModifiedBuilder);
    expect((await readManifest()).agents.builder.hash).toBe(hashContent(oldBuilder));
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        name: 'builder',
        path: path.join(targetAgentDirectory, 'builder.md'),
        reason: 'user-modified',
      }),
    ]);
  });

  it('materializes packaged agents with only visible skill permissions', async () => {
    const builder = [
      '---',
      'name: builder',
      'mode: primary',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '    /tmp/skills/frontend-design/*: allow',
      '    /tmp/skills/debugging/*: allow',
      '    /tmp/scratch/*: allow',
      '  skill:',
      '    frontend-design: allow',
      '    debugging: allow',
      '---',
      '',
      'Builder prompt',
      '',
    ].join('\n');
    await writePackagedAgent('builder', builder);

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      skillPolicy: {
        skillNames: ['frontend-design', 'project-audit'],
        skillDirectories: ['/tmp/skills/frontend-design', '/tmp/project/.opencode/skills/project-audit'],
        skillDirectoriesByName: {
          'frontend-design': ['/tmp/skills/frontend-design'],
          'project-audit': ['/tmp/project/.opencode/skills/project-audit'],
        },
      },
    });

    const targetContent = await fs.readFile(path.join(targetAgentDirectory, 'builder.md'), 'utf8');
    expect(targetContent).toContain('frontend-design: allow');
    expect(targetContent).toContain('project-audit: allow');
    expect(targetContent).not.toContain('debugging: allow');
    expect(targetContent).toContain('/tmp/skills/frontend-design/*: allow');
    expect(targetContent).toContain('/tmp/project/.opencode/skills/project-audit/*: allow');
    expect(targetContent).not.toContain('/tmp/skills/debugging/*: allow');
    expect(targetContent).toContain('/tmp/scratch/*: allow');
    expect(targetContent).toContain('"*": deny');
  });

  it('materializes packaged subagents with effective model overrides while preserving mode and permissions', async () => {
    const explorer = [
      '---',
      'name: explorer',
      'mode: subagent',
      'model: opencode-go/deepseek-v4-flash',
      'modelRefs:',
      '  - opencode-go/deepseek-v4-flash',
      'variant: medium',
      'permission:',
      '  "*": allow',
      '  read:',
      '    "*.env": ask',
      '  skill:',
      '    codemap: allow',
      '---',
      '',
      'Explorer prompt',
      '',
    ].join('\n');
    await writePackagedAgent('explorer', explorer);

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      agentOverrides: {
        explorer: {
          model: 'openai/gpt-5.5',
          variant: 'high',
        },
      },
    });

    const frontmatter = await readAgentFrontmatter(targetAgentDirectory, 'explorer');
    expect(frontmatter.mode).toBe('subagent');
    expect(frontmatter.model).toBe('openai/gpt-5.5');
    expect(frontmatter).not.toHaveProperty('modelRefs');
    expect(frontmatter).not.toHaveProperty('councillors');
    expect(frontmatter.variant).toBe('high');
    expect(frontmatter.permission).toMatchObject({
      '*': 'allow',
      read: { '*.env': 'ask' },
      skill: { codemap: 'allow' },
    });
  });

  it('removes an inherited packaged thinking variant when the effective override is default', async () => {
    await writePackagedAgent('explorer', [
      '---',
      'name: explorer',
      'mode: subagent',
      'model: opencode-go/deepseek-v4-flash',
      'variant: medium',
      '---',
      '',
      'Explorer prompt',
      '',
    ].join('\n'));

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      agentOverrides: {
        explorer: {
          model: 'openai/gpt-5.5',
          variant: null,
        },
      },
    });

    const frontmatter = await readAgentFrontmatter(targetAgentDirectory, 'explorer');
    expect(frontmatter.model).toBe('openai/gpt-5.5');
    expect(frontmatter).not.toHaveProperty('modelRefs');
    expect(frontmatter).not.toHaveProperty('councillors');
    expect(frontmatter).not.toHaveProperty('variant');
  });

  it('skips excluded packaged agents and removes previously managed excluded files', async () => {
    const builder = agentContent('builder', 'Builder prompt');
    const plan = agentContent('plan', 'Plan prompt');
    await writePackagedAgent('builder', builder);
    await writePackagedAgent('plan', plan);

    await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
    });

    const result = await syncPackagedAgents({
      packagedAgentDirectory,
      targetAgentDirectory,
      manifestPath,
      excludedAgentNames: ['builder'],
    });

    await expect(fs.stat(path.join(targetAgentDirectory, 'builder.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(targetAgentDirectory, 'plan.md'), 'utf8')).resolves.toBe(plan);
    expect(result.removed).toEqual(['builder']);
    expect(await readManifest()).toMatchObject({
      agents: {
        plan: {
          hash: hashContent(plan),
        },
      },
    });
    expect((await readManifest()).agents).not.toHaveProperty('builder');
  });
});
