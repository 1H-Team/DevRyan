import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  configDirectories,
  mergeV2ConfigEntries,
  redactCredentials,
  toV1Agent,
  toV1Agents,
  toV1Commands,
  toV1Config,
  toV1ConfigProviders,
  toV1CurrentProject,
  toV1McpStatus,
  toV1Model,
  toV1ModelSelection,
  toV1Path,
  toV1PermissionRuleset,
  toV1Project,
  toV1Projects,
  toV1Provider,
  toV1ProviderList,
  toV1ProviderPackage,
  toV1Skills,
  toV1VcsInfo,
} from './catalog.js';

const readVector = (name) => JSON.parse(
  readFileSync(new URL(`../__vectors__/${name}`, import.meta.url), 'utf8'),
);

const restBody = (vector, label) => {
  const entry = vector.rest.find((rest) => rest.label === label);
  if (!entry) throw new Error(`missing rest ${label}`);
  return entry.body;
};

const warm = readVector('15-catalog-warm.json');
const cold = readVector('00-catalog-cold.json');

const warmCatalog = {
  providers: restBody(warm, 'provider.list').data,
  models: restBody(warm, 'model.list').data,
  defaultModel: restBody(warm, 'model.default').data,
};

const SECRET_PLACEHOLDER = '<redacted>';

describe('credential redaction', () => {
  it('drops credential-like keys at any depth and keeps the reference when clean', () => {
    const clean = { baseURL: 'https://x', timeout: 5, maxTokens: 10, nested: { region: 'eu' } };
    expect(redactCredentials(clean)).toBe(clean);
    expect(redactCredentials({
      apiKey: 'a', api_key: 'b', key: 'c', 'x-api-key': 'd', accessToken: 'e', client_secret: 'f',
      password: 'g', Authorization: 'h', 'Proxy-Authorization': 'i', cookie: 'j', credentials: 'k',
      baseURL: 'https://x', nested: { refresh_token: 'l', keep: 1 },
    })).toEqual({ baseURL: 'https://x', nested: { keep: 1 } });
    expect(redactCredentials(null)).toEqual({});
  });
});

