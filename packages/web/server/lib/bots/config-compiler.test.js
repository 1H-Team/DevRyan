import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotConfigCompiler } from './config-compiler.js';

const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = 'e0000000-0000-4000-8000-000000000001';
const LIBRARY_ID = 'f0000000-0000-4000-8000-000000000001';
const SKILL_BINDING_ID = 'a0000000-0000-4000-8000-000000000001';
const temporaryDirectories = [];

const makeTreeWritable = async (directory) => {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await fs.chmod(directory, 0o700).catch(() => undefined);
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(entryPath);
    else await fs.chmod(entryPath, 0o600).catch(() => undefined);
  }));
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await makeTreeWritable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

const makeDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-config-'));
  temporaryDirectories.push(directory);
  return directory;
};

const contract = (overrides = {}) => ({
  standingRole: 'You are the private operations Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: CREDENTIAL_ID,
      egressHosts: ['api.openai.com:443'],
      variant: 'high',
    },
    fallbacks: [{
      providerId: 'anthropic',
      modelId: 'claude-opus-4-6',
      credentialId: CREDENTIAL_ID,
      egressHosts: ['api.anthropic.com:443'],
    }],
  },
  reasoning: { effort: 'high', maxOutputTokens: 16_384 },
  fileTools: ['read', 'write', 'glob'],
  gatewayPluginVersion: 'devryan-bot-tools@1.0.0',
  libraryVersionIds: [LIBRARY_ID],
  memoryPolicy: { shared: true, userPrivate: true, retrievalLimit: 12 },
  actionPolicy: { defaultEffect: 'deny', defaultRisk: 'sensitive', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
  ...overrides,
});

