import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';
import {
  SLIM_BEHAVIOURS,
  captureParityManifest,
  createPathNormalizer,
  diffManifests,
  main,
  parseArgs,
  serializeManifest,
  sha256,
} from './parity-manifest.mjs';

const DIRECTORY = '/qa/fixture/workspace';
const QA_HOME = '/qa/private-home';
const ORIGIN = 'http://127.0.0.1:47123';
const SECRET = 'sk-live-SECRET-VALUE';
const PROMPT = `You are the orchestrator. Work inside ${DIRECTORY}.`;

const fixtureResponses = () => ({
  '/api/health': {
    status: 'ok', timestamp: '2026-09-30T00:00:00.000Z', openCodePort: 4096, openCodeVersion: `${TARGET_OPENCODE_VERSION}-devryan.4`,
    openCodeRunning: true, isOpenCodeReady: true, openCodeSecureConnection: true, openCodeAuthSource: 'generated',
    openCodeApiPrefix: '', executionRuntime: { state: 'active', code: null }, opencodeBinaryResolved: '/secret/path/opencode',
    opencodeBinarySource: 'companion', lastOpenCodeError: `boom ${SECRET}`, planModeExperimentalEnabled: true,
    multiUserControlPlane: { state: 'disabled' },
  },
  '/api/agent': [
    {
      name: 'orchestrator', mode: 'primary', native: false, permission: [
        { permission: '*', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: `${QA_HOME}/.config/opencode/**`, action: 'deny' },
      ], model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: 'high', prompt: PROMPT, options: { zeta: 1, alpha: { apiKey: SECRET } }, temperature: 0.2,
    },
    { name: 'build', mode: 'primary', native: true, hidden: false, permission: [], options: {} },
  ],
  '/api/command': [
    { name: 'reflect', description: 'Reflect', template: 'Reflect on $ARGUMENTS', hints: ['$ARGUMENTS'], source: 'command' },
    { name: 'interview', template: 'Interview', hints: [] },
  ],
  '/api/config': {
    default_agent: 'orchestrator', model: 'openai/gpt-5.5',
    plugin: ['./plugins/devryan-oh-my-opencode-slim.mjs', ['opencode-gpt-imagegen', { apiKey: SECRET }], 'git+https://user:token123@example.com/p.git'],
    instructions: [`${DIRECTORY}/AGENTS.md`],
    skills: { paths: [`${QA_HOME}/skills`], urls: [`https://skills.example.com/index.json?token=${SECRET}`] },
    permission: { edit: 'ask', external_directory: { [`${DIRECTORY}/**`]: 'allow' } },
    mcp: {
      zeta: { type: 'remote', url: `https://mcp.example.com/?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` }, oauth: { clientSecret: SECRET } },
      alpha: { type: 'local', command: ['run', SECRET], environment: { TOKEN: SECRET }, enabled: false },
    },
    provider: { openai: { options: { apiKey: SECRET }, models: { 'gpt-5.5': { name: 'x' }, 'gpt-5.4': {} } } },
    experimental: { primary_tools: ['task'], batch_tool: true },
    lsp: false,
    formatter: { prettier: { command: ['prettier'] } },
  },
  '/api/mcp': { zeta: { status: 'failed', error: `connect https://mcp.example.com/?key=${SECRET}` }, alpha: { status: 'disabled' } },
  '/api/experimental/tool/ids': ['webfetch', 'task_status', 'bash', 'task_status'],
  '/api/experimental/tool': [
    { id: 'bash', description: `Run in ${DIRECTORY}`, parameters: { type: 'object', properties: { b: {}, a: {} } } },
  ],
  '/api/skill': [
    { name: 'tdd', description: 'Test first', location: `${QA_HOME}/.config/opencode/skills/tdd/SKILL.md`, content: '# TDD' },
  ],
  '/api/config/skills': { skills: [{ name: 'tdd', scope: 'user', source: 'opencode', path: '/x' }] },
  '/api/config/slim/status': {
    ok: true, installedVersion: '2.2.25', runtimeEnabled: true, wrapperConfigured: true, wrapperStatus: { rawRegistered: false },
    packageDependencyInstalled: true, slimConfigExists: true, backgroundSubagentsEnv: 'true', issues: [], configPath: '/secret',
  },
});

