import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assertQaLaunchEnvironmentOwned, assertQaSelectedProviderAccess, assertQaSelectedProviderDuration, createQaLaunchEnvironment, pinQaAgents, qaMeridianClaudePaths, preserveQaOrchestration, prepareQaPluginHomeWrapper, prepareQaProfile, projectQaAuth, provisionQaRipgrep,
    buildQaMirroredMcp, classifyQaPersonalPluginEntries,  mirrorQaPersonalSetup, normalizeQaMirrorPersonalSetup, orderQaMirroredPlugins, selectQaPersonalPluginDirectoryEntries, wrapQaPackagePluginEntries } from './profile-preparation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('reusing a private QA dependency tree does not recursively replace plugin originals', async () => {
    const directory = await mkdtemp(path.join(root, '.cache/qa/wrapper-reuse-'));
    try {
        const entry = path.join(directory, 'index.mjs');
        const source = 'export default () => ({});\n';
        await writeFile(entry, source);
        await prepareQaPluginHomeWrapper(entry);
        const wrapped = await readFile(entry, 'utf8');
        await prepareQaPluginHomeWrapper(entry);
        assert.equal(await readFile(entry, 'utf8'), wrapped);
        assert.equal(await readFile(path.join(directory, 'index.qa-original.mjs'), 'utf8'), source);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private QA auth excludes other providers, refresh credentials, and expired access', () => {
    const source = { openai: { type: 'oauth', access: 'synthetic-access', refresh: 'must-stay-with-owner', expires: 500_000, accountId: 'synthetic-account' },
        xai: { type: 'oauth', access: 'expired', refresh: 'also-private', expires: 100_000 },
        anthropic: { type: 'api', key: 'synthetic-key' }, google: { type: 'api', key: 'excluded' } };
    const result = projectQaAuth(source, 200_000);
    assert.deepEqual(Object.keys(result.records).sort(), ['anthropic', 'openai']);
    assert.equal(result.records.openai.refresh, '');
    assert.equal(result.records.openai.access, 'synthetic-access');
    assert.equal(result.evidence.xai.state, 'unavailable');
    assert.equal(JSON.stringify(result).includes('must-stay-with-owner'), false);
    assert.equal(JSON.stringify(result.evidence).includes('synthetic-access'), false);
    assert.equal(source.openai.refresh, 'must-stay-with-owner');
});

test('selected-provider availability cannot silently fall back to private owner credentials', () => {
    assert.throws(() => assertQaSelectedProviderAccess('xai', { xai: { state: 'unavailable' } }), /access is unavailable/);
    assert.throws(() => assertQaSelectedProviderAccess('anthropic', { anthropic: { state: 'available', type: 'api' } }), /implicit Meridian credential fallback is disabled/);
    assert.doesNotThrow(() => assertQaSelectedProviderAccess('openai', { openai: { state: 'available', type: 'oauth-access-only' } }));
    assert.doesNotThrow(() => assertQaSelectedProviderAccess('anthropic', { anthropic: { state: 'available', type: 'claude-cli-access-only' } }));
});

test('explicit managed specialist assignments preserve each requested model and effort without widening primary adapters', () => {
    const agentAssignments = {
        oracle: { providerId: 'openai', modelId: 'gpt-6-astra', variant: 'high' },
        builder: { providerId: 'xai', modelId: 'grok-4.6', variant: 'high' },
        fixer: { providerId: 'xai', modelId: 'grok-4.6', variant: 'high' },
        designer: { providerId: 'anthropic', modelId: 'claude-opus-5', variant: 'medium' },
        explorer: { providerId: 'opencode', modelId: 'deepseek-v4-flash', variant: 'high' },
        librarian: { providerId: 'opencode', modelId: 'deepseek-v4-flash', variant: 'high' },
        council: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'medium' },
    };
    const source = { agents: { explorer: { skills: ['*'] } } };
    const request = { providerId: 'openai', modelId: 'gpt-6-astra', variant: 'medium', agentAssignments };
    assert.throws(() => pinQaAgents(source, request), /specialist assignments/);
    const result = pinQaAgents(source, { ...request, allowCrossProviderAssignments: true });
    assert.equal(result.agents.orchestrator.model, 'openai/gpt-6-astra');
    for (const [role, selection] of Object.entries(agentAssignments)) {
        assert.equal(result.agents[role].model, `${selection.providerId}/${selection.modelId}`);
        assert.equal(result.agents[role].variant, selection.variant);
    }
    assert.deepEqual(source, { agents: { explorer: { skills: ['*'] } } });
    assert.throws(() => pinQaAgents(source, { ...request, allowCrossProviderAssignments: true,
        agentAssignments: { explorer: { ...agentAssignments.explorer, providerId: 'unknown' } } }), /specialist assignments/);
    const auth = { opencode: { type: 'api', key: 'synthetic-key' }, google: { type: 'api', key: 'excluded' } };
    assert.equal(Object.hasOwn(projectQaAuth(auth).records, 'opencode'), false);
    const projected = projectQaAuth(auth, 1_000_000, ['openai', 'opencode']);
    assert.deepEqual(Object.keys(projected.records), ['opencode']);
    assert.equal(JSON.stringify(projected.evidence).includes('synthetic-key'), false);
    assert.throws(() => projectQaAuth(auth, 1_000_000, ['google']), /supported providers/);
});

test('copied access must cover the full cell timeout and ten-minute margin at admission', () => {
    const now = 1_000_000;
    const timeoutMs = 420_000;
    const expires = now + timeoutMs + 600_000;
    const credentials = projectQaAuth({ openai: { type: 'oauth', access: 'synthetic-access', expires } }, now).evidence;
    assert.deepEqual(assertQaSelectedProviderDuration('openai', credentials, timeoutMs, now), {
        providerId: 'openai', checkedAt: now, expires, timeoutMs, marginMs: 600_000,
        requiredUntil: expires, remainingMs: timeoutMs + 600_000, expiryCheck: 'passed',
    });
    assert.throws(() => assertQaSelectedProviderDuration('openai', credentials, timeoutMs, now + 1), /does not cover/,
        'Time spent preparing the profile cannot be admitted from an earlier timestamp');
});