describe('providers and models (15-catalog-warm vector)', () => {
  it('builds the v1 /config/providers payload', () => {
    const payload = toV1ConfigProviders(warmCatalog);
    expect(payload.providers.map((provider) => provider.id)).toEqual(['opencode', 'sim']);
    expect(payload.default).toEqual({ opencode: 'longcat-2.5-preview-free', sim: 'm1' });
    expect(JSON.stringify(payload)).not.toContain(SECRET_PLACEHOLDER);
    expect(JSON.stringify(payload)).not.toContain('apiKey');

    const sim = payload.providers.find((provider) => provider.id === 'sim');
    expect(sim).toEqual({
      id: 'sim',
      name: 'Simulated',
      source: 'config',
      env: [],
      options: { baseURL: 'https://api.openai.com/v1', provider: 'sim' },
      models: {
        m1: expect.objectContaining({ id: 'm1', name: 'sim m1' }),
        m2: expect.objectContaining({ id: 'm2', name: 'sim m2' }),
      },
    });
    expect(payload.providers[0]).toMatchObject({ id: 'opencode', source: 'api', integrationID: 'opencode' });
  });

  it('projects a v2 model into the v1 Model shape', () => {
    const provider = warmCatalog.providers.find((entry) => entry.id === 'sim');
    const model = warmCatalog.models.find((entry) => entry.id === 'm1');
    expect(toV1Model(model, provider)).toEqual({
      id: 'm1',
      providerID: 'sim',
      api: { id: 'm1', url: 'https://api.openai.com/v1', npm: '@ai-sdk/openai-compatible' },
      name: 'sim m1',
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200000, output: 32000 },
      status: 'active',
      options: {},
      headers: {},
      release_date: '',
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
    });
  });

  it('maps reasoning fields, input limits, families and release dates', () => {
    const bunny = toV1Model(warmCatalog.models.find((entry) => entry.id === 'space-bunny-free'));
    expect(bunny).toMatchObject({
      capabilities: { reasoning: true, interleaved: { field: 'reasoning_content' } },
      limit: { context: 1048576, input: 524288, output: 524288 },
      release_date: '2026-01-01',
    });
    expect(Object.keys(bunny?.variants ?? {})).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(toV1Model(warmCatalog.models.find((entry) => entry.id === 'big-pickle'))).toMatchObject({ family: expect.any(String) });
    expect(toV1Model({ providerID: 'p' })).toBeNull();
  });

  it('projects tiered costs and keeps model-specific options', () => {
    const model = toV1Model({
      id: 'x',
      providerID: 'p',
      name: 'X',
      settings: { baseURL: 'https://p', apiKey: 'secret-value', reasoningEffort: 'high' },
      headers: { Authorization: 'Bearer secret-value', 'x-trace': '1' },
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      variants: [],
      cost: [
        { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
        { tier: { type: 'context', size: 200000 }, input: 3, output: 4, cache: { read: 0.3, write: 0.4 } },
      ],
      time: { released: 0 },
      status: 'beta',
      enabled: true,
      limit: { context: 1, output: 1 },
    }, { id: 'p', settings: { baseURL: 'https://p' } });
    expect(model).toMatchObject({
      capabilities: { reasoning: false, attachment: false, toolcall: false },
      cost: {
        input: 1, output: 2, cache: { read: 0.1, write: 0.2 },
        tiers: [{ input: 3, output: 4, cache: { read: 0.3, write: 0.4 }, tier: { type: 'context', size: 200000 } }],
      },
      options: { reasoningEffort: 'high' },
      headers: { 'x-trace': '1' },
      status: 'beta',
    });
    expect(JSON.stringify(model)).not.toContain('secret-value');
  });

  it('builds the v1 /provider payload with connected ids', () => {
    const payload = toV1ProviderList(warmCatalog);
    expect(payload.all.map((provider) => provider.id)).toEqual(['opencode', 'sim']);
    expect(payload.connected).toEqual(['opencode', 'sim']);
    expect(payload.default).toEqual({ opencode: 'longcat-2.5-preview-free', sim: 'm1' });
  });

  it('excludes disabled providers and disabled models from the usable view', () => {
    const providers = [
      { id: 'a', name: 'A', activation: 'enabled', package: '@opencode/ai/providers/anthropic' },
      { id: 'b', name: 'B', activation: 'disabled', package: '' },
      { id: 'c', name: 'C', activation: 'auto', package: '' },
    ];
    const models = [
      { id: 'a1', providerID: 'a', name: 'a1', enabled: false },
      { id: 'a2', providerID: 'a', name: 'a2', enabled: true },
      { id: 'b1', providerID: 'b', name: 'b1', enabled: true },
      { id: 'c1', providerID: 'c', name: 'c1', enabled: false },
    ];
    const defaultModel = { id: 'b1', providerID: 'b' };
    const usable = toV1ConfigProviders({ providers, models, defaultModel });
    expect(usable.providers.map((provider) => provider.id)).toEqual(['a']);
    expect(Object.keys(usable.providers[0].models)).toEqual(['a2']);
    expect(usable.default).toEqual({ a: 'a2' });

    const list = toV1ProviderList({ providers, models, defaultModel });
    expect(list.all.map((provider) => provider.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(list.all[0].models)).toEqual(['a1', 'a2']);
    expect(list.connected).toEqual(['a']);
    expect(toV1Provider({ name: 'no id' }, [])).toBeNull();
  });

  it('returns empty payloads for a cold location', () => {
    const coldCatalog = {
      providers: restBody(cold, 'provider.list').data,
      models: restBody(cold, 'model.list').data,
      defaultModel: restBody(cold, 'model.default').data,
    };
    expect(toV1ConfigProviders(coldCatalog)).toEqual({ providers: [], default: {} });
    expect(toV1ProviderList(coldCatalog)).toEqual({ all: [], default: {}, connected: [] });
    expect(toV1Agents(restBody(cold, 'agent.list').data)).toEqual([]);
  });

  it.each([
    ['@opencode/ai/providers/openai-compatible', '@ai-sdk/openai-compatible'],
    ['@opencode/ai/providers/anthropic', '@ai-sdk/anthropic'],
    ['@opencode/ai/providers/google-vertex/messages', '@ai-sdk/google-vertex/anthropic'],
    ['@opencode/ai/providers/openrouter', '@openrouter/ai-sdk-provider'],
    ['@opencode/ai/providers/azure/responses', '@ai-sdk/azure'],
    ['@opencode/ai/providers/moonshot/messages', '@ai-sdk/anthropic'],
    ['@opencode/ai/providers/zai/chat', '@ai-sdk/openai-compatible'],
    ['@opencode/ai/providers/deepseek', '@ai-sdk/openai-compatible'],
    ['some-custom-package', 'some-custom-package'],
    [undefined, ''],
  ])('maps package %s to v1 npm %s', (pkg, npm) => {
    expect(toV1ProviderPackage(pkg)).toBe(npm);
  });
});

describe('agents (15-catalog-warm vector)', () => {
  const agents = restBody(warm, 'agent.list').data;

  it('keys agents by id and maps prompts and rules', () => {
    const projected = toV1Agents(agents);
    expect(projected.map((agent) => agent.name))
      .toEqual(['build', 'general', 'explore', 'compaction', 'title', 'summary', 'plan']);
    const build = projected[0];
    expect(build).toMatchObject({
      name: 'build',
      description: 'The default agent. Executes tools based on configured permissions.',
      mode: 'primary',
      hidden: false,
      options: {},
    });
    expect(build.permission[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' });
    expect(build.permission).toHaveLength(agents[0].permissions.length);
    expect(projected[2].prompt).toBe(agents[2].system);
    expect(projected.find((agent) => agent.name === 'title')).toMatchObject({ hidden: true });
    expect(build.model).toBeUndefined();
  });

  it('maps the model ref, variant, request body and v2 action names', () => {
    expect(toV1Agent({
      id: 'coder',
      name: 'Coder',
      model: { id: 'gpt-5', providerID: 'openai', variant: 'high' },
      request: { settings: { apiKey: 'secret-value', store: false }, headers: {}, body: { temperature: 0, top_p: 0.9 } },
      mode: 'subagent',
      hidden: false,
      color: '#aabbcc',
      steps: 5,
      permissions: [{ action: 'shell', resource: 'git *', effect: 'ask' }, { action: 'subagent', resource: '*', effect: 'deny' }],
    })).toEqual({
      name: 'coder',
      mode: 'subagent',
      hidden: false,
      color: '#aabbcc',
      steps: 5,
      temperature: 0,
      topP: 0.9,
      options: { store: false },
      model: { modelID: 'gpt-5', providerID: 'openai' },
      variant: 'high',
      permission: [
        { permission: 'bash', pattern: 'git *', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'deny' },
      ],
    });
    expect(toV1Agent({ name: 'no id' })).toBeNull();
    expect(toV1PermissionRuleset([{ action: 'edit' }, null])).toEqual([]);
  });
});

describe('commands, skills and MCP', () => {
  it('projects the command list and enriches it from the merged config', () => {
    const commands = restBody(warm, 'command.list').data;
    expect(toV1Commands(commands)).toEqual([
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command', template: '', hints: [] },
      { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted', source: 'command', template: '', hints: [] },
      { name: 'probe', description: 'Trace probe command', source: 'command', template: '', hints: [] },
    ]);
    const config = toV1Config([{
      type: 'document',
      info: { commands: { probe: { template: 'Run $ARGUMENTS', agent: 'plan', model: 'sim/m2#high', subagent: true } } },
    }]);
    expect(toV1Commands(commands, { config })[2]).toEqual({
      name: 'probe',
      description: 'Trace probe command',
      source: 'command',
      template: 'Run $ARGUMENTS',
      agent: 'plan',
      model: 'sim/m2',
      subtask: true,
      hints: [],
    });
  });

  it('projects skills to name/location/content and keeps the v2 id', () => {
    const skills = toV1Skills(restBody(warm, 'skill.list').data);
    expect(skills.map((skill) => [skill.id, skill.name, skill.location])).toEqual([
      ['opencode', 'OpenCode', '/builtin/opencode.md'],
      ['report', 'Report', '/builtin/report.md'],
      ['probe-skill', 'probe-skill', '<home>/overlay/skills/probe-skill/SKILL.md'],
    ]);
    expect(typeof skills[0].content).toBe('string');
    expect(toV1Skills([{ id: 'x', path: '/x', content: 'c', autoinvoke: false }]))
      .toEqual([{ id: 'x', name: 'x', location: '/x', content: 'c', autoinvoke: false }]);
  });

  it('turns the MCP server list into the v1 status record', () => {
    expect(toV1McpStatus(restBody(warm, 'mcp.list').data)).toEqual({});
    expect(toV1McpStatus([
      { name: 'a', status: { status: 'connected' } },
      { name: 'b', status: { status: 'failed', error: 'boom' } },
      { name: 'c', status: { status: 'needs_auth', error: 'login' }, integrationID: 'mcp:c' },
      { name: 'd', status: { status: 'pending' } },
      { name: 'e' },
    ])).toEqual({
      a: { status: 'connected' },
      b: { status: 'failed', error: 'boom' },
      c: { status: 'needs_auth', error: 'login' },
      d: { status: 'pending' },
    });
  });
});

describe('merged config view', () => {
  it('projects the recorded entry list without credentials', () => {
    const entries = restBody(warm, 'config.get');
    expect(configDirectories(entries)).toEqual(['<home>/overlay']);
    const config = toV1Config(entries);
    expect(config).toEqual({
      share: 'disabled',
      model: 'sim/m1',
      snapshot: false,
      autoupdate: false,
      provider: {
        sim: {
          name: 'Simulated',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://api.openai.com/v1' },
          models: {
            m1: { name: 'sim m1', limit: { context: 200000, output: 32000 } },
            m2: { name: 'sim m2', limit: { context: 200000, output: 32000 } },
          },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain(SECRET_PLACEHOLDER);
  });

  it('merges layers low to high and accumulates ordered rulesets', () => {
    const entries = [
      { type: 'directory', path: '/global' },
      {
        type: 'document',
        info: {
          username: 'low',
          permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
          plugins: ['a'],
          agents: { build: { description: 'low', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] } },
          instructions: ['low.md'],
        },
      },
      {
        type: 'document',
        info: {
          username: 'high',
          permissions: [{ action: 'shell', resource: 'git *', effect: 'allow' }],
          plugins: ['-a', { package: 'b', options: { x: 1 } }],
          agents: { build: { model: 'p/m#v', permissions: [{ action: 'shell', resource: 'rm *', effect: 'deny' }] } },
          instructions: ['high.md'],
        },
      },
    ];
    const merged = mergeV2ConfigEntries(entries);
    expect(merged.username).toBe('high');
    expect(merged.permissions).toHaveLength(2);
    expect(merged.instructions).toEqual(['high.md']);
    expect(merged.agents.build).toMatchObject({ description: 'low', model: 'p/m#v' });
    expect(merged.agents.build.permissions).toHaveLength(2);

    const config = toV1Config(entries);
    expect(config.permission).toEqual({ edit: 'ask', bash: { 'git *': 'allow' } });
    expect(config.plugin).toEqual(['a', '-a', ['b', { x: 1 }]]);
    expect(config.agent).toEqual({
      build: { description: 'low', model: 'p/m', variant: 'v', permission: { bash: { '*': 'ask', 'rm *': 'deny' } } },
    });
  });

  it('renames agent, command, MCP, skill and update keys', () => {
    const config = toV1Config([{
      type: 'document',
      info: {
        update: 'notify',
        skills: ['./skills', 'https://example.invalid/skills'],
        agents: {
          title: { model: { providerID: 'p', model: 'small' }, disabled: true, system: 'Title it' },
        },
        mcp: {
          timeout: { execution: 3000 },
          servers: {
            local: { type: 'local', command: ['node', 'x.js'], environment: { TOKEN: 'secret-value', MODE: 'x' } },
            remote: {
              type: 'remote',
              url: 'https://mcp.invalid',
              headers: { Authorization: 'Bearer secret-value' },
              oauth: { client_id: 'id', client_secret: 'secret-value', scope: 's' },
              disabled: true,
              timeout: { execution: 9000 },
            },
          },
        },
      },
    }]);
    expect(config).toEqual({
      autoupdate: 'notify',
      skills: { paths: ['./skills'], urls: ['https://example.invalid/skills'] },
      agent: { title: { model: 'p/small', prompt: 'Title it', disable: true } },
      small_model: 'p/small',
      mcp: {
        local: { type: 'local', enabled: true, command: ['node', 'x.js'], environment: { MODE: 'x' }, timeout: 3000 },
        remote: {
          type: 'remote', enabled: false, url: 'https://mcp.invalid', headers: {},
          oauth: { clientId: 'id', scope: 's' }, timeout: 9000,
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('secret-value');
  });

  it.each([
    ['p/m', { model: 'p/m' }],
    ['p/m#high', { model: 'p/m', variant: 'high' }],
    [{ providerID: 'p', model: 'm', variant: 'low' }, { model: 'p/m', variant: 'low' }],
    ['no-provider', null],
    [{ providerID: 'p' }, null],
  ])('parses model selection %j', (selection, expected) => {
    expect(toV1ModelSelection(selection)).toEqual(expected);
  });
});

describe('path, project and vcs', () => {
  const location = restBody(warm, 'location.get');
  const projects = restBody(warm, 'project.list');

  it('builds v1 /path from the location and host paths', () => {
    expect(toV1Path(location, { home: '<home>', state: '<home>/state', config: '<home>/config' })).toEqual({
      home: '<home>',
      state: '<home>/state',
      config: '<home>/config',
      worktree: '<home>/workspace',
      directory: '<home>/workspace',
    });
    expect(toV1Path(location)).toMatchObject({ home: '', state: '', config: '' });
    expect(toV1Path({})).toBeNull();
  });

  it('maps projects with worktree = canonical', () => {
    expect(toV1Projects(projects).map((project) => [project.id, project.worktree])).toEqual([
      ['0000000000000000000000000000000000000001', '<home>/does-not-exist'],
      ['0000000000000000000000000000000000000002', '<home>'],
      ['global', '<home>/workspace'],
    ]);
    expect(toV1Project(projects[2])).toEqual({
      id: 'global',
      worktree: '<home>/workspace',
      vcs: 'git',
      time: { created: projects[2].time.created, updated: projects[2].time.updated },
      sandboxes: [],
    });
  });

  it('resolves the current project from the list or the location alone', () => {
    expect(toV1CurrentProject(location, projects)).toEqual(toV1Project(projects[2]));
    expect(toV1CurrentProject(location)).toEqual({
      id: 'global', worktree: '<home>/workspace', time: { created: 0, updated: 0 }, sandboxes: [],
    });
    expect(toV1CurrentProject({ directory: '/x' })).toBeNull();
  });

  it('maps vcs branch info', () => {
    expect(toV1VcsInfo(restBody(warm, 'vcs.get').data)).toEqual({ branch: 'main' });
    expect(toV1VcsInfo({ branch: { current: 'feat', default: 'main' } })).toEqual({ branch: 'feat', default_branch: 'main' });
    expect(toV1VcsInfo(null)).toEqual({});
  });
});
