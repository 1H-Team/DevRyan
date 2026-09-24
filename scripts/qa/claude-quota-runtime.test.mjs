import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assertClaudeQuotaLaunchEnvironmentOwned, createClaudeQuotaLaunchEnvironment, startClaudeQuotaRuntime } from './claude-quota-runtime.mjs';
import { assertQaLaunchEnvironmentOwned, qaMeridianClaudePaths } from './profile-preparation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quotaProfile = { MERIDIAN_PROFILES: JSON.stringify([{ id: 'quota', type: 'oauth-token' }]), MERIDIAN_DEFAULT_PROFILE: 'quota' };
const syntheticLaunch = (scratch) => {
    const runtimeRoot = path.join(scratch, 'runtime');
    const qaHome = path.join(runtimeRoot, 'home');
    const env = createClaudeQuotaLaunchEnvironment({ runtimeRoot, qaHome, workspace: path.join(scratch, 'workspace'),
        claudeExecutable: '/synthetic/bin/claude' });
    return { runtimeRoot, qaHome, env };
};

test('quota launch env owns HOME and every Meridian/Claude path instead of inheriting the parent home', () => {
    const parentHome = process.env.HOME;
    const { qaHome, env } = syntheticLaunch(path.join(root, '.cache/qa/synthetic-quota-env'));
    assert.equal(env.HOME, qaHome);
    assert.notEqual(env.HOME, parentHome);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(qaHome, '.claude'));
    assert.equal(env.MERIDIAN_CONFIG_DIR, path.join(qaHome, '.config/meridian'));
    assert.equal(env.GIT_CONFIG_GLOBAL, path.join(qaHome, '.gitconfig'));
    assert.equal(env.MERIDIAN_CLAUDE_PATH, '/synthetic/bin/claude');
    const paths = qaMeridianClaudePaths({ ...env, ...quotaProfile });
    assert.equal(paths['homedir:meridian-profile'], path.join(qaHome, '.config/meridian/profiles/quota'));
    for (const [name, value] of Object.entries(paths)) {
        if (name === 'MERIDIAN_CLAUDE_PATH') continue;
        assert.ok(value === qaHome || value.startsWith(`${qaHome}${path.sep}`), `${name} escaped the owned home: ${value}`);
    }
    assert.doesNotThrow(() => assertClaudeQuotaLaunchEnvironmentOwned({ ...env, ...quotaProfile }, qaHome));
    assert.equal(process.env.HOME, parentHome);
});

test('quota launch guard rejects a missing or foreign HOME and only exempts the absolute Claude executable', () => {
    const { qaHome, env } = syntheticLaunch(path.join(root, '.cache/qa/synthetic-quota-guard'));
    const realHome = path.join(root, '.cache/qa/synthetic-quota-guard/real-home');
    const { HOME: _home, ...legacy } = env;
    assert.throws(() => assertClaudeQuotaLaunchEnvironmentOwned(legacy, qaHome), /must set HOME/);
    assert.throws(() => assertClaudeQuotaLaunchEnvironmentOwned({ ...env, HOME: realHome }, qaHome), /must set HOME/);
    assert.throws(() => assertClaudeQuotaLaunchEnvironmentOwned({ ...env, MERIDIAN_CONFIG_DIR: path.join(realHome, '.config/meridian') }, qaHome), /MERIDIAN_CONFIG_DIR/);
    assert.throws(() => assertClaudeQuotaLaunchEnvironmentOwned({ ...env, MERIDIAN_CLAUDE_PATH: 'claude' }, qaHome), /MERIDIAN_CLAUDE_PATH must be an absolute path/);
    assert.throws(() => assertQaLaunchEnvironmentOwned(env, qaHome), /MERIDIAN_CLAUDE_PATH/);
    assert.throws(() => createClaudeQuotaLaunchEnvironment({ runtimeRoot: 'runtime', qaHome: 'runtime/home', workspace: 'workspace',
        claudeExecutable: '/synthetic/bin/claude' }), /must set HOME/);
});

test('a saved profile without an owned HOME fails before any quota runtime process starts', async () => {
    const scratch = path.join(root, '.cache/qa/synthetic-quota-legacy');
    const { runtimeRoot, qaHome, env } = syntheticLaunch(scratch);
    const { HOME: _home, ...legacyEnv } = env;
    const profile = { runtimeRoot, qaHome, env: legacyEnv, opencodeExecutable: path.join(scratch, 'missing-opencode') };
    await assert.rejects(startClaudeQuotaRuntime(profile, { oauthToken: 'synthetic-access' }), /must set HOME/);
});

test('quota Meridian profile paths stay owned inside the Bun host where the home shim cannot rebind named imports', async () => {
    await mkdir(path.join(root, '.cache/qa'), { recursive: true });
    const scratch = await mkdtemp(path.join(root, '.cache/qa/quota-bun-home-'));
    try {
        const { qaHome, env } = syntheticLaunch(scratch);
        await mkdir(qaHome, { recursive: true });
        await writeFile(path.join(qaHome, '.devryan-qa-home'), 'owned test\n');
        // Meridian 1.62.x's oauth-token profile derivation, loaded after the QA
        // home shim as the plugin wrappers do inside the compiled OpenCode host.
        const meridian = path.join(scratch, 'meridian-paths.mjs');
        await writeFile(meridian, `import { homedir } from 'node:os';\nimport { join } from 'node:path';\n`
            + `export const paths = (id) => ({ profile: join(homedir(), '.config', 'meridian', 'profiles', id), telemetry: join(homedir(), '.config', 'meridian', 'telemetry.db') });\n`);
        const entry = path.join(scratch, 'entry.mjs');
        await writeFile(entry, `import ${JSON.stringify(fileURLToPath(new URL('./isolated-home.mjs', import.meta.url)))};\n`
            + `const { paths } = await import(${JSON.stringify(meridian)});\nconsole.log(JSON.stringify(paths(process.env.MERIDIAN_DEFAULT_PROFILE)));\n`);
        const bun = process.versions.bun ? process.execPath : 'bun';
        const run = async (launch) => JSON.parse((await promisify(execFile)(bun, [entry], { env: launch })).stdout);
        assert.deepEqual(await run({ ...env, ...quotaProfile }), { profile: path.join(qaHome, '.config/meridian/profiles/quota'),
            telemetry: path.join(qaHome, '.config/meridian/telemetry.db') });
        // Without HOME, Bun ignores the shim and falls back to the passwd home:
        // the pre-fix launch env resolved Meridian state outside the QA home.
        const { HOME: _home, ...legacy } = env;
        const leaked = await run({ ...legacy, ...quotaProfile });
        assert.ok(!leaked.profile.startsWith(`${qaHome}${path.sep}`), 'expected the unowned env to escape the QA home');
    } finally { await rm(scratch, { recursive: true, force: true }); }
});
