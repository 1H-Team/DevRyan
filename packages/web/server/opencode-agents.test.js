import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import {
  deleteAgentModelOverride,
  getAgentConfig,
  listConfigAgents,
  listAgentModelOverrides,
  listStaleAgentModelOverrides,
  writeAgentModelOverride,
} from './lib/opencode/agents.js';
import { listPackagedAgents } from './lib/opencode/packaged-agents.js';
import { registerConfigEntityRoutes } from './lib/opencode/config-entity-routes.js';

const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
let isolatedOpencodeConfigDir;

const makeTempProject = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agents-'));
  await fs.mkdir(path.join(directory, '.opencode', 'agents'), { recursive: true });
  return directory;
};

beforeEach(async () => {
  isolatedOpencodeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-opencode-config-'));
  process.env.OPENCODE_CONFIG_DIR = isolatedOpencodeConfigDir;
});

afterEach(async () => {
  if (isolatedOpencodeConfigDir) {
    await fs.rm(isolatedOpencodeConfigDir, { recursive: true, force: true });
  }
  if (typeof originalOpencodeConfigDir === 'string') {
    process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  } else {
    delete process.env.OPENCODE_CONFIG_DIR;
  }
  isolatedOpencodeConfigDir = undefined;
});

describe('OpenCode agent model normalization', () => {
  let projectDirectory;
  let userConfigPath;

  afterEach(async () => {
    if (projectDirectory) {
      await fs.rm(projectDirectory, { recursive: true, force: true });
    }
    projectDirectory = undefined;
    userConfigPath = undefined;
  });

  it('reads legacy model arrays as a scalar model plus ordered modelRefs', async () => {
    projectDirectory = await makeTempProject();
    userConfigPath = path.join(projectDirectory, '.opencode', 'test-user-config.json');
    const agentPath = path.join(projectDirectory, '.opencode', 'agents', 'council.md');
    await fs.writeFile(agentPath, [
      '---',
      'mode: all',
      'model:',
      '  - openai/gpt-5.5',
      '  - opencode-go/kimi-k2.6',
      'permission:',
      '  council_session: allow',
      '---',
      '',
      'Council prompt',
      '',
    ].join('\n'));

    const result = getAgentConfig('council', projectDirectory, { userConfigPath });

    expect(result.config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(result.config.modelRefs).toEqual(['openai/gpt-5.5', 'opencode-go/kimi-k2.6']);
    expect(result.config.permission.council_session).toBe('allow');
    expect(result.config.prompt).toBe('Council prompt');
  });

  it('reads packaged model metadata without user config sync', () => {
    userConfigPath = path.join(os.tmpdir(), `openchamber-agents-${Date.now()}-config.json`);
    const result = getAgentConfig('council', null, { userConfigPath });

    expect(result.scope).toBe('packaged');
    expect(result.config.name).toBe('council');
    expect(result.config.modelRefs.length).toBeGreaterThan(0);
  });
});

describe('OpenCode config agent listing', () => {
  let projectDirectory;
  let userAgentDirectory;

  afterEach(async () => {
    if (projectDirectory) {
      await fs.rm(projectDirectory, { recursive: true, force: true });
    }
    if (userAgentDirectory) {
      await fs.rm(userAgentDirectory, { recursive: true, force: true });
    }
    projectDirectory = undefined;
    userAgentDirectory = undefined;
  });

  it('includes packaged agents when the selected project has no project agents', async () => {
    projectDirectory = await makeTempProject();

    const agents = listConfigAgents(projectDirectory);
    const builder = agents.find((agent) => agent.name === 'builder');

    expect(builder).toMatchObject({
      name: 'builder',
      scope: 'packaged',
      native: true,
      builtIn: true,
    });
  });

  it('ignores user-global agents even when a matching directory is passed', async () => {
    projectDirectory = await makeTempProject();
    userAgentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-user-agents-'));
    await fs.writeFile(path.join(userAgentDirectory, 'user-only-test-agent.md'), [
      '---',
      'mode: primary',
      'description: User only',
      '---',
      '',
      'User prompt',
      '',
    ].join('\n'));

    const agents = listConfigAgents(projectDirectory, { userAgentDirectory });

    expect(agents.map((agent) => agent.name)).not.toContain('user-only-test-agent');
  });

  it('prefers project agents over same-name packaged agents', async () => {
    projectDirectory = await makeTempProject();
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'agents', 'builder.md'), [
      '---',
      'mode: primary',
      'description: Project builder',
      '---',
      '',
      'Project prompt',
      '',
    ].join('\n'));

    const agents = listConfigAgents(projectDirectory);
    const builder = agents.find((agent) => agent.name === 'builder');

    expect(builder).toMatchObject({
      name: 'builder',
      scope: 'project',
      description: 'Project builder',
      prompt: 'Project prompt',
    });
  });

  it('preserves nested task permissions from project agent frontmatter', async () => {
    projectDirectory = await makeTempProject();
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'agents', 'builder.md'), [
      '---',
      'mode: primary',
      'description: Project builder',
      'permission:',
      '  "*": allow',
      '  task:',
      '    "*": deny',
      '  council_session: deny',
      '---',
      '',
      'Project prompt',
      '',
    ].join('\n'));

    const result = getAgentConfig('builder', projectDirectory);

    expect(result.config.permission).toMatchObject({
      '*': 'allow',
      task: {
        '*': 'deny',
      },
      council_session: 'deny',
    });
  });

  it('does not read project agents from the legacy singular .opencode/agent directory', async () => {
    projectDirectory = await makeTempProject();
    const legacyAgentName = 'legacy-only-test-agent';
    await fs.rm(path.join(projectDirectory, '.opencode', 'agents'), { recursive: true, force: true });
    await fs.mkdir(path.join(projectDirectory, '.opencode', 'agent'), { recursive: true });
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'agent', `${legacyAgentName}.md`), [
      '---',
      'mode: primary',
      'description: Legacy project agent',
      '---',
      '',
      'Legacy project prompt',
      '',
    ].join('\n'));

    const agents = listConfigAgents(projectDirectory);
    const config = getAgentConfig(legacyAgentName, projectDirectory);

    expect(agents.map((agent) => agent.name)).not.toContain(legacyAgentName);
    expect(config.source).toBe('none');
  });

  it('does not use project opencode.json agent entries as agent overrides', async () => {
    projectDirectory = await makeTempProject();
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'opencode.json'), JSON.stringify({
      agent: {
        builder: {
          disable: true,
          description: 'JSON builder override',
          prompt: 'JSON prompt',
        },
      },
    }, null, 2));

    const config = getAgentConfig('builder', projectDirectory);

    expect(config.scope).toBe('packaged');
    expect(config.config.description).not.toBe('JSON builder override');
    expect(config.config.prompt).not.toBe('JSON prompt');
  });
});

