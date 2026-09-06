import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assertQaSelectedProviderAccess, assertQaSelectedProviderDuration, pinQaAgents, prepareQaPluginHomeWrapper, prepareQaProfile, projectQaAuth } from './profile-preparation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

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

test('profile preparation rejects outside paths or unsupported providers before writing', async () => {
    await assert.rejects(prepareQaProfile({ runtimeRoot: '/tmp/not-owned', workspace: path.join(root, '.cache/qa/workspace'), providerId: 'openai', modelId: 'test' }), /repository cache/);
    await assert.rejects(prepareQaProfile({ runtimeRoot: path.join(root, '.cache/qa/test'), workspace: path.join(root, '.cache/qa/workspace'), providerId: 'google', modelId: 'test' }), /OpenAI, Anthropic, or xAI/);
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

test('specialist assignment validation rejects ambiguous roles, cross-provider access, and missing effort before profile writes', async () => {
    const selection = { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high' };
    const explorer = { providerId: 'openai', modelId: 'gpt-5.3-codex-spark', variant: 'high' };
    for (const agentAssignments of [null, [], { orchestrator: explorer }, { missing: explorer },
        { explorer: { ...explorer, providerId: 'xai' } }, { explorer: { ...explorer, modelId: 'openai/spark' } },
        { explorer: { ...explorer, variant: undefined } }, { explorer: { ...explorer, variant: '' } },
        { explorer: { ...explorer, variant: ' high ' } }, { explorer: { ...explorer, modelId: ' spark' } },
        { explorer: { ...explorer, extra: true } }]) {
        assert.throws(() => pinQaAgents({}, { ...selection, agentAssignments }), /specialist assignments/);
        await assert.rejects(prepareQaProfile({ ...selection, agentAssignments,
            runtimeRoot: path.join(root, '.cache/qa/assignment-not-created'),
            workspace: path.join(root, '.cache/qa/assignment-no-workspace') }), /specialist assignments/);
    }
    await assert.rejects(access(path.join(root, '.cache/qa/assignment-not-created')), { code: 'ENOENT' });
});

test('profile preparation rejects symlink escapes before creating a private home', async () => {
    const cache = path.join(root, '.cache/qa');
    await mkdir(cache, { recursive: true });
    const fixture = await mkdtemp(path.join(cache, 'profile-path-test-'));
    try {
        const linkedRuntime = path.join(fixture, 'linked-runtime');
        await symlink(root, linkedRuntime);
        await assert.rejects(prepareQaProfile({ runtimeRoot: path.join(linkedRuntime, 'uncreated-profile'), workspace: fixture,
            providerId: 'openai', modelId: 'test' }), /resolve inside this repository cache/);
        await assert.rejects(access(path.join(root, 'uncreated-profile')), { code: 'ENOENT' });
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('profile preparation rejects a workspace that would inherit the parent project config', async () => {
    const cache = path.join(root, '.cache/qa');
    await mkdir(cache, { recursive: true });
    const fixture = await mkdtemp(path.join(cache, 'profile-git-test-'));
    try {
        const runtimeRoot = path.join(fixture, 'runtime');
        await assert.rejects(prepareQaProfile({ runtimeRoot, workspace: fixture,
            providerId: 'openai', modelId: 'test' }), /its own Git repository root/);
        await assert.rejects(access(runtimeRoot), { code: 'ENOENT' });
    } finally { await rm(fixture, { recursive: true, force: true }); }
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