describe('Bot immutable revision config compiler', () => {
  it('hashes every runtime-bearing policy field and writes a private immutable channel directory', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const first = await compiler.compile({ channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: contract() });

    expect(first.compiledHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.directory).toBe(path.join(
      dataDirectory,
      'bots',
      'runtime',
      'channels',
      CHANNEL_ID,
      REVISION_ID,
      first.compiledHash,
    ));
    const config = JSON.parse(await fs.readFile(path.join(first.directory, 'opencode.json'), 'utf8'));
    expect(config.agent.bot).toMatchObject({
      prompt: 'You are the private operations Bot.',
      model: 'openai/gpt-5.6-sol',
      variant: 'high',
      permission: { read: 'allow', write: 'allow', edit: 'deny', bash: 'deny' },
    });
    expect(config.plugin).toEqual(['/opt/devryan/devryan-bot-tools.mjs']);
    expect((await fs.stat(first.directory)).mode & 0o777).toBe(0o500);
    expect((await fs.stat(path.join(first.directory, 'opencode.json'))).mode & 0o777).toBe(0o400);

    for (const [field, value] of [
      ['standingRole', 'A different role'],
      ['reasoning', { effort: 'low' }],
      ['fileTools', ['read']],
      ['gatewayPluginVersion', 'devryan-bot-tools@1.0.1'],
      ['libraryVersionIds', []],
      ['memoryPolicy', { shared: false }],
      ['actionPolicy', { defaultEffect: 'prompt', defaultRisk: 'low', rules: [] }],
      ['browserPolicy', { allowedOrigins: ['https://example.com'], deniedOrigins: [] }],
    ]) {
      const changed = await compiler.compile({
        channelId: CHANNEL_ID,
        revisionId: REVISION_ID,
        contract: contract({ [field]: value }),
      });
      expect(changed.compiledHash).not.toBe(first.compiledHash);
    }
    const modelChanged = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        models: {
          ...contract().models,
          primary: { ...contract().models.primary, modelId: 'gpt-5.6-terra' },
        },
      }),
    });
    expect(modelChanged.compiledHash).not.toBe(first.compiledHash);

    const structured = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        identity: { title: 'Operations Desk', avatar: 'OD' },
        objectives: ['Review the assigned queue'],
        tone: 'Direct and calm',
        operatingInstructions: 'Use only reviewed tools.',
        prohibitedInstructions: 'Never bypass approval.',
        advancedPrompt: 'State uncertainty explicitly.',
        tenancy: 'personalized',
      }),
    });
    const structuredConfig = JSON.parse(await fs.readFile(
      path.join(structured.directory, 'opencode.json'),
      'utf8',
    ));
    expect(structured.compiledHash).not.toBe(first.compiledHash);
    expect(structuredConfig.agent.bot.prompt).toContain('Objectives:\n- Review the assigned queue');
    expect(structuredConfig.agent.bot.prompt).toContain('Operating instructions:\nUse only reviewed tools.');
    expect(structuredConfig.agent.bot.prompt).toContain('Prohibited behavior:\nNever bypass approval.');
    expect(structuredConfig.agent.bot.prompt).toContain('State uncertainty explicitly.');
  });

  it('puts the soul first in the prompt and writes it as a read-only soul.md', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const soul = '# Soul\n\nI am the Operations Desk.\n\n## Voice & Tone\nTerse.';
    const compiled = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        soul,
        tone: 'A legacy tone field that the soul now supersedes',
        objectives: ['Review the assigned queue'],
      }),
    });

    const config = JSON.parse(await fs.readFile(
      path.join(compiled.directory, 'opencode.json'),
      'utf8',
    ));
    expect(config.agent.bot.prompt.startsWith(soul)).toBe(true);
    // Voice lives in the soul now, so the legacy tone section is not emitted.
    expect(config.agent.bot.prompt).not.toContain('Tone:\n');
    expect(config.agent.bot.prompt.indexOf(soul))
      .toBeLessThan(config.agent.bot.prompt.indexOf('Objectives:'));

    const soulPath = path.join(compiled.directory, 'soul.md');
    expect(await fs.readFile(soulPath, 'utf8')).toBe(`${soul}\n`);
    expect((await fs.lstat(soulPath)).mode & 0o277).toBe(0);

    // Recompiling the same contract must verify the existing soul, not conflict.
    const again = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        soul,
        tone: 'A legacy tone field that the soul now supersedes',
        objectives: ['Review the assigned queue'],
      }),
    });
    expect(again.compiledHash).toBe(compiled.compiledHash);
  });

  it('keeps the legacy tone section for revisions written before souls existed', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const compiled = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({ tone: 'Direct and calm' }),
    });
    const config = JSON.parse(await fs.readFile(
      path.join(compiled.directory, 'opencode.json'),
      'utf8',
    ));
    expect(config.agent.bot.prompt).toContain('Tone:\nDirect and calm');
    await expect(fs.lstat(path.join(compiled.directory, 'soul.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('is idempotent, repairs corrupted generated files, and rejects unsafe contract fields', async () => {
    const dataDirectory = await makeDirectory();
    const recordDiagnostic = vi.fn();
    const compiler = createBotConfigCompiler({ dataDirectory, recordDiagnostic });
    const input = { channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: contract() };
    const first = await compiler.compile(input);
    const second = await compiler.compile(input);
    expect(second).toEqual(first);

    await expect(compiler.compile({
      ...input,
      contract: contract({ userModelOverride: 'attacker/model' }),
    })).rejects.toMatchObject({ code: 'bot_revision_contract_invalid' });
    await expect(compiler.compile({
      ...input,
      contract: contract({ fileTools: ['read', 'bash'] }),
    })).rejects.toMatchObject({ code: 'bot_revision_contract_invalid' });

    await fs.chmod(path.join(first.directory, 'opencode.json'), 0o600);
    await fs.writeFile(path.join(first.directory, 'opencode.json'), '{"agent":{}}\n');
    await fs.chmod(path.join(first.directory, 'opencode.json'), 0o400);
    await fs.chmod(first.directory, 0o700);
    await fs.writeFile(path.join(first.directory, 'unexpected.txt'), 'stale\n', { mode: 0o600 });
    await fs.chmod(first.directory, 0o500);
    const repaired = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract(),
    });
    expect(repaired).toEqual(first);
    expect(JSON.parse(await fs.readFile(path.join(first.directory, 'opencode.json'), 'utf8')))
      .toHaveProperty('agent.bot.prompt', 'You are the private operations Bot.');
    await expect(fs.lstat(path.join(first.directory, 'unexpected.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(recordDiagnostic.mock.calls.map(([entry]) => entry.event)).toEqual([
      'bot.compiled_config_repair.detected',
      'bot.compiled_config_repair.completed',
    ]);
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        channelId: CHANNEL_ID,
        revisionId: REVISION_ID,
        hash: first.compiledHash,
        code: 'bot_compiled_config_conflict',
      }),
    }));
  });

  it('singleflights concurrent compilation for the same channel revision and hash', async () => {
    const dataDirectory = await makeDirectory();
    let targetCommits = 0;
    const fsPromises = {
      ...fs,
      async rename(source, destination) {
        if (path.basename(source).startsWith('.compile-')) targetCommits += 1;
        return fs.rename(source, destination);
      },
    };
    const compiler = createBotConfigCompiler({ dataDirectory, fsPromises });
    const input = { channelId: CHANNEL_ID, revisionId: REVISION_ID, contract: contract() };
    const results = await Promise.all(Array.from({ length: 12 }, () => compiler.compile(input)));

    expect(new Set(results.map((entry) => entry.directory))).toEqual(new Set([results[0].directory]));
    expect(targetCommits).toBe(1);
    expect(await fs.readdir(path.dirname(results[0].directory))).toEqual([results[0].compiledHash]);
  });

  it('restores the quarantined tree when atomic replacement fails', async () => {
    const dataDirectory = await makeDirectory();
    const initial = await createBotConfigCompiler({ dataDirectory }).compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract(),
    });
    await fs.chmod(path.join(initial.directory, 'revision.json'), 0o600);
    await fs.writeFile(path.join(initial.directory, 'revision.json'), '{}\n');
    await fs.chmod(path.join(initial.directory, 'revision.json'), 0o400);
    const recordDiagnostic = vi.fn();
    let failCommit = true;
    const fsPromises = {
      ...fs,
      async rename(source, destination) {
        if (failCommit && path.basename(source).startsWith('.compile-')
          && destination === initial.directory) {
          failCommit = false;
          throw Object.assign(new Error('fixture commit failure'), { code: 'EIO' });
        }
        return fs.rename(source, destination);
      },
    };
    const compiler = createBotConfigCompiler({ dataDirectory, fsPromises, recordDiagnostic });

    await expect(compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract(),
    })).rejects.toMatchObject({ code: 'bot_compiled_config_invalid' });
    expect(await fs.readFile(path.join(initial.directory, 'revision.json'), 'utf8')).toBe('{}\n');
    expect((await fs.readdir(path.dirname(initial.directory)))
      .some((entry) => entry.startsWith('.quarantine-'))).toBe(false);
    expect(recordDiagnostic.mock.calls.map(([entry]) => entry.event)).toEqual([
      'bot.compiled_config_repair.detected',
      'bot.compiled_config_repair.failed',
    ]);
  });

  it('materializes identical contracts independently for immutable revision identities', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const nextRevisionId = 'd0000000-0000-4000-8000-000000000002';
    const first = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract(),
    });
    const next = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: nextRevisionId,
      contract: contract(),
    });

    expect(next.compiledHash).toBe(first.compiledHash);
    expect(next.directory).not.toBe(first.directory);
    expect(next.directory).toBe(path.join(
      dataDirectory,
      'bots',
      'runtime',
      'channels',
      CHANNEL_ID,
      nextRevisionId,
      next.compiledHash,
    ));
    expect(JSON.parse(await fs.readFile(path.join(first.directory, 'revision.json'), 'utf8')).revisionId)
      .toBe(REVISION_ID);
    expect(JSON.parse(await fs.readFile(path.join(next.directory, 'revision.json'), 'utf8')).revisionId)
      .toBe(nextRevisionId);
  });

  it('routes revision 1.1 workspace mutations only through the reviewed gateway tool', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const compiled = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        fileTools: ['read', 'write', 'edit'],
        gatewayPluginVersion: 'devryan-bot-tools@1.1.0',
      }),
    });
    const config = JSON.parse(await fs.readFile(path.join(compiled.directory, 'opencode.json'), 'utf8'));
    expect(config.agent.bot.permission).toMatchObject({
      read: 'allow',
      write: 'deny',
      edit: 'deny',
      devryan_write: 'allow',
    });
    expect(config.agent.bot.prompt).toContain('Use devryan_write for every workspace file change.');
  });

  it('compiles autonomous runtime tools and scoped non-recursive native subagents', async () => {
    const dataDirectory = await makeDirectory();
    const compiler = createBotConfigCompiler({ dataDirectory });
    const compiled = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        fileTools: ['read', 'glob', 'grep', 'edit', 'write'],
        runtimeTools: ['bash', 'terminal', 'git', 'task'],
        gatewayPluginVersion: 'devryan-bot-tools@1.1.0',
        actionPolicy: { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
      }),
    });
    const [config, manifest] = await Promise.all([
      fs.readFile(path.join(compiled.directory, 'opencode.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(compiled.directory, 'revision.json'), 'utf8').then(JSON.parse),
    ]);

    expect(manifest.version).toBe(2);
    expect(config.agent.bot.permission).toMatchObject({
      read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', write: 'allow',
      bash: 'allow', terminal: 'allow', git: 'allow', task: 'allow',
      devryan_bot: 'allow', browser: 'deny', devryan_browser: 'deny',
      mcp: 'deny', external_directory: 'deny', devryan_task: 'deny',
    });
    for (const name of ['explore', 'general']) {
      expect(config.agent[name]).toMatchObject({ mode: 'subagent' });
      expect(config.agent[name].permission).toMatchObject({
        read: 'allow', edit: 'allow', write: 'allow', bash: 'allow', terminal: 'allow', git: 'allow',
        task: 'deny', devryan_task: 'deny', devryan_bot: 'deny', browser: 'deny',
        devryan_browser: 'deny', mcp: 'deny', external_directory: 'deny',
      });
    }

    const optedOut = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({ fileTools: ['read'], runtimeTools: ['bash'] }),
    });
    const optedOutConfig = JSON.parse(await fs.readFile(
      path.join(optedOut.directory, 'opencode.json'),
      'utf8',
    ));
    expect(optedOutConfig.agent.bot.permission).toMatchObject({
      read: 'allow', edit: 'deny', write: 'deny', bash: 'allow', terminal: 'deny', git: 'deny', task: 'deny',
    });
    expect(optedOutConfig.agent.explore).toEqual({ disable: true });
    expect(optedOutConfig.agent.general).toEqual({ disable: true });
  });

  it('preserves legacy hashes while materializing newly assigned skills read-only', async () => {
    const dataDirectory = await makeDirectory();
    const legacyCompiler = createBotConfigCompiler({ dataDirectory });
    const legacy = await legacyCompiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract(),
    });
    expect(legacy.compiledHash).toBe('26006bb8f64e969afcd9ac7b1bf0ab84d2a5162bd2670a2a2a919ac2145e20b5');
    expect(legacy.contract).not.toHaveProperty('skillBindings');
    expect(legacy.contract).not.toHaveProperty('mcpBindings');
    const legacyConfig = JSON.parse(await fs.readFile(path.join(legacy.directory, 'opencode.json'), 'utf8'));
    expect(legacyConfig.agent.bot.permission).not.toHaveProperty('skill');
    expect(await fs.readdir(path.join(legacy.directory, 'skills'))).toEqual([]);

    const skillContent = '# Review queue\n\nUse the provided reference file.\n';
    const referenceContent = 'Read-only supporting context.\n';
    const digest = 'a'.repeat(64);
    const compiler = createBotConfigCompiler({
      dataDirectory,
      resolveSkillPackages: async ({ revisionId, bindings }) => {
        expect(revisionId).toBe(REVISION_ID);
        expect(bindings).toEqual([{ id: SKILL_BINDING_ID, digest }]);
        return [{
          id: SKILL_BINDING_ID,
          name: 'review-queue',
          digest,
          files: [
            {
              path: 'SKILL.md',
              content: skillContent,
              sha256: crypto.createHash('sha256').update(skillContent).digest('hex'),
            },
            {
              path: 'references/context.md',
              content: referenceContent,
              sha256: crypto.createHash('sha256').update(referenceContent).digest('hex'),
            },
          ],
        }];
      },
    });
    const assigned = await compiler.compile({
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      contract: contract({
        skillBindings: [{ id: SKILL_BINDING_ID, digest }],
        mcpBindings: [],
      }),
    });
    expect(assigned.compiledHash).not.toBe(legacy.compiledHash);
    const assignedConfig = JSON.parse(await fs.readFile(path.join(assigned.directory, 'opencode.json'), 'utf8'));
    expect(assignedConfig.agent.bot.permission.skill).toEqual({
      '*': 'deny',
      'review-queue': 'allow',
    });
    const skillRoot = path.join(assigned.directory, 'skills', 'review-queue');
    expect(await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe(skillContent);
    expect(await fs.readFile(path.join(skillRoot, 'references', 'context.md'), 'utf8')).toBe(referenceContent);
    expect((await fs.stat(path.join(skillRoot, 'SKILL.md'))).mode & 0o777).toBe(0o400);
    expect((await fs.stat(path.join(skillRoot, 'references', 'context.md'))).mode & 0o777).toBe(0o400);
    expect((await fs.stat(skillRoot)).mode & 0o777).toBe(0o500);
  });
});