describe('OpenCode user agent model overrides', () => {
  let projectDirectory;
  let userConfigDirectory;
  let userConfigPath;

  beforeEach(async () => {
    projectDirectory = await makeTempProject();
    userConfigDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-user-agent-overrides-'));
    userConfigPath = path.join(userConfigDirectory, 'config.json');
  });

  afterEach(async () => {
    if (projectDirectory) {
      await fs.rm(projectDirectory, { recursive: true, force: true });
    }
    if (userConfigDirectory) {
      await fs.rm(userConfigDirectory, { recursive: true, force: true });
    }
    projectDirectory = undefined;
    userConfigDirectory = undefined;
    userConfigPath = undefined;
  });

  it('applies user model overrides after project/package frontmatter', async () => {
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'agents', 'builder.md'), [
      '---',
      'mode: primary',
      'description: Project builder',
      'model: opencode-go/kimi-k2.6',
      'variant: low',
      'permission:',
      '  bash: deny',
      '---',
      '',
      'Project prompt',
      '',
    ].join('\n'));

    writeAgentModelOverride('builder', {
      model: 'openai/gpt-5.5',
      variant: 'xhigh',
    }, projectDirectory, { userConfigPath });

    const result = getAgentConfig('builder', projectDirectory, { userConfigPath });

    expect(result.config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(result.config.variant).toBe('xhigh');
    expect(result.config.description).toBe('Project builder');
    expect(result.config.prompt).toBe('Project prompt');
    expect(result.config.permission.bash).toBe('deny');
    expect(result.config.overrides).toEqual({
      model: true,
      variant: true,
      councillors: false,
    });
  });

  it('clears a project agent thinking variant when override variant is null', async () => {
    await fs.writeFile(path.join(projectDirectory, '.opencode', 'agents', 'builder.md'), [
      '---',
      'mode: primary',
      'description: Project builder',
      'model: anthropic/claude-sonnet-4-5',
      'variant: low',
      '---',
      '',
      'Project prompt',
      '',
    ].join('\n'));

    writeAgentModelOverride('builder', {
      model: 'openai/gpt-5.5',
      variant: null,
    }, projectDirectory, { userConfigPath });

    const result = getAgentConfig('builder', projectDirectory, { userConfigPath });

    expect(result.config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(result.config.variant).toBeUndefined();
    expect(result.config.overrides.variant).toBe(true);
  });

  it('rejects user overrides that try to mutate inherited agent fields', () => {
    expect(() => writeAgentModelOverride('builder', {
      model: 'openai/gpt-5.5',
      prompt: 'Forbidden prompt mutation',
    }, projectDirectory, { userConfigPath })).toThrow('Only model, variant, and councillors can be overridden');

    expect(() => writeAgentModelOverride('builder', {
      model: 'openai/gpt-5.5',
      permission: { bash: 'allow' },
    }, projectDirectory, { userConfigPath })).toThrow('Only model, variant, and councillors can be overridden');
  });

  it('rejects user overrides for unknown agent names', () => {
    expect(() => writeAgentModelOverride('unknown-agent', {
      model: 'openai/gpt-5.5',
    }, projectDirectory, { userConfigPath })).toThrow('Agent "unknown-agent" not found');
  });

  it('deletes only the selected agent override', () => {
    writeAgentModelOverride('builder', {
      model: 'openai/gpt-5.5',
      variant: 'medium',
    }, projectDirectory, { userConfigPath });
    writeAgentModelOverride('designer', {
      model: 'opencode-go/glm-5.1',
      variant: 'low',
    }, projectDirectory, { userConfigPath });

    const deleted = deleteAgentModelOverride('builder', { userConfigPath });
    const overrides = listAgentModelOverrides({ userConfigPath });

    expect(deleted).toBe(true);
    expect(overrides.builder).toBeUndefined();
    expect(overrides.designer).toEqual({
      model: 'opencode-go/glm-5.1',
      variant: 'low',
    });
  });

  it('retains stale overrides on disk but excludes them from runtime agent listings', async () => {
    await fs.writeFile(userConfigPath, JSON.stringify({
      openchamber: {
        agentOverrides: {
          builder: { model: 'openai/gpt-5.5' },
          removedAgent: { model: 'opencode-go/kimi-k2.6' },
        },
      },
    }));

    const agents = listConfigAgents(projectDirectory, { userConfigPath });
    const overrides = listAgentModelOverrides({ userConfigPath });

    expect(agents.map((agent) => agent.name)).not.toContain('removedAgent');
    expect(overrides.removedAgent).toEqual({ model: 'opencode-go/kimi-k2.6' });
    expect(listStaleAgentModelOverrides(projectDirectory, { userConfigPath })).toEqual(['removedAgent']);

    writeAgentModelOverride('designer', {
      model: 'opencode-go/glm-5.1',
      variant: 'low',
    }, projectDirectory, { userConfigPath });

    expect(listAgentModelOverrides({ userConfigPath }).removedAgent).toEqual({
      model: 'opencode-go/kimi-k2.6',
    });
  });

  it('preserves ordered Council councillor model and variant overrides', () => {
    writeAgentModelOverride('council', {
      model: 'openai/gpt-5.5',
      variant: 'medium',
      councillors: [
        { model: 'openai/gpt-5.3-codex', variant: 'high' },
        { model: 'opencode-go/kimi-k2.6', variant: null },
      ],
    }, projectDirectory, { userConfigPath });

    const result = getAgentConfig('council', projectDirectory, { userConfigPath });

    expect(result.config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(result.config.variant).toBe('medium');
    expect(result.config.modelRefs).toEqual([
      'openai/gpt-5.3-codex',
      'opencode-go/kimi-k2.6',
    ]);
    expect(result.config.councillors).toEqual([
      { model: 'openai/gpt-5.3-codex', variant: 'high' },
      { model: 'opencode-go/kimi-k2.6', variant: null },
    ]);
    expect(result.config.overrides).toEqual({
      model: true,
      variant: true,
      councillors: true,
    });
  });
});

describe('Packaged OpenChamber agents', () => {
  it('discovers the packaged primary and subagents', () => {
    const agents = listPackagedAgents();

    expect(agents.map((agent) => agent.name)).toEqual(expect.arrayContaining([
      'builder',
      'orchestrator',
      'plan',
      'explorer',
      'fixer',
      'designer',
      'oracle',
      'librarian',
      'council',
    ]));
  });

  it('keeps the packaged Builder prompt limited to direct-work question and hygiene guardrails', () => {
    const builder = listPackagedAgents().find((agent) => agent.name === 'builder');

    expect(builder?.prompt).toContain('structured question tool');
    expect(builder?.prompt).toContain('Skill announcements are tool activity only');
    expect(builder?.prompt).toContain('do not write assistant text to announce skill use');
    expect(builder?.prompt).toContain('Do not write visible reasoning about balancing skill instructions against developer or agent instructions');
    expect(builder?.prompt).not.toContain('Subagent prompt templates');
    expect(builder?.prompt).not.toContain('Fixer-first implementation gate');
    expect(builder.frontmatter.permission).toMatchObject({
      task: {
        '*': 'deny',
      },
      council_session: 'deny',
      question: 'allow',
      'question_*': 'allow',
    });
  });

  it('instructs Orchestrator to use the task tool when delegating to Explorer', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('calling the task tool');
    expect(orchestrator?.prompt).toContain('If Explorer is unavailable');
  });

  it('keeps Explorer discovery speed-bounded and Orchestrator prompts compact', () => {
    const explorer = listPackagedAgents().find((agent) => agent.name === 'explorer');
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(explorer?.prompt).toContain('at most two search passes');
    expect(explorer?.prompt).toContain('strong candidates, not exhaustive coverage');
    expect(explorer?.prompt).toContain('smallest needed file slices');
    expect(orchestrator?.prompt).toContain('Find:');
    expect(orchestrator?.prompt).toContain('Scope:');
    expect(orchestrator?.prompt).toContain('Need:');
    expect(orchestrator?.prompt).toContain('Avoid:');
    expect(orchestrator?.prompt).toContain('For known paths, exact symbols in 1-2 files, codemap-identified targets, or a single narrow `read`/`grep`, do it yourself instead of delegating.');
  });

  it('instructs Orchestrator to stop after plan-only responses without asking to implement', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('Once the plan is finished, stop after presenting it.');
    expect(orchestrator?.prompt).not.toContain('Once the plan is finished, ask whether it is okay to implement');
    expect(orchestrator?.prompt).not.toContain("Once finished asked if it's okay to implement");
  });

  it('keeps plan approval out of normal-mode Orchestrator questions', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');
    const plan = listPackagedAgents().find((agent) => agent.name === 'plan');

    expect(orchestrator?.prompt).toContain('Plan approval belongs only to the plan card lifecycle');
    expect(orchestrator?.prompt).toContain('Do not use the structured question tool to ask for approval of a design or plan');
    expect(orchestrator?.prompt).toContain('Do not ask for design, approach, or plan approval through plain prose or the structured question tool in normal mode.');
    expect(plan?.prompt).toContain('The plan card provides the implementation action');
    expect(plan?.prompt).not.toContain('End the message with a single approval question');
  });

  it('asks for design intent before Designer delegation when the intent is missing', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('If design intent is missing, ask one focused structured question before delegating to `designer`.');
    expect(orchestrator?.prompt).toContain('If the user already gave a clear design choice or sufficient requirements, treat that as enough to proceed without approval loops.');
    expect(orchestrator?.prompt).not.toContain('After Explorer returns files for normal-mode design-quality UI work, immediately delegate the implementation or review to @designer.');
    expect(orchestrator?.prompt).not.toContain('Do not present design options, design directions, wireframes, or implementation approaches for user approval before calling @designer.');
  });

  it('keeps Orchestrator question-first and low-analysis for consequential ambiguity', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('Clarify intent before consequential choices.');
    expect(orchestrator?.prompt).toContain('Ask when ambiguity affects user-visible outcome');
    expect(orchestrator?.prompt).toContain('Infer only reversible implementation details');
    expect(orchestrator?.prompt).toContain('Do not build long speculative option trees');
    expect(orchestrator?.prompt).toContain('Do not re-litigate settled decisions');
    expect(orchestrator?.prompt).toContain('Pick exactly one next action: ask, inspect, delegate, implement, verify, or finish.');
  });

  it('keeps subagent result continuation same-turn instead of relying on auto-continue', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('After any `task` tool result returns, reconcile the active todo immediately and continue the next actionable todo in the same turn.');
    expect(orchestrator?.prompt).toContain('Do not stop after a completed subagent result while incomplete todos remain.');
    expect(orchestrator?.prompt).toContain('Auto-continue is a guardrail for stopping between batches, not the mechanism for resuming after a blocking subagent call returns.');
    expect(orchestrator?.prompt).toContain('Before delegating when the user requested autonomous or batch work, or when you create 4+ todos, enable `auto_continue` only if the runtime exposes that tool.');
    expect(orchestrator?.prompt).toContain('Ask every delegated subagent to end with exactly one terminal status marker: `<status>complete</status>` or `<status>blocked</status>`.');
  });

  it('keeps Orchestrator parallel delegation bounded and failure-tolerant', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('Parallel delegation readiness gate');
    expect(orchestrator?.prompt).toContain('Default to at most 3 parallel implementation subagents');
    expect(orchestrator?.prompt).toContain('Use parallel agents only when tasks are independent and target disjoint files or subsystems.');
    expect(orchestrator?.prompt).toContain('If tasks overlap files, share mutable state, or depend on each other, run them sequentially.');
    expect(orchestrator?.prompt).toContain('Only call `auto_continue` when the runtime exposes that tool.');
    expect(orchestrator?.prompt).toContain('If `auto_continue` is unavailable, continue normally and do not treat that as a blocker.');
    expect(orchestrator?.prompt).toContain('Treat provider/tool crashes, missing terminal status markers, or repeated progress-only output as a blocked subtask.');
    expect(orchestrator?.prompt).toContain('Continue reconciling other returned subtasks instead of waiting indefinitely for the failed branch.');
  });

  it('instructs delegated packaged specialists to block on unrecoverable runtime failures', () => {
    const agents = listPackagedAgents();
    const delegatedAgentNames = ['explorer', 'fixer', 'designer', 'oracle', 'librarian', 'council'];

    for (const agentName of delegatedAgentNames) {
      const agent = agents.find((candidate) => candidate.name === agentName);
      expect(agent?.prompt).toContain('Runtime Failure Discipline');
      expect(agent?.prompt).toContain('On unrecoverable provider/tool errors, return `<status>blocked</status>` with a concise reason.');
      expect(agent?.prompt).toContain('Avoid repeated progress-only messages such as "continuing" or "implementing" without a terminal status marker.');
      expect(agent?.prompt).toContain('Do not retry the same failing runtime operation more than once.');
    }
  });

  it('keeps Designer skill hints out of packaged Orchestrator prompts', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).not.toContain('Skill to use:');
    expect(orchestrator?.prompt).not.toContain('Frontend skill:');
  });

  it('keeps routine git checks out of Orchestrator finalization unless requested', () => {
    const orchestrator = listPackagedAgents().find((agent) => agent.name === 'orchestrator');

    expect(orchestrator?.prompt).toContain('Git Command Boundary');
    expect(orchestrator?.prompt).toContain('Do not run git commands as a default finalization or safety routine.');
    expect(orchestrator?.prompt).toContain('Only run git commands when the user explicitly asks for git work');
    expect(orchestrator?.prompt).toContain('git status');
    expect(orchestrator?.prompt).toContain('git diff');
  });

  it('keeps routine git checks out of packaged subagent completion unless requested', () => {
    const subagents = listPackagedAgents().filter((agent) => agent.frontmatter.mode === 'subagent');

    expect(subagents.map((agent) => agent.name)).toEqual(expect.arrayContaining([
      'explorer',
      'fixer',
      'designer',
      'oracle',
      'librarian',
    ]));

    for (const agent of subagents) {
      expect(agent.prompt).toContain('Git Command Boundary');
      expect(agent.prompt).toContain('Do not run git commands as a default finalization or safety routine.');
      expect(agent.prompt).toContain('Do not use `git status`, `git diff`, `git diff --stat`, or `git diff --check` to determine whether you made edits.');
      expect(agent.prompt).toContain('If you did not use an edit, write, or patch tool in this turn, report that no code changes were made without checking git.');
    }
  });

  it('preserves packaged Orchestrator/Fixer routing and question/status guardrails', () => {
    const agents = listPackagedAgents();
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    const builder = agents.find((agent) => agent.name === 'builder');
    const fixer = agents.find((agent) => agent.name === 'fixer');
    const designer = agents.find((agent) => agent.name === 'designer');
    const explorer = agents.find((agent) => agent.name === 'explorer');
    const oracle = agents.find((agent) => agent.name === 'oracle');
    const librarian = agents.find((agent) => agent.name === 'librarian');
    const plan = agents.find((agent) => agent.name === 'plan');
    const council = agents.find((agent) => agent.name === 'council');

    expect(orchestrator?.prompt).toContain('Fixer-first implementation gate');
    expect(orchestrator?.prompt).toContain('default to @fixer');
    expect(orchestrator?.prompt).toContain('bounded implementation');
    expect(orchestrator?.prompt).toContain('Writing or updating tests');
    expect(orchestrator?.prompt).toContain('Subagent prompt templates');
    expect(orchestrator?.prompt).toContain('structured question tool');
    expect(orchestrator?.prompt).toContain('Skill announcements are tool activity only');
    expect(orchestrator?.prompt).toContain('do not write assistant text to announce skill use');
    expect(orchestrator?.prompt).toContain('Do not write visible reasoning about balancing skill instructions against developer or agent instructions');
    expect(orchestrator?.prompt).toContain('the tool activity already shows skill loading, file inspection, and specialist routing');
    expect(orchestrator?.frontmatter.permission.skill['dispatching-parallel-agents']).toBe('allow');

    for (const agent of [orchestrator, builder, fixer, designer, explorer, oracle, librarian, plan]) {
      expect(agent?.prompt).toContain('structured question tool');
      expect(agent?.prompt).not.toContain('Skill to use:');
      expect(agent?.prompt).not.toContain('Skills to use:');
      expect(agent?.prompt).not.toContain('Skill plan:');
      expect(agent?.prompt).not.toContain('Subagent skill defaults');
      expect(agent?.prompt).not.toContain('delegated skill header');
      expect(agent?.prompt).not.toContain('Skill Use Guidance');
    }

    expect(builder?.prompt).toContain('Skill announcements are tool activity only');

    expect(council?.frontmatter.permission).toMatchObject({
      question: 'deny',
      'question_*': 'deny',
    });
    expect(librarian?.frontmatter.permission).toMatchObject({
      question: 'allow',
      'question_*': 'allow',
    });
    expect(council?.prompt).toContain('Do not ask the user');
    expect(fixer?.prompt).toContain('<status>complete|blocked</status>');
  });

  it('requires packaged Council output to show councillor details before consensus', () => {
    const council = listPackagedAgents().find((agent) => agent.name === 'council');
    const prompt = council?.prompt ?? '';

    const detailsIndex = prompt.indexOf('## Councillor Details');
    const responseIndex = prompt.indexOf('## Council Response');
    const summaryIndex = prompt.indexOf('## Council Summary');

    expect(detailsIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(detailsIndex).toBeLessThan(responseIndex);
    expect(responseIndex).toBeLessThan(summaryIndex);
    expect(prompt).toContain('Do not start `Council Response` until every councillor result returned by `council_session` has been included or marked failed/timed out.');
  });
});