test('expired, insufficient, unknown and non-finite copied expiries fail closed', () => {
    const now = 1_000_000;
    const timeoutMs = 420_000;
    for (const expires of [now - 1, now, now + timeoutMs, now + timeoutMs + 599_999, undefined, null, NaN, Infinity, '9999999999']) {
        assert.throws(() => assertQaSelectedProviderDuration('xai', {
            xai: { state: 'available', type: 'oauth-access-only', expires },
        }, timeoutMs, now), /does not cover/);
    }
});

test('supported API-key access is preserved without claiming an expiry guarantee', () => {
    for (const providerId of ['openai', 'xai']) {
        const credentials = projectQaAuth({ [providerId]: { type: 'api', key: 'synthetic-key' } }, 1_000_000).evidence;
        const result = assertQaSelectedProviderDuration(providerId, credentials, 420_000, 1_000_000);
        assert.deepEqual(result, {
            providerId, checkedAt: 1_000_000, timeoutMs: 420_000, marginMs: 600_000,
            expiryCheck: 'not-applicable-to-api-key',
        });
        assert.equal(Object.hasOwn(result, 'expires'), false);
        assert.equal(Object.hasOwn(result, 'requiredUntil'), false);
        assert.equal(Object.hasOwn(result, 'remainingMs'), false);
    }
});

test('duration admission considers only the selected provider and retains its access policy', () => {
    const now = 1_000_000;
    const timeoutMs = 2_400_000;
    const expires = now + timeoutMs + 600_000;
    const credentials = {
        xai: { state: 'available', type: 'oauth-access-only', expires },
        openai: { state: 'unavailable', expires: now - 1 },
        anthropic: { state: 'unavailable' },
    };
    assert.doesNotThrow(() => assertQaSelectedProviderDuration('xai', credentials, timeoutMs, now));
    assert.throws(() => assertQaSelectedProviderDuration('openai', credentials, timeoutMs, now), /access is unavailable/);
    assert.throws(() => assertQaSelectedProviderDuration('anthropic', {
        anthropic: { state: 'available', type: 'api', expires },
    }, timeoutMs, now), /implicit Meridian credential fallback is disabled/);
    assert.doesNotThrow(() => assertQaSelectedProviderDuration('anthropic', {
        anthropic: { state: 'available', type: 'claude-cli-access-only', expires },
        xai: { state: 'unavailable' },
    }, timeoutMs, now));
});

test('invalid duration or clock input cannot bypass credential admission', () => {
    const credentials = { openai: { state: 'available', type: 'oauth-access-only', expires: 9_000_000 } };
    for (const timeoutMs of [0, -1, 0.5, NaN, Infinity]) {
        assert.throws(() => assertQaSelectedProviderDuration('openai', credentials, timeoutMs, 1_000_000), /positive timeout/);
    }
    for (const now of [-1, NaN, Infinity]) {
        assert.throws(() => assertQaSelectedProviderDuration('openai', credentials, 420_000, now), /valid current timestamp/);
    }
});

test('test agent pinning keeps instructions while capturing default versus explicit effort', () => {
    const source = { preset: 'old', presets: { old: { fixer: { model: 'excluded/model' } } }, agents: {
        builder: { model: 'openai/old', variant: 'high', skills: ['*'] },
        council: { modelRefs: ['excluded/model'], councillors: ['excluded/model'] },
    } };
    const pinned = pinQaAgents(source, { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: null });
    for (const agent of Object.values(pinned.agents)) {
        assert.equal(agent.model, 'anthropic/claude-sonnet-4-6');
        assert.equal(Object.hasOwn(agent, 'variant'), false);
        assert.equal(Object.hasOwn(agent, 'modelRefs'), false);
    }
    assert.deepEqual(pinned.agents.builder.skills, ['*']);
    assert.equal(source.agents.builder.variant, 'high');
    assert.equal(pinQaAgents(source, { providerId: 'xai', modelId: 'grok-4.6', variant: 'xhigh' }).agents.builder.variant, 'xhigh');
});

test('isolated specialist assignments preserve parent selection and remove stale effort without changing the source', () => {
    const source = { agents: { explorer: { model: 'opencode/old', variant: 'medium', skills: ['read-only'], prompt: 'inspect' } } };
    const selection = { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high', agentAssignments: {
        explorer: { providerId: 'openai', modelId: 'gpt-5.3-codex-spark', variant: null },
    } };
    const pinned = pinQaAgents(source, selection);
    assert.equal(pinned.agents.explorer.model, 'openai/gpt-5.3-codex-spark');
    assert.equal(Object.hasOwn(pinned.agents.explorer, 'variant'), false);
    assert.deepEqual(pinned.agents.explorer.skills, ['read-only']);
    assert.equal(pinned.agents.explorer.prompt, 'inspect');
    assert.equal(pinned.agents.orchestrator.model, 'openai/gpt-5.6-sol');
    assert.equal(pinned.agents.orchestrator.variant, 'high');
    assert.equal(pinned.presets.qa.explorer, pinned.agents.explorer);
    assert.equal(source.agents.explorer.model, 'opencode/old');
    assert.equal(source.agents.explorer.variant, 'medium');
    const explicit = pinQaAgents(source, { ...selection, agentAssignments: {
        explorer: { ...selection.agentAssignments.explorer, variant: 'low' },
    } });
    assert.equal(explicit.agents.explorer.variant, 'low');
});