const createFetch = (responses = fixtureResponses(), statusOverrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    const status = statusOverrides[parsed.pathname];
    if (status) return new Response('{"error":"nope"}', { status });
    if (!(parsed.pathname in responses)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(responses[parsed.pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
};

const capture = (options = {}) => captureParityManifest({
  origin: ORIGIN, directory: DIRECTORY, qaHome: QA_HOME, env: {}, userHome: '/qa/user', now: () => new Date('2026-09-30T12:00:00Z'),
  readFileImpl: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  ...options,
});

const assertSortedKeys = (value) => {
  if (Array.isArray(value)) return value.forEach(assertSortedKeys);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    assert.deepEqual(keys, [...keys].sort(), `keys not sorted: ${keys.join(',')}`);
    Object.values(value).forEach(assertSortedKeys);
  }
};

test('captures a sorted, hashed manifest through GET routes with the workspace directory', async () => {
  const { fetchImpl, calls } = createFetch();
  const manifest = await capture({ fetchImpl });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.capturedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(manifest.origin, '127.0.0.1:47123');
  assert.deepEqual(manifest.runtime, { expected: TARGET_OPENCODE_VERSION, observed: `${TARGET_OPENCODE_VERSION}-devryan.4`, observedBase: TARGET_OPENCODE_VERSION, source: 'host-pin' });
  assertSortedKeys(manifest);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    if (call.url.pathname === '/api/health' || call.url.pathname === '/api/config/slim/status') continue;
    assert.equal(call.url.searchParams.get('directory'), DIRECTORY);
    assert.equal(call.init.headers['x-opencode-directory'], DIRECTORY);
  }
  const toolCall = calls.find(call => call.url.pathname === '/api/experimental/tool');
  assert.equal(toolCall.url.searchParams.get('provider'), 'openai');
  assert.equal(toolCall.url.searchParams.get('model'), 'gpt-5.5');

  const { agents, commands, toolIds, tools, mcp, skills, devryan, devryanSkills, devryanSlim } = manifest.sections;
  assert.deepEqual(agents.data.map(agent => agent.name), ['build', 'orchestrator']);
  const orchestrator = agents.data[1];
  const normalizedPrompt = PROMPT.replace(DIRECTORY, '<directory>');
  assert.deepEqual(orchestrator.prompt, { length: normalizedPrompt.length, sha256: sha256(normalizedPrompt) });
  assert.deepEqual(orchestrator.optionKeys, ['alpha', 'zeta']);
  assert.deepEqual(orchestrator.model, { modelID: 'gpt-5.5', providerID: 'openai' });
  assert.equal(orchestrator.variant, 'high');
  assert.equal(orchestrator.permission[1].pattern, '<qa-home>/.config/opencode/**', 'rule order and normalized path kept');
  assert.equal(agents.data[0].builtIn, true);
  assert.deepEqual(commands.data.map(command => command.name), ['interview', 'reflect']);
  assert.deepEqual(commands.data[1].template, { length: 'Reflect on $ARGUMENTS'.length, sha256: sha256('Reflect on $ARGUMENTS') });
  assert.deepEqual(toolIds.data, ['bash', 'task_status', 'webfetch']);
  assert.equal(tools.status, 'captured');
  assert.deepEqual(tools.selection, { from: 'default-agent', modelID: 'gpt-5.5', providerID: 'openai' });
  assert.equal(tools.data[0].description.sha256, sha256('Run in <directory>'));
  // Parameter schemas are hashed in canonical key order.
  assert.equal(tools.data[0].parametersSha256, sha256('{"properties":{"a":{},"b":{}},"type":"object"}'));
  assert.deepEqual(mcp.data, [{ hasError: false, id: 'alpha', status: 'disabled' }, { hasError: true, id: 'zeta', status: 'failed' }]);
  assert.deepEqual(skills.data[0], {
    content: { length: 5, sha256: sha256('# TDD') }, description: { length: 10, sha256: sha256('Test first') },
    location: '<qa-home>/.config/opencode/skills/tdd/SKILL.md', name: 'tdd', sourceRoot: '<qa-home>/.config/opencode/skills',
  });
  // Runtime identity lives in the header; the companion suffix never counts as a catalog difference.
  assert.equal(Object.hasOwn(devryan.data, 'openCodeVersionSuffix'), false);
  assert.deepEqual(devryan.data.executionRuntime, { code: null, state: 'active' });
  assert.deepEqual(devryanSkills.data, [{ name: 'tdd', scope: 'user', source: 'opencode' }]);
  assert.equal(devryanSlim.data.installedVersion, '2.2.25');
});

test('redacts secrets from config, MCP, health and plugin entries', async () => {
  const manifest = await capture({ fetchImpl: createFetch().fetchImpl });
  const serialized = serializeManifest(manifest);
  for (const forbidden of [SECRET, 'token123', 'Bearer', 'mcp.example.com', '/secret', 'Authorization', 'clientSecret', PROMPT]) {
    assert.equal(serialized.includes(forbidden), false, `manifest leaked ${forbidden}`);
  }
  const { config } = manifest.sections;
  assert.deepEqual(config.data.mcp, [{ enabled: false, id: 'alpha', type: 'local' }, { enabled: null, id: 'zeta', type: 'remote' }]);
  assert.deepEqual(config.data.providers, [{ id: 'openai', models: ['gpt-5.4', 'gpt-5.5'] }]);
  assert.deepEqual(config.data.plugins, ['./plugins/devryan-oh-my-opencode-slim.mjs', 'opencode-gpt-imagegen', 'git+https://<redacted>@example.com/p.git']);
  assert.deepEqual(config.data.skills, { paths: ['<qa-home>/skills'], urls: ['https://skills.example.com/index.json?token=<redacted>'] });
  assert.deepEqual(config.data.instructions, ['<directory>/AGENTS.md']);
  assert.deepEqual(config.data.permission, { edit: 'ask', external_directory: { '<directory>/**': 'allow' } });
  assert.deepEqual(config.data.experimentalKeys, ['batch_tool', 'primary_tools']);
  assert.deepEqual(config.data.lsp, { state: 'disabled' });
  assert.deepEqual(config.data.formatter, { ids: ['prettier'], state: 'configured' });
  assert.equal(config.data.defaultAgent, 'orchestrator');
});

test('the Slim checklist confirms commands and tools from live lists and marks the rest static', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parity-slim-'));
  try {
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.2.25' }));
    await writeFile(path.join(root, 'dist', 'index.js'), 'export default {}');
    const manifest = await capture({ fetchImpl: createFetch().fetchImpl, slimPackage: root, readFileImpl: readFile, qaHome: undefined });
    const { package: slimPackage, checklist } = manifest.sections.slim.data;
    assert.deepEqual(slimPackage, { data: { distIndexSha256: sha256('export default {}'), packageName: 'oh-my-opencode-slim', version: '2.2.25', wrapperSha256: null }, status: 'captured' });
    assert.equal(checklist.length, SLIM_BEHAVIOURS.length);
    assert.deepEqual(checklist.map(item => item.id), [...checklist.map(item => item.id)].sort());
    const byId = Object.fromEntries(checklist.map(item => [item.id, item]));
    assert.equal(byId['command.reflect'].observed, true);
    assert.equal(byId['command.deepwork'].observed, false);
    assert.equal(byId['tool.task_status'].observed, true);
    assert.equal(byId['tool.wait_for_user'].observed, false);
    assert.equal(byId['tool.wait_for_user'].evidence, 'live-tool-ids');
    assert.equal(byId['hook.loop-guard'].observed, null);
    assert.equal(byId['hook.loop-guard'].evidence, 'static');
    assert.equal(byId['behaviour.retry-fallback'].devryan, 'disabled-by-overlay');
    assert.equal(byId['behaviour.orchestrator-wake-prompts'].devryan, 'hidden-by-wrapper');
    assert.equal(byId['behaviour.phase-reminders'].devryan, 'stripped-by-wrapper');
    assert.equal(byId['behaviour.permission-bridge'].devryan, 'absent-on-v1');
    assert.equal(byId['tool.task_status'].devryan, 'unused');
    assert.equal(byId['tool.webfetch'].devryan, 'relies');
    assert.equal(byId['hook.loop-guard'].devryan, 'relies');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent routes are skipped with a reason and other failures are recorded without bodies', async () => {
  const responses = fixtureResponses();
  delete responses['/api/skill'];
  responses['/api/command'] = { not: 'a list' };
  const { fetchImpl } = createFetch(responses, { '/api/mcp': 500 });
  const manifest = await capture({ fetchImpl });
  assert.deepEqual(manifest.sections.skills, { reason: 'route not available on this runtime (HTTP 404)', source: 'GET /api/skill', status: 'skipped' });
  assert.deepEqual(manifest.sections.mcp, { reason: 'HTTP 500', source: 'GET /api/mcp', status: 'error' });
  assert.equal(manifest.sections.commands.reason, 'unexpected response shape');
  const commandItems = manifest.sections.slim.data.checklist.filter(item => item.kind === 'command');
  assert.ok(commandItems.every(item => item.observed === null && item.evidence === 'unavailable'));
});

test('tool definitions are skipped when no provider/model can be resolved, and flags win', async () => {
  const responses = fixtureResponses();
  responses['/api/config'] = { ...responses['/api/config'], default_agent: undefined, model: undefined };
  const skipped = await capture({ fetchImpl: createFetch(responses).fetchImpl });
  assert.equal(skipped.sections.tools.status, 'skipped');
  const flagged = await capture({ fetchImpl: createFetch(responses).fetchImpl, provider: 'anthropic', model: 'claude' });
  assert.deepEqual(flagged.sections.tools.selection, { from: 'flags', modelID: 'claude', providerID: 'anthropic' });
});

test('runtime mismatch, an unready host and credentialed origins are fatal', async () => {
  await assert.rejects(capture({ fetchImpl: createFetch().fetchImpl, expectRuntime: '2.0.21' }), /does not match expected 2\.0\.21 \(--expect-runtime\)/);
  await assert.rejects(capture({ fetchImpl: createFetch().fetchImpl, expectRuntime: '' }), /--expect-runtime requires an exact OpenCode version/);
  const candidate = await capture({ fetchImpl: createFetch().fetchImpl, env: { DEVRYAN_QA_OPENCODE_VERSION: TARGET_OPENCODE_VERSION } });
  assert.equal(candidate.runtime.source, 'DEVRYAN_QA_OPENCODE_VERSION');
  await assert.rejects(capture({ fetchImpl: createFetch().fetchImpl, expectRuntime: 'latest' }), /exact OpenCode version/);
  const unready = fixtureResponses();
  unready['/api/health'] = { ...unready['/api/health'], isOpenCodeReady: false };
  await assert.rejects(capture({ fetchImpl: createFetch(unready).fetchImpl }), /not ready/);
  await assert.rejects(capture({ fetchImpl: createFetch().fetchImpl, origin: 'http://u:p@127.0.0.1:1' }), /must not carry credentials/);
  await assert.rejects(capture({ fetchImpl: createFetch().fetchImpl, directory: 'relative' }), /absolute path/);
});

test('path normalizer prefers the longest root and redacts URL credentials', () => {
  const normalize = createPathNormalizer({ directory: '/u/home/work', qaHome: '/u/qa', userHome: '/u/home' });
  assert.equal(normalize('/u/home/work/a /u/home/b /u/qa/c'), '<directory>/a <home>/b <qa-home>/c');
  assert.equal(normalize('https://x:y@h/p?api_key=abc&v=1'), 'https://<redacted>@h/p?api_key=<redacted>&v=1');
});

test('diff reports added/removed/changed per section, ignores runtime identity, and sets exit codes', async () => {
  const baseline = await capture({ fetchImpl: createFetch().fetchImpl, qaHome: undefined });
  const same = await capture({ fetchImpl: createFetch().fetchImpl, qaHome: undefined, now: () => new Date('2026-10-01T00:00:00Z') });
  const unchanged = diffManifests(baseline, { ...same, runtime: { ...same.runtime, observed: '2.0.20' } });
  assert.equal(unchanged.different, false);
  assert.equal(unchanged.complete, true);
  assert.deepEqual(unchanged.sections, {});
  assert.equal(unchanged.header.candidateRuntime.observed, '2.0.20');

  const responses = fixtureResponses();
  responses['/api/agent'] = [{ ...responses['/api/agent'][0], prompt: 'changed', variant: undefined }, { name: 'explorer', mode: 'subagent', permission: [], options: {} }];
  responses['/api/experimental/tool/ids'] = ['bash', 'task_status', 'grep'];
  delete responses['/api/skill'];
  const changed = diffManifests(baseline, await capture({ fetchImpl: createFetch(responses).fetchImpl, qaHome: undefined }));
  assert.equal(changed.different, true);
  assert.deepEqual(changed.sections.agents.added, ['explorer']);
  assert.deepEqual(changed.sections.agents.removed, ['build']);
  assert.deepEqual(changed.sections.agents.changed.map(entry => entry.key), ['orchestrator']);
  assert.deepEqual(changed.sections.agents.changed[0].changes.map(change => change.path), ['prompt.length', 'prompt.sha256', 'variant']);
  assert.deepEqual(changed.sections.toolIds.added, ['grep']);
  assert.deepEqual(changed.sections.toolIds.removed, ['webfetch']);
  assert.deepEqual(changed.sections.skills.status, { after: 'skipped', before: 'captured' });
  const checklistChange = changed.sections.slim.changed.find(change => change.path === 'checklist[tool.webfetch].observed');
  assert.deepEqual(checklistChange, { after: false, before: true, path: 'checklist[tool.webfetch].observed' });

  const root = await mkdtemp(path.join(os.tmpdir(), 'parity-diff-'));
  try {
    const baselineFile = path.join(root, 'baseline.json');
    const sameFile = path.join(root, 'same.json');
    const changedFile = path.join(root, 'changed.json');
    await writeFile(baselineFile, serializeManifest(baseline));
    await writeFile(sameFile, serializeManifest(same));
    await writeFile(changedFile, serializeManifest(await capture({ fetchImpl: createFetch(responses).fetchImpl, qaHome: undefined })));
    const sink = () => { const chunks = []; return { write: chunk => chunks.push(chunk), text: () => chunks.join('') }; };
    const out0 = sink();
    assert.equal(await main(['--diff', baselineFile, '--candidate', sameFile], { stdout: out0, stderr: sink() }), 0);
    assert.equal(JSON.parse(out0.text()).different, false);
    const out1 = sink();
    assert.equal(await main(['--diff', baselineFile, '--candidate', changedFile], { stdout: out1, stderr: sink() }), 1);
    assert.equal(JSON.parse(out1.text()).different, true);
    assert.equal(await main(['--diff', path.join(root, 'missing.json'), '--candidate', sameFile], { stdout: sink(), stderr: sink() }), 2);
    // A live capture diffed against and written to the same file still compares
    // against the baseline that was there before, not against itself.
    const out2 = sink();
    assert.equal(await main(['--origin', 'http://127.0.0.1:4040', '--directory', '/synthetic/workspace', '--diff', baselineFile, '--out', baselineFile],
      { fetchImpl: createFetch(responses).fetchImpl, stdout: out2, stderr: sink(), env: {} }), 1);
    assert.equal(JSON.parse(out2.text()).different, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saved manifest comparison rejects missing schemas and cannot equate failed or skipped captures with parity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parity-invalid-'));
  try {
    const baselineFile = path.join(root, 'baseline.json');
    const candidateFile = path.join(root, 'candidate.json');
    const valid = await capture({ fetchImpl: createFetch().fetchImpl, qaHome: undefined });
    const sink = { write: () => {} };
    for (const side of ['baseline', 'candidate', 'both']) {
      for (const failure of ['section-error', 'section-skipped', 'nested-package-error']) {
        const invalid = structuredClone(valid);
        if (failure === 'nested-package-error') invalid.sections.slim.data.package = { status: 'error', reason: 'package unavailable' };
        else invalid.sections.agents = { status: failure === 'section-error' ? 'error' : 'skipped', reason: 'capture unavailable' };
        const baseline = side === 'candidate' ? valid : invalid;
        const candidate = side === 'baseline' ? valid : invalid;
        const diff = diffManifests(baseline, candidate);
        assert.equal(diff.complete, false, `${side}: ${failure}`);
        await writeFile(baselineFile, serializeManifest(baseline));
        await writeFile(candidateFile, serializeManifest(candidate));
        assert.equal(await main(['--diff', baselineFile, '--candidate', candidateFile], { stdout: sink, stderr: sink }), 1, `${side}: ${failure}`);
      }
    }
    for (const invalid of [{}, { ...valid, schemaVersion: 2 }, { ...valid, sections: {} },
      { ...valid, sections: { ...valid.sections, config: { status: 'captured' } } },
      { ...valid, sections: { ...valid.sections, slim: { status: 'captured', data: {} } } }]) {
      assert.throws(() => diffManifests(invalid, invalid), /parity/);
      await writeFile(baselineFile, serializeManifest(invalid));
      await writeFile(candidateFile, serializeManifest(invalid));
      assert.equal(await main(['--diff', baselineFile, '--candidate', candidateFile], { stdout: sink, stderr: sink }), 2);
    }
    // Invalid saved input must fail before a live capture overwrites its path.
    const before = await readFile(baselineFile, 'utf8');
    assert.equal(await main(['--diff', baselineFile, '--out', baselineFile, '--origin', ORIGIN, '--directory', DIRECTORY], {
      fetchImpl: async () => assert.fail('invalid baseline must be rejected before capture'), stdout: sink, stderr: sink,
    }), 2);
    assert.equal(await readFile(baselineFile, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI capture writes the manifest deterministically and validates arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parity-cli-'));
  try {
    const out = path.join(root, 'nested', 'manifest.json');
    const sink = { write: () => {} };
    const argv = ['--origin', ORIGIN, '--directory', DIRECTORY, '--out', out];
    const env = {};
    assert.equal(await main(argv, { fetchImpl: createFetch().fetchImpl, stdout: sink, stderr: sink, env, now: () => new Date(0) }), 0);
    const first = await readFile(out, 'utf8');
    assert.equal(await main(argv, { fetchImpl: createFetch().fetchImpl, stdout: sink, stderr: sink, env, now: () => new Date(0) }), 0);
    assert.equal(await readFile(out, 'utf8'), first, 'identical input yields byte-identical output');
    assert.equal(JSON.parse(first).sections.slim.data.package.status, 'skipped');
    const errors = [];
    assert.equal(await main(argv, { fetchImpl: createFetch(fixtureResponses(), { '/api/agent': 503 }).fetchImpl, stdout: sink, stderr: { write: chunk => errors.push(chunk) }, env }), 1);
    assert.match(errors.join(''), /agents capture failed: HTTP 503/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.throws(() => parseArgs(['--origin', ORIGIN]), /--origin and --directory are required/);
  assert.throws(() => parseArgs(['--origin', ORIGIN, '--directory', DIRECTORY]), /--out is required/);
  assert.throws(() => parseArgs(['--provider', 'x', '--origin', ORIGIN, '--directory', DIRECTORY, '--out', 'o']), /together/);
  assert.throws(() => parseArgs(['--bogus', '1']), /Unknown argument/);
  assert.throws(() => parseArgs(['--candidate', 'c.json']), /--candidate requires --diff/);
  assert.deepEqual(parseArgs(['--diff', 'b.json', '--candidate', 'c.json']), { candidate: 'c.json', diff: 'b.json' });
  const stderr = [];
  assert.equal(await main(['--nope'], { stdout: { write: () => {} }, stderr: { write: chunk => stderr.push(chunk) } }), 2);
});