describe('OpenCode config agent routes', () => {
  let projectDirectory;

  afterEach(async () => {
    if (projectDirectory) {
      await fs.rm(projectDirectory, { recursive: true, force: true });
    }
    projectDirectory = undefined;
  });

  it('returns 405 for agent mutations', async () => {
    projectDirectory = await makeTempProject();
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      refreshOpenCodeAfterConfigChange: async () => {},
      clientReloadDelayMs: 0,
      getAgentSources: () => ({ md: { exists: false }, json: { exists: false } }),
      getAgentConfig,
      listAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      listConfigAgents,
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
    });

    await request(app).post('/api/config/agents/builder').send({}).expect(405);
    await request(app).patch('/api/config/agents/builder').send({}).expect(405);
    await request(app).delete('/api/config/agents/builder').expect(405);
  });

  it('lists, writes, and deletes user agent model overrides', async () => {
    projectDirectory = await makeTempProject();
    const userConfigDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-route-overrides-'));
    const userConfigPath = path.join(userConfigDirectory, 'config.json');
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      refreshOpenCodeAfterConfigChange: async () => {},
      clientReloadDelayMs: 0,
      getAgentSources: () => ({ md: { exists: true, scope: 'packaged' }, json: { exists: false } }),
      getAgentConfig: (name, directory) => getAgentConfig(name, directory, { userConfigPath }),
      listAgentModelOverrides: () => listAgentModelOverrides({ userConfigPath }),
      writeAgentModelOverride: (name, body, directory) => writeAgentModelOverride(name, body, directory, { userConfigPath }),
      deleteAgentModelOverride: (name) => deleteAgentModelOverride(name, { userConfigPath }),
      listConfigAgents: (directory) => listConfigAgents(directory, { userConfigPath }),
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
    });

    await request(app)
      .put('/api/config/agents/builder/override')
      .send({ model: 'openai/gpt-5.5', variant: 'high' })
      .expect(200)
      .expect((res) => {
        expect(res.body.override).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });
        expect(res.body.agent.config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
      });

    await request(app)
      .put('/api/config/agents/builder/override')
      .send({ model: 'openai/gpt-5.5', variant: null })
      .expect(200)
      .expect((res) => {
        expect(res.body.override).toEqual({ model: 'openai/gpt-5.5', variant: null });
        expect(res.body.agent.config.variant).toBeUndefined();
      });

    await request(app)
      .get('/api/config/agent-overrides')
      .expect(200)
      .expect((res) => {
        expect(res.body.overrides.builder).toEqual({ model: 'openai/gpt-5.5', variant: null });
      });

    await request(app)
      .delete('/api/config/agents/builder/override')
      .expect(200)
      .expect((res) => {
        expect(res.body.deleted).toBe(true);
      });

    await fs.rm(userConfigDirectory, { recursive: true, force: true });
  });

  it('refreshes OpenCode after writing and deleting an agent model override', async () => {
    projectDirectory = await makeTempProject();
    const userConfigDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-route-refresh-'));
    const userConfigPath = path.join(userConfigDirectory, 'config.json');
    const refreshCalls = [];
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      refreshOpenCodeAfterConfigChange: async (reason, options) => {
        refreshCalls.push({ reason, options });
      },
      clientReloadDelayMs: 25,
      getAgentSources: () => ({ md: { exists: true, scope: 'packaged' }, json: { exists: false } }),
      getAgentConfig: (name, directory) => getAgentConfig(name, directory, { userConfigPath }),
      listAgentModelOverrides: () => listAgentModelOverrides({ userConfigPath }),
      writeAgentModelOverride: (name, body, directory) => writeAgentModelOverride(name, body, directory, { userConfigPath }),
      deleteAgentModelOverride: (name) => deleteAgentModelOverride(name, { userConfigPath }),
      listConfigAgents: (directory) => listConfigAgents(directory, { userConfigPath }),
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
    });

    await request(app)
      .put('/api/config/agents/explorer/override')
      .send({ model: 'openai/gpt-5.5', variant: 'high' })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.requiresReload).toBe(true);
        expect(res.body.reloadDelayMs).toBe(25);
        expect(res.body.reloadFailed).toBeUndefined();
      });

    await request(app)
      .delete('/api/config/agents/explorer/override')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.deleted).toBe(true);
        expect(res.body.requiresReload).toBe(true);
        expect(res.body.agent.config.model).toEqual({ providerID: 'opencode', modelID: 'deepseek-v4-flash' });
      });

    expect(refreshCalls).toEqual([
      {
        reason: 'agent explorer model override',
        options: {
          agentName: 'explorer',
          expectedAgentModelRef: 'openai/gpt-5.5',
          expectedAgentVariant: 'high',
        },
      },
      {
        reason: 'agent explorer model override reset',
        options: {
          agentName: 'explorer',
          expectedAgentModelRef: 'opencode-go/deepseek-v4-flash',
          expectedAgentVariant: 'medium',
        },
      },
    ]);

    await fs.rm(userConfigDirectory, { recursive: true, force: true });
  });

  it('keeps a saved agent override visible when OpenCode refresh fails', async () => {
    projectDirectory = await makeTempProject();
    const userConfigDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-route-refresh-fail-'));
    const userConfigPath = path.join(userConfigDirectory, 'config.json');
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => {
        throw new Error('restart failed');
      }),
      clientReloadDelayMs: 25,
      getAgentSources: () => ({ md: { exists: true, scope: 'packaged' }, json: { exists: false } }),
      getAgentConfig: (name, directory) => getAgentConfig(name, directory, { userConfigPath }),
      listAgentModelOverrides: () => listAgentModelOverrides({ userConfigPath }),
      writeAgentModelOverride: (name, body, directory) => writeAgentModelOverride(name, body, directory, { userConfigPath }),
      deleteAgentModelOverride: (name) => deleteAgentModelOverride(name, { userConfigPath }),
      listConfigAgents: (directory) => listConfigAgents(directory, { userConfigPath }),
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
    });

    await request(app)
      .put('/api/config/agents/explorer/override')
      .send({ model: 'openai/gpt-5.5', variant: 'high' })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.override).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });
        expect(res.body.requiresReload).toBe(false);
        expect(res.body.reloadFailed).toBe(true);
        expect(res.body.warning).toContain('restart failed');
      });

    expect(listAgentModelOverrides({ userConfigPath }).explorer).toEqual({
      model: 'openai/gpt-5.5',
      variant: 'high',
    });

    await fs.rm(userConfigDirectory, { recursive: true, force: true });
  });

  it('wraps MCP mutation responses while preserving legacy success fields', async () => {
    projectDirectory = await makeTempProject();
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      refreshOpenCodeAfterConfigChange: async () => {},
      clientReloadDelayMs: 25,
      getAgentSources: () => ({ md: { exists: false }, json: { exists: false } }),
      getAgentConfig,
      listAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      listConfigAgents,
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => ({ authReset: { ok: true, removed: false } }),
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
      recoverMcpConfigs: () => ({ migrated: [], skipped: [] }),
    });

    await request(app)
      .post('/api/config/mcp/linear')
      .send({ type: 'remote', url: 'https://mcp.linear.app/mcp' })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.requiresReload).toBe(true);
        expect(res.body.reloadDelayMs).toBe(25);
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'success',
          summary: 'MCP server "linear" create completed',
        }));
      });
  });

  it('wraps MCP mutation validation errors with harness metadata', async () => {
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: null, error: 'bad directory' }),
      resolveOptionalProjectDirectory: async () => ({ directory: null, error: 'bad directory' }),
      refreshOpenCodeAfterConfigChange: async () => {},
      clientReloadDelayMs: 25,
      getAgentSources: () => ({ md: { exists: false }, json: { exists: false } }),
      getAgentConfig,
      listAgentModelOverrides,
      writeAgentModelOverride,
      deleteAgentModelOverride,
      listConfigAgents,
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
      recoverMcpConfigs: () => ({ migrated: [], skipped: [] }),
    });

    await request(app)
      .post('/api/config/mcp/linear')
      .send({ type: 'remote', url: 'https://mcp.linear.app/mcp' })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe('bad directory');
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'error',
          summary: 'MCP server "linear" create failed',
        }));
      });
  });
});