test('explicit specialist assignments reject disabled roles instead of reporting ineffective pins', () => {
    const source = { disabled_agents: ['explorer', 'librarian'] };
    const selection = { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high' };
    assert.throws(() => pinQaAgents(source, { ...selection, agentAssignments: {
        explorer: { providerId: 'openai', modelId: 'gpt-5.3-codex-spark', variant: 'high' },
    } }), /cannot pin a disabled agent/);
    assert.deepEqual(pinQaAgents(source, { ...selection, agentAssignments: {
        oracle: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: null },
    } }).disabled_agents, ['explorer', 'librarian']);
    assert.deepEqual(source.disabled_agents, ['explorer', 'librarian']);
});

test('home shim affects only its child and leaves HOME unchanged', async () => {
    const cache = path.join(root, '.cache/qa');
    await mkdir(cache, { recursive: true });
    const home = await mkdtemp(path.join(cache, 'home-shim-test-'));
    const originalHome = process.env.HOME;
    try {
        await writeFile(path.join(home, '.devryan-qa-home'), 'owned test\n');
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
            `await import(${JSON.stringify(new URL('./isolated-home.mjs', import.meta.url).href)}); const os = await import('node:os'); console.log(JSON.stringify({home:os.homedir(),environment:process.env.HOME}));`],
        { env: { ...process.env, DEVRYAN_QA_HOME: home } });
        assert.deepEqual(JSON.parse(stdout), { home, environment: originalHome });
        const scratch = path.join(home, 'execution-scratch');
        await mkdir(scratch);
        const worker = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
            `await import(${JSON.stringify(new URL('./isolated-home.mjs', import.meta.url).href)}); const os = await import('node:os'); console.log(JSON.stringify({home:os.homedir(),environment:process.env.HOME}));`],
        { env: { ...process.env, HOME: scratch, DEVRYAN_QA_HOME: home, DEVRYAN_EXECUTION_WORKER: '1' } });
        assert.deepEqual(JSON.parse(worker.stdout), { home: scratch, environment: scratch });
        assert.equal(process.env.HOME, originalHome);
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('private home preload preserves descriptor and named server exports', async () => {
    const cache = path.join(root, '.cache/qa');
    await mkdir(cache, { recursive: true });
    const home = await mkdtemp(path.join(cache, 'plugin-home-test-'));
    try {
        await writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
        const entry = path.join(home, 'plugin.mjs');
        await writeFile(entry, `
            import os from 'node:os';
            export const server = () => os.homedir();
            const descriptor = { id: 'synthetic-descriptor', server };
            export { descriptor as default };
        `);
        await prepareQaPluginHomeWrapper(entry);
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
            `const plugin = await import(${JSON.stringify(entry)}); console.log(JSON.stringify({id:plugin.default.id,home:plugin.default.server(),sameFactory:plugin.default.server===plugin.server}));`],
        { env: { ...process.env, DEVRYAN_QA_HOME: home } });
        assert.deepEqual(JSON.parse(stdout), { id: 'synthetic-descriptor', home, sameFactory: true });
    } finally { await rm(home, { recursive: true, force: true }); }
});


test('preserved orchestration retains presets, efforts, model refs and backups without sharing mutable source records', () => {
    const slim = { preset: 'personal', presets: { personal: {
        explorer: { model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    } }, agents: { oracle: { model: 'cursor-acp/muse-spark-1.3', variant: 'high' },
        council: { modelRefs: ['openai/gpt-5.6-sol'], councillors: ['designer'] } }, fallback: { enabled: true } };
    const sidecar = { agentOverrides: { designer: { variant: 'high' } },
        agentBackupModels: { explorer: { model: 'opencode/deepseek-v4.1-flash', variant: null } }, unrelated: 'excluded' };
    const copy = preserveQaOrchestration(slim, sidecar);
    assert.deepEqual(copy.slim, slim);
    assert.deepEqual(copy.sidecar.agentBackupModels, sidecar.agentBackupModels);
    assert.equal(Object.hasOwn(copy.sidecar, 'unrelated'), false);
    copy.slim.agents.oracle.variant = 'low';
    copy.sidecar.agentBackupModels.explorer.model = 'changed';
    assert.equal(slim.agents.oracle.variant, 'high');
    assert.equal(sidecar.agentBackupModels.explorer.model, 'opencode/deepseek-v4.1-flash');
    const auth = { 'opencode-go': { type: 'api', key: 'synthetic-key' } };
    assert.throws(() => projectQaAuth(auth, 0, ['opencode-go']), /supported providers/);
    assert.equal(projectQaAuth(auth, 0, ['opencode-go'], { preserveOrchestration: true }).evidence['opencode-go'].state, 'available');
});

test('private profiles reuse the installed ripgrep so read/grep/skill tools work without a download', async () => {
    const scratch = await mkdtemp(path.join(root, '.cache/qa-ripgrep-'));
    try {
        const sourceHome = path.join(scratch, 'source-home');
        const cacheHome = path.join(scratch, 'private-home/.cache');
        assert.deepEqual(await provisionQaRipgrep({ sourceHome, cacheHome }), { state: 'not-installed' });
        await mkdir(path.join(sourceHome, '.cache/opencode/bin'), { recursive: true });
        await writeFile(path.join(sourceHome, '.cache/opencode/bin/rg'), '#!/bin/sh\necho ripgrep\n', { mode: 0o755 });
        const copied = await provisionQaRipgrep({ sourceHome, cacheHome });
        assert.equal(copied.state, 'copied');
        assert.match(copied.sha256, /^[a-f0-9]{64}$/);
        const { stdout } = await promisify(execFile)(path.join(cacheHome, 'opencode/bin/rg'));
        assert.equal(stdout.trim(), 'ripgrep');
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

// Mirrors what isolated-host.mjs applies from credentials.env.json.
const qaCredentialsEnvironment = { MERIDIAN_PROFILES: JSON.stringify([{ id: 'qa', type: 'oauth-token', oauthToken: 'synthetic-access' }]), MERIDIAN_DEFAULT_PROFILE: 'qa' };
const hostileBaseEnvironment = (realHome) => ({ PATH: process.env.PATH, HOME: realHome, USER: 'synthetic-user',
    CLAUDE_CONFIG_DIR: path.join(realHome, '.claude'), MERIDIAN_CONFIG_DIR: path.join(realHome, '.config/meridian'),
    MERIDIAN_SESSION_DIR: path.join(realHome, '.cache/meridian'), MERIDIAN_PLUGIN_DIR: path.join(realHome, '.config/meridian/plugins'),
    MERIDIAN_DESIGN_TOKEN_PATH: path.join(realHome, '.config/meridian/design-token.json'), CLAUDE_PROXY_SESSION_DIR: path.join(realHome, '.cache/meridian'),
    MERIDIAN_TELEMETRY_DB: path.join(realHome, '.config/meridian/telemetry.db'), MERIDIAN_DEBUG: '1',
    MERIDIAN_PROFILES: '[{"id":"qa","type":"claude-max"}]', MERIDIAN_DEFAULT_PROFILE: 'qa', CLAUDE_CODE_OAUTH_TOKEN: 'owner-token' });

test('prepared launch env resolves every Meridian/Claude config path under the owned QA home', () => {
    const runtimeRoot = path.join(root, '.cache/qa/synthetic-launch-env/runtime');
    const home = path.join(runtimeRoot, 'home');
    const realHome = path.join(root, '.cache/qa/synthetic-launch-env/real-home');
    const base = hostileBaseEnvironment(realHome);
    const prepared = createQaLaunchEnvironment({ runtimeRoot, home, opencodeBinary: '/synthetic/opencode', baseEnvironment: base });
    const launch = { ...prepared, ...qaCredentialsEnvironment };
    assert.equal(launch.HOME, home);
    assert.equal(launch.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
    assert.equal(launch.MERIDIAN_CONFIG_DIR, path.join(home, '.config/meridian'));
    assert.equal(launch.MERIDIAN_SESSION_DIR, path.join(home, '.cache/meridian'));
    for (const key of ['MERIDIAN_PLUGIN_DIR', 'MERIDIAN_DESIGN_TOKEN_PATH', 'CLAUDE_PROXY_SESSION_DIR', 'MERIDIAN_TELEMETRY_DB', 'CLAUDE_CODE_OAUTH_TOKEN']) {
        assert.equal(Object.hasOwn(launch, key), false, key);
    }
    assert.equal(launch.MERIDIAN_DEBUG, undefined);
    const paths = qaMeridianClaudePaths(launch);
    assert.equal(paths['homedir:meridian-profile'], path.join(home, '.config/meridian/profiles/qa'));
    for (const [name, value] of Object.entries(paths)) {
        assert.ok(value === home || value.startsWith(`${home}${path.sep}`), `${name} escaped the owned home: ${value}`);
    }
    // Any absolute Meridian/Claude value in the launch env, not only known keys.
    for (const [key, value] of Object.entries(launch)) {
        if (/MERIDIAN|CLAUDE/.test(key) && path.isAbsolute(value)) assert.ok(value.startsWith(`${home}${path.sep}`), `${key} escaped the owned home`);
    }
    assert.doesNotThrow(() => assertQaLaunchEnvironmentOwned(launch, home));
    // The 2026-09-24 leak: an inherited HOME made Meridian's oauth-token profile
    // CLAUDE_CONFIG_DIR resolve to the owner's ~/.config/meridian/profiles/qa.
    assert.throws(() => assertQaLaunchEnvironmentOwned({ ...launch, HOME: realHome }, home), /homedir:meridian-profile|HOME/);
    assert.throws(() => assertQaLaunchEnvironmentOwned({ ...launch, MERIDIAN_PLUGIN_DIR: path.join(realHome, 'plugins') }, home), /MERIDIAN_PLUGIN_DIR/);
    assert.equal(base.HOME, realHome);
});

test('Meridian profile paths stay owned inside the Bun host where the home shim cannot rebind named imports', async () => {
    const scratch = await mkdtemp(path.join(root, '.cache/qa/meridian-bun-home-'));
    try {
        const runtimeRoot = path.join(scratch, 'runtime');
        const home = path.join(runtimeRoot, 'home');
        await mkdir(home, { recursive: true });
        await writeFile(path.join(home, '.devryan-qa-home'), 'owned test\n');
        // Same derivations as Meridian 1.62.x (named homedir import) and the
        // later MERIDIAN_CONFIG_DIR resolver, loaded after the QA home shim as
        // the plugin wrappers do inside the compiled OpenCode (Bun) host.
        const meridian = path.join(scratch, 'meridian-paths.mjs');
        await writeFile(meridian, `import { homedir } from 'node:os';\nimport { join } from 'node:path';\n`
            + `export const paths = (id) => ({ legacyProfile: join(homedir(), '.config', 'meridian', 'profiles', id),\n`
            + `  configDir: process.env.MERIDIAN_CONFIG_DIR ?? join(homedir(), '.config', 'meridian'), claudeDefault: join(homedir(), '.claude') });\n`);
        const entry = path.join(scratch, 'entry.mjs');
        await writeFile(entry, `import ${JSON.stringify(fileURLToPath(new URL('./isolated-home.mjs', import.meta.url)))};\n`
            + `const { paths } = await import(${JSON.stringify(meridian)});\nconsole.log(JSON.stringify(paths(process.env.MERIDIAN_DEFAULT_PROFILE)));\n`);
        const launch = { ...createQaLaunchEnvironment({ runtimeRoot, home, opencodeBinary: '/synthetic/opencode',
            baseEnvironment: hostileBaseEnvironment(path.join(scratch, 'real-home')) }), ...qaCredentialsEnvironment };
        const bun = process.versions.bun ? process.execPath : 'bun';
        const { stdout } = await promisify(execFile)(bun, [entry], { env: launch });
        assert.deepEqual(JSON.parse(stdout), { legacyProfile: path.join(home, '.config/meridian/profiles/qa'),
            configDir: path.join(home, '.config/meridian'), claudeDefault: path.join(home, '.claude') });
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('personal setup mirroring normalizes explicit options and requires preserved orchestration', () => {
    const preserved = { preserveOrchestration: true };
    assert.equal(normalizeQaMirrorPersonalSetup(false, preserved), false);
    assert.equal(normalizeQaMirrorPersonalSetup(false), false);
    assert.deepEqual(normalizeQaMirrorPersonalSetup(true, preserved), { plugins: true, skills: true, mcp: 'definitions' });
    assert.deepEqual(normalizeQaMirrorPersonalSetup({ skills: true }, preserved), { plugins: false, skills: true, mcp: 'off' });
    assert.deepEqual(normalizeQaMirrorPersonalSetup({ plugins: true, skills: false, mcp: 'live' }, preserved), { plugins: true, skills: false, mcp: 'live' });
    for (const value of [undefined, null, 'true', 1, [], { plugins: 'yes' }, { skills: 1 }, { mcp: 'on' }, { mcp: true }, { lsp: true }]) {
        assert.throws(() => normalizeQaMirrorPersonalSetup(value, preserved), /must be a boolean or/, JSON.stringify(value));
    }
    for (const preserveOrchestration of [false, undefined, 'true']) {
        assert.throws(() => normalizeQaMirrorPersonalSetup(true, { preserveOrchestration }), /requires preserved orchestration/);
        assert.throws(() => normalizeQaMirrorPersonalSetup({ mcp: 'off' }, { preserveOrchestration }), /requires preserved orchestration/);
    }
});

test('personal plugin classification keeps only entries provisioning does not own', () => {
    const sourceConfig = '/synthetic-home/.config/opencode';
    const provisioned = ['./plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js', './plugins/devryan-oh-my-opencode-slim.mjs'];
    const { personal, managed } = classifyQaPersonalPluginEntries([
        './node_modules/@synthetic/ponytail/.opencode/plugins/ponytail.mjs',
        './plugins/devryan-open-cursor.mjs', 'opencode-with-claude', 'oh-my-opencode-slim@2.2.25',
        `file://${sourceConfig}/plugins/devryan-skill-context.mjs`,
        'opencode-antigravity-auth@1.6.0', 'cursor-acp',
        `${sourceConfig}/plugins/personal.mjs`, './plugins/personal.mjs',
        ['@synthetic/tuple', { apiKey: 'synthetic-option' }], 'synthetic-package@1.0.0',
        ' ./node_modules/@synthetic/ponytail/.opencode/plugins/ponytail.mjs ',
    ], { provisioned, sourceConfig });
    assert.deepEqual(personal.map(({ spec, kind, hasOptions }) => ({ spec, kind, hasOptions })), [
        { spec: './node_modules/@synthetic/ponytail/.opencode/plugins/ponytail.mjs', kind: 'node-modules', hasOptions: false },
        { spec: './plugins/personal.mjs', kind: 'config-path', hasOptions: false },
        { spec: '@synthetic/tuple', kind: 'package', hasOptions: true },
        { spec: 'synthetic-package@1.0.0', kind: 'package', hasOptions: false },
    ]);
    assert.deepEqual(personal[2].entry, ['@synthetic/tuple', { apiKey: 'synthetic-option' }]);
    assert.deepEqual(managed, ['./plugins/devryan-open-cursor.mjs', 'opencode-with-claude', 'oh-my-opencode-slim@2.2.25',
        './plugins/devryan-skill-context.mjs', 'opencode-antigravity-auth@1.6.0', 'cursor-acp']);
    assert.deepEqual(classifyQaPersonalPluginEntries(provisioned, { provisioned, sourceConfig }).personal, []);
    // A registration outside the owner's configuration cannot be isolated.
    for (const outside of ['/elsewhere/plugin.mjs', 'file:///elsewhere/plugin.mjs']) {
        assert.throws(() => classifyQaPersonalPluginEntries([outside], { provisioned, sourceConfig }), /outside the owner's OpenCode configuration/);
    }
    for (const entry of [42, null, '', [], [7], ['a', {}, 'extra']]) {
        assert.throws(() => classifyQaPersonalPluginEntries([entry], { provisioned, sourceConfig }), /specs or \[spec, options\] tuples/);
    }
    assert.throws(() => classifyQaPersonalPluginEntries('ponytail', { provisioned, sourceConfig }), /must be arrays/);
});

test('mirrored plugin order follows the owner\'s registration order', () => {
    const provisioned = ['./plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js', './plugins/devryan-oh-my-opencode-slim.mjs'];
    const sourceConfig = '/synthetic-home/.config/opencode';
    const { ordered } = classifyQaPersonalPluginEntries(['./node_modules/@synthetic/ponytail/index.mjs', 'oh-my-opencode-slim@2.2.25',
        './plugins/devryan-open-cursor.mjs', './plugins/personal.mjs', './plugins/devryan-open-cursor.mjs'], { provisioned, sourceConfig });
    assert.deepEqual(orderQaMirroredPlugins(provisioned, ordered), ['./node_modules/@synthetic/ponytail/index.mjs',
        './plugins/devryan-oh-my-opencode-slim.mjs', './plugins/devryan-open-cursor.mjs', './plugins/personal.mjs',
        './node_modules/opencode-with-claude/dist/index.js']);
    assert.deepEqual(orderQaMirroredPlugins(provisioned, []), provisioned);
});

test('personal plugin directory selection skips managed, retired, backup and Finder files', () => {
    assert.deepEqual(selectQaPersonalPluginDirectoryEntries(['.DS_Store', 'ECC', 'devryan-open-cursor.mjs', 'devryan-skill-context.mjs',
        'devryan-oh-my-opencode-slim.mjs.devryan-slim-backup-20260628T031536466Z', 'openai-tool-schema-sanitizer.mjs', 'cursor-acp.js',
        'personal.mjs', 'devryan-personal-experiment.mjs']), ['ECC', 'personal.mjs', 'devryan-personal-experiment.mjs']);
});

test('mirrored MCP definitions are inert by default and evidence carries no endpoints or auth', () => {
    const source = { remote: { type: 'remote', url: 'https://mcp.invalid/synthetic', enabled: true, oauth: { clientId: 'synthetic-client' } },
        local: { type: 'local', command: ['synthetic-mcp'], enabled: false }, implicit: { type: 'remote', url: 'https://implicit.invalid' } };
    const snapshot = structuredClone(source);
    assert.deepEqual(buildQaMirroredMcp(source, 'off'), { config: {}, evidence: [] });
    const definitions = buildQaMirroredMcp(source, 'definitions');
    assert.deepEqual(Object.values(definitions.config).map(entry => entry.enabled), [false, false, false]);
    assert.deepEqual(definitions.config.remote.oauth, { clientId: 'synthetic-client' });
    assert.deepEqual(definitions.evidence, [
        { id: 'remote', type: 'remote', sourceEnabled: true, enabled: false },
        { id: 'local', type: 'local', sourceEnabled: false, enabled: false },
        { id: 'implicit', type: 'remote', sourceEnabled: true, enabled: false },
    ]);
    assert.equal(/synthetic-client|mcp\.invalid|synthetic-mcp/.test(JSON.stringify(definitions.evidence)), false);
    const live = buildQaMirroredMcp(source, 'live');
    assert.deepEqual(live.config, source);
    assert.notEqual(live.config.remote, source.remote);
    assert.deepEqual(live.evidence.map(entry => entry.enabled), [true, false, true]);
    definitions.config.remote.oauth.clientId = 'changed';
    assert.deepEqual(source, snapshot);
    assert.deepEqual(buildQaMirroredMcp(undefined, 'definitions'), { config: {}, evidence: [] });
    assert.throws(() => buildQaMirroredMcp(source, 'on'), /mode must be/);
    assert.throws(() => buildQaMirroredMcp([], 'live'), /must be an object/);
    assert.throws(() => buildQaMirroredMcp({ broken: 'remote' }, 'live'), /definitions must be objects/);
});

test('personal setup mirroring copies personal plugins, skills, MCP definitions, agents and commands without touching the source', async () => {
    await mkdir(path.join(root, '.cache/qa'), { recursive: true });
    const scratch = await mkdtemp(path.join(root, '.cache/qa/mirror-personal-'));
    try {
        const sourceHome = path.join(scratch, 'source-home');
        const sourceConfig = path.join(sourceHome, '.config/opencode');
        const home = path.join(scratch, 'private-home');
        const config = path.join(home, '.config/opencode');
        const write = async (file, content = 'export default () => ({});\n') => {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, content);
        };
        const ponytail = './node_modules/@synthetic/ponytail/.opencode/plugins/ponytail.mjs';
        const sourceOpencode = { plugin: [ponytail, './plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js',
            'opencode-antigravity-auth@1.6.0', pathToFileURL(path.join(sourceConfig, 'plugins/personal.mjs')).href,
            ['@synthetic/tuple', { apiKey: 'synthetic-option' }]],
        mcp: { remote: { type: 'remote', url: 'https://mcp.invalid/synthetic', enabled: true, oauth: { clientId: 'synthetic-client' } },
            local: { type: 'local', command: ['synthetic-mcp'], enabled: false } },
        agent: { explore: { model: 'personal/explore' }, build: { model: 'openai/synthetic' } }, lsp: { synthetic: { command: ['lsp'] } } };
        const sourceLegacy = { plugin: ['./plugins/personal.mjs'], agent: { plan: { model: 'openai/plan' } } };
        await write(path.join(sourceConfig, 'opencode.json'), JSON.stringify(sourceOpencode));
        await write(path.join(sourceConfig, 'config.json'), JSON.stringify(sourceLegacy));
        await write(path.join(sourceConfig, 'plugins/devryan-open-cursor.mjs'), 'owner copy\n');
        await write(path.join(sourceConfig, 'plugins/devryan-oh-my-opencode-slim.mjs.devryan-slim-backup-20260628T031536466Z'), 'backup\n');
        await write(path.join(sourceConfig, 'plugins/.DS_Store'), 'finder\n');
        await write(path.join(sourceConfig, 'plugins/cursor-acp.js'), 'retired\n');
        await write(path.join(sourceConfig, 'plugins/personal.mjs'));
        await write(path.join(sourceConfig, 'plugins/ECC/index.ts'), 'export {};\n');
        await write(path.join(sourceConfig, 'plugins/ECC/.DS_Store'), 'finder\n');
        await write(path.join(sourceConfig, 'plugins/ECC/lib/hooks.ts'), 'export {};\n');
        await write(path.join(sourceConfig, 'plugin/openai-tool-schema-sanitizer.mjs'), 'managed\n');
        await write(path.join(sourceConfig, 'plugin/extra.mjs'));
        await write(path.join(sourceConfig, 'skills/personal/SKILL.md'), '# personal\n');
        await write(path.join(sourceConfig, 'skills/.DS_Store'), 'finder\n');
        await mkdir(path.join(sourceConfig, 'commands'), { recursive: true });
        await write(path.join(sourceHome, '.claude/skills/synced/SKILL.md'), '# synced\n');
        await symlink('synced', path.join(sourceHome, '.claude/skills/alias'));
        await write(path.join(config, 'plugins/devryan-open-cursor.mjs'), 'provisioned\n');
        await write(path.join(config, ponytail));
        const provisioned = { plugin: ['./plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js'],
            agent: { explore: { disable: true }, general: { disable: true } }, lsp: true };
        const sourceConfigs = [sourceOpencode, sourceLegacy, {}];
        const sourceBefore = await readFile(path.join(sourceConfig, 'opencode.json'), 'utf8');

        const options = normalizeQaMirrorPersonalSetup(true, { preserveOrchestration: true });
        const result = await mirrorQaPersonalSetup({ options, sourceHome, home, config, sourceConfigs, provisioned });

        // Source order is kept: ponytail loads first, as in the owner's profile; provisioned
        // entries the owner never listed come last.
        assert.deepEqual(result.plugin, [ponytail, './plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js',
            './plugins/personal.mjs', ['@synthetic/tuple', { apiKey: 'synthetic-option' }]]);
        assert.deepEqual(result.evidence.pluginOrder, [ponytail, './plugins/devryan-open-cursor.mjs', './node_modules/opencode-with-claude/dist/index.js',
            './plugins/personal.mjs', '@synthetic/tuple']);
        assert.deepEqual(result.evidence.plugins, [
            { entry: ponytail, kind: 'node-modules', hasOptions: false },
            { entry: './plugins/personal.mjs', kind: 'config-path', hasOptions: false },
            { entry: '@synthetic/tuple', kind: 'package', hasOptions: true },
        ]);
        assert.deepEqual(result.evidence.pluginDirectories, [
            { directory: 'plugins', name: 'ECC', type: 'directory' },
            { directory: 'plugins', name: 'personal.mjs', type: 'file' },
            { directory: 'plugin', name: 'extra.mjs', type: 'file' },
        ]);
        assert.equal(await readFile(path.join(config, 'plugins/devryan-open-cursor.mjs'), 'utf8'), 'provisioned\n');
        await access(path.join(config, 'plugins/ECC/lib/hooks.ts'));
        for (const absent of ['plugins/ECC/.DS_Store', 'plugins/.DS_Store', 'plugins/cursor-acp.js',
            'plugins/devryan-oh-my-opencode-slim.mjs.devryan-slim-backup-20260628T031536466Z', 'plugin/openai-tool-schema-sanitizer.mjs', 'skills/.DS_Store']) {
            await assert.rejects(access(path.join(config, absent)), { code: 'ENOENT' }, absent);
        }
        assert.deepEqual(result.evidence.skills, { '.config/opencode/skills': 1, '.claude/skills': 2, '.agents/skills': null });
        assert.equal(await readFile(path.join(config, 'skills/personal/SKILL.md'), 'utf8'), '# personal\n');
        assert.equal(await readlink(path.join(home, '.claude/skills/alias')), 'synced');
        assert.deepEqual(result.mcp, {
            remote: { type: 'remote', url: 'https://mcp.invalid/synthetic', enabled: false, oauth: { clientId: 'synthetic-client' } },
            local: { type: 'local', command: ['synthetic-mcp'], enabled: false } });
        assert.deepEqual(result.evidence.mcp, [
            { id: 'remote', type: 'remote', sourceEnabled: true, enabled: false },
            { id: 'local', type: 'local', sourceEnabled: false, enabled: false }]);
        assert.deepEqual(result.agent, { explore: { disable: true }, general: { disable: true },
            build: { model: 'openai/synthetic' }, plan: { model: 'openai/plan' } });
        assert.equal(result.evidence.commands, 0);
        assert.deepEqual(result.evidence.configKeys, ['plugin', 'mcp', 'agent', 'commands']);
        assert.equal(Object.hasOwn(result, 'lsp'), false);
        assert.deepEqual(result.evidence.requested, { plugins: true, skills: true, mcp: 'definitions' });
        assert.equal(/synthetic-option|synthetic-client|mcp\.invalid/.test(JSON.stringify(result.evidence)), false);
        assert.equal(await readFile(path.join(sourceConfig, 'opencode.json'), 'utf8'), sourceBefore);
        await access(path.join(sourceConfig, 'plugins/.DS_Store'));

        // Mirrored package entries are wrapped exactly like provisioned ones.
        await write(path.join(config, 'node_modules/opencode-with-claude/dist/index.js'));
        await write(path.join(config, ponytail));
        await wrapQaPackagePluginEntries(config, result.plugin);
        assert.equal(await readFile(path.join(config, ponytail.replace(/\.mjs$/, '.qa-original.mjs')), 'utf8'), 'export default () => ({});\n');
        assert.match(await readFile(path.join(config, ponytail), 'utf8'), /isolated-home\.mjs/);
        await write(path.join(scratch, 'outside.mjs'));
        await mkdir(path.join(config, 'node_modules/escape'), { recursive: true });
        await symlink(path.join(scratch, 'outside.mjs'), path.join(config, 'node_modules/escape/index.mjs'));
        await assert.rejects(wrapQaPackagePluginEntries(config, ['./node_modules/escape/index.mjs']), /escaped the copied installation/);
        await mkdir(path.join(config, 'node_modules/opencode-gpt-imagegen'), { recursive: true });
        await assert.rejects(wrapQaPackagePluginEntries(config, ['./node_modules/opencode-gpt-imagegen/../../plugins/personal.mjs']), /escaped the copied installation/);

        // Partial options mirror only the named parts; config and commands follow any request.
        const partialHome = path.join(scratch, 'partial-home');
        const partialConfig = path.join(partialHome, '.config/opencode');
        const partial = await mirrorQaPersonalSetup({ options: normalizeQaMirrorPersonalSetup({ mcp: 'off' }, { preserveOrchestration: true }),
            sourceHome, home: partialHome, config: partialConfig, sourceConfigs, provisioned });
        assert.deepEqual(partial.plugin, provisioned.plugin);
        assert.deepEqual(partial.mcp, {});
        assert.deepEqual(partial.evidence.skills, {});
        assert.deepEqual(partial.evidence.configKeys, ['agent', 'commands']);
        await assert.rejects(access(path.join(partialConfig, 'plugins/ECC')), { code: 'ENOENT' });
        await assert.rejects(access(path.join(partialHome, '.claude/skills')), { code: 'ENOENT' });

        // A local registration outside the copied plugin directories fails closed.
        await assert.rejects(mirrorQaPersonalSetup({ options, sourceHome, home: path.join(scratch, 'loose-home'),
            config: path.join(scratch, 'loose-home/.config/opencode'), sourceConfigs: [{ plugin: ['./loose.mjs'] }], provisioned }),
        /outside the copied plugin directories/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('mirroring refuses escaping and unresolved links in plugins, skill resources and commands before publishing registrations', async () => {
    await mkdir(path.join(root, '.cache/qa'), { recursive: true });
    const scratch = await mkdtemp(path.join(root, '.cache/qa/mirror-links-'));
    try {
        const outside = path.join(scratch, 'owner-resource');
        await mkdir(outside);
        await writeFile(path.join(outside, 'index.mjs'), 'owner bytes\n');
        const cases = [
            { name: 'plugin-file', entry: '.config/opencode/plugins/entry.mjs', target: path.join(outside, 'index.mjs') },
            { name: 'plugin-directory', entry: '.config/opencode/plugins/personal', target: outside },
            { name: 'plugin-descendant', entry: '.config/opencode/plugins/personal/lib/resource', target: outside },
            { name: 'skill-resource', entry: '.claude/skills/personal/scripts/resource', target: outside },
            { name: 'agent-skill-resource', entry: '.agents/skills/personal/scripts/resource', target: path.join(outside, 'index.mjs') },
            { name: 'command-resource', entry: '.config/opencode/commands/resources/resource', target: outside },
            { name: 'broken', entry: '.config/opencode/skills/personal/broken', target: './missing' },
            { name: 'ancestor', entry: '.config/opencode/plugins/ancestor', target: '../../../../../owner-resource' },
        ];
        for (const scenario of cases) {
            const sourceHome = path.join(scratch, scenario.name, 'source');
            const home = path.join(scratch, scenario.name, 'private');
            const entry = path.join(sourceHome, scenario.entry);
            await mkdir(path.dirname(entry), { recursive: true });
            await symlink(scenario.target, entry);
            await assert.rejects(mirrorQaPersonalSetup({
                options: normalizeQaMirrorPersonalSetup(true, { preserveOrchestration: true }), sourceHome, home,
                config: path.join(home, '.config/opencode'), sourceConfigs: [{}], provisioned: {},
            }), /personal setup copy contains (a symlink outside|an unresolved symlink)/, scenario.name);
            assert.equal(await readlink(entry), scenario.target);
            assert.equal(await readFile(path.join(outside, 'index.mjs'), 'utf8'), 'owner bytes\n');
        }
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('mirrored local registrations must resolve within copied plugin directories, including parent traversal and symlinks', async () => {
    await mkdir(path.join(root, '.cache/qa'), { recursive: true });
    const scratch = await mkdtemp(path.join(root, '.cache/qa/mirror-registration-'));
    try {
        const sourceHome = path.join(scratch, 'source');
        await mkdir(path.join(sourceHome, '.config/opencode/plugins'), { recursive: true });
        await writeFile(path.join(sourceHome, '.config/opencode/plugins/valid.mjs'), 'export {};\n');
        const options = normalizeQaMirrorPersonalSetup({ plugins: true }, { preserveOrchestration: true });
        for (const [index, spec] of ['./plugins/../../escape.mjs', './plugins/../escape.mjs', './node_modules/opencode-gpt-imagegen/../../../escape.mjs'].entries()) {
            const home = path.join(scratch, `private-${index}`);
            const config = path.join(home, '.config/opencode');
            await mkdir(config, { recursive: true });
            const target = path.resolve(config, spec);
            await writeFile(target, 'outside copied plugin roots\n');
            await assert.rejects(mirrorQaPersonalSetup({ options, sourceHome, home, config,
                sourceConfigs: [{ plugin: [spec] }], provisioned: {} }), /outside the copied plugin directories/);
            assert.equal(await readFile(target, 'utf8'), 'outside copied plugin roots\n');
        }
        const home = path.join(scratch, 'linked-private');
        const config = path.join(home, '.config/opencode');
        await symlink(path.join(sourceHome, '.config/opencode/plugins/valid.mjs'), path.join(sourceHome, '.config/opencode/plugins/linked.mjs'));
        await assert.rejects(mirrorQaPersonalSetup({ options, sourceHome, home, config,
            sourceConfigs: [{ plugin: ['./plugins/linked.mjs'] }], provisioned: {} }), /outside the copied plugin directories/);
        assert.equal(await readFile(path.join(sourceHome, '.config/opencode/plugins/valid.mjs'), 'utf8'), 'export {};\n');
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('retired QA profile entry refuses before reading home, credentials or binary paths', async () => {
  await assert.rejects(prepareQaProfile({ runtimeRoot: '/unowned/not-to-be-read', sourceHome: '/unowned/not-to-be-read' }), /retired/);
});
