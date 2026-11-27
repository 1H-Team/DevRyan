import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runClaudeBridgeComparison, runNativeClaudeTurn, createFixtureToolPolicy, createBenchmarkTimingClient } from './claude-bridge-comparison.mjs';

test('three pairs alternate on an identical fixture and prompt; failure stops and restores owned files; native timeout closes SDK', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-comparison-')));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Only repair the assigned file.');
    execFileSync('git', ['init', '-q', '--template='], { cwd: root });
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@devryan.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture'], { cwd: root });
    const roleInstructions = 'Repair the assigned defect and verify it.';
    const fingerprint = { role: { contentHash: createHash('sha256').update(roleInstructions).digest('hex') } };
    const calls = [], prompts = [];
    const repair = arm => async input => {
      calls.push(arm); prompts.push(input.prompt);
      const policy = createFixtureToolPolicy(input);
      assert.equal((await policy.canUseTool('Read', { file_path: '/etc/passwd' })).behavior, 'deny');
      assert.equal((await policy.canUseTool('Write', { file_path: input.runFiles.testPath })).behavior, 'deny');
      assert.equal((await policy.canUseTool('Read', { file_path: input.runFiles.sourcePath })).behavior, 'allow');
      assert.equal((await policy.canUseTool('Bash', { command: 'cat /etc/passwd' })).behavior, 'deny');
      assert.equal((await policy.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } })).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(input.projectInstructions, 'Only repair the assigned file.');
      assert.ok(!input.prompt.includes(input.projectInstructions));
      const source = await fs.readFile(input.runFiles.sourcePath, 'utf8');
      await fs.writeFile(input.runFiles.sourcePath, source.replace('  return value;', '  if (value > maximum) return maximum;\n  return value;'));
      return { durationMs: 1, tools: { read: 1, edit: 1, bash: 2 }, models: ['claude-test'] };
    };
    const options = { client: { getHarnessPreflight: async () => ({ runFingerprint: fingerprint }),
      getAdvertisedAvailability: async () => ({ available: true, variantAvailable: true }) }, fixtureRoot: root,
      roleInstructions, selection: { providerId: 'claude-agent', modelId: 'opus', agent: 'designer', variant: 'medium' },
      nativeModel: 'opus', effort: 'medium', executable: process.execPath, qaHome: root,
      expectedCliVersion: 'fixture-cli', bridgeCliIdentityConfirmed: true, inspectCli: async () => 'fixture-cli', inspectAuth: async () => true,
      timeoutMs: 1000, query: () => {}, arms: { bridge: repair('bridge'), native: repair('native') } };
    const report = await runClaudeBridgeComparison(options);
    assert.deepEqual(calls, ['bridge', 'native', 'native', 'bridge', 'bridge', 'native']);
    assert.equal(new Set(prompts).size, 1);
    assert.equal(report.rows.length, 6);
    assert.ok(report.rows.every(row => row.accepted && row.cleanup.restored));
    assert.deepEqual(await fs.readdir(path.join(root, 'src')), []);
    let attempts = 0;
    const failed = await runClaudeBridgeComparison({ ...options, arms: { bridge: async () => { attempts++; throw new Error('fixture failure'); } } });
    assert.equal(failed.complete, false);
    assert.deepEqual(failed.rows.map(row => [row.arm, row.accepted, row.errorCode, row.cleanup.restored]), [['bridge', false, 'comparison_trial_failed', true]]);
    assert.equal(attempts, 1);
    assert.deepEqual(await fs.readdir(path.join(root, 'src')), []);
    let closed = 0, childPid;
    await assert.rejects(runNativeClaudeTurn({ query: ({ options }) => { const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {} }); childPid = child.pid; return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, close() { closed++; } }; },
      prompt: 'fixture', roleInstructions, directory: root, runFiles: { sourcePath: path.join(root, 'src/source.ts'), testPath: path.join(root, 'src/source.test.mjs'), testRelativePath: 'src/source.test.mjs' }, model: 'fixture', effort: 'medium', executable: process.execPath,
      environment: {}, timeoutMs: 10 }), { code: 'comparison_turn_timeout_or_cancelled' });
    assert.equal(closed, 1);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unavailable or unverified model/variant declines setup before fixture admission or any trial', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-preflight-')));
  try {
    const roleInstructions = 'Fixture role';
    let trials = 0, modelCalls = 0, acceptanceCalls = 0;
    const options = { fixtureRoot: path.join(root, 'not-a-fixture'), roleInstructions,
      selection: { providerId: 'claude-agent', modelId: 'opus', agent: 'designer', variant: 'medium' },
      nativeModel: 'opus', effort: 'medium', executable: process.execPath, qaHome: root,
      expectedCliVersion: 'fixture-cli', bridgeCliIdentityConfirmed: true, inspectCli: async () => 'fixture-cli', inspectAuth: async () => true, timeoutMs: 1000,
      query: () => { modelCalls++; throw Error('model must not run'); },
      testRunner: () => { acceptanceCalls++; throw Error('fixture must not run'); },
      arms: { bridge: () => { trials++; }, native: () => { trials++; } } };
    const fingerprint = { role: { contentHash: createHash('sha256').update(roleInstructions).digest('hex') } };
    for (const availability of [
      { available: false, variantAvailable: true }, { available: true, variantAvailable: false },
      { available: null, variantAvailable: true }, { available: true, variantAvailable: null }, undefined,
    ]) {
      await assert.rejects(runClaudeBridgeComparison({ ...options, client: {
        getHarnessPreflight: async () => ({ runFingerprint: fingerprint }),
        getAdvertisedAvailability: async () => availability,
      } }), { code: 'comparison_model_unavailable' });
    }
    assert.deepEqual([trials, modelCalls, acceptanceCalls], [0, 0, 0]);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('benchmark timing alone annotates a privileged 403 without mutating the client or swallowing other failures', async () => {
  const { EvaluationHttpError } = await import('../agent-evals/client.mjs');
  const forbidden = new EvaluationHttpError({ label: 'turn-timing.recent', statusCode: 403, url: 'http://127.0.0.1/api/diagnostics/turn-timing/recent' });
  const original = Object.freeze({ getTurnTiming: async () => { throw forbidden; }, createSession: async () => { throw forbidden; } });
  const timing = createBenchmarkTimingClient(original);
  assert.deepEqual(timing.getAvailability(), { available: null, reason: 'not_requested' });
  assert.deepEqual(await timing.client.getTurnTiming('ses_fixture'), { records: [] });
  assert.deepEqual(timing.getAvailability(), { available: false, reason: 'turn_timing_forbidden', httpStatus: 403 });
  assert.notEqual(timing.client, original);
  assert.equal(timing.client.createSession, original.createSession);
  await assert.rejects(original.getTurnTiming('ses_fixture'), error => error === forbidden);
  await assert.rejects(timing.client.createSession(), error => error === forbidden);
  for (const error of [new EvaluationHttpError({ label: 'turn-timing.recent', statusCode: 500, url: 'http://127.0.0.1/api' }),
    new EvaluationHttpError({ label: 'turn-timing.recent', statusCode: 401, url: 'http://127.0.0.1/api' }), Object.assign(Error('not typed'), { statusCode: 403 })]) {
    const fatal = createBenchmarkTimingClient({ getTurnTiming: async () => { throw error; } });
    await assert.rejects(fatal.client.getTurnTiming(), thrown => thrown === error);
  }
  const records = { records: [{ durationsMs: { total: 25 } }] };
  const available = createBenchmarkTimingClient({ getTurnTiming: async () => records });
  assert.equal(await available.client.getTurnTiming(), records);
  assert.deepEqual(available.getAvailability(), { available: true });
});

test('native auth preflight uses the bridge platform allowlist and private config, and declines before fixture/model trials', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-auth-preflight-')));
  const injected = { USER: 'fixture-user', LOGNAME: 'fixture-login', LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-token', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
    CLAUDECODE: 'fixture-session', CLAUDE_CONFIG_DIR: '/ambient/config', ANTHROPIC_BASE_URL: 'https://ambient.invalid' };
  const original = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, injected);
    let authCalls = 0, trials = 0, modelCalls = 0, fixtureCalls = 0, hostCalls = 0;
    const options = { fixtureRoot: path.join(root, 'not-a-fixture'), roleInstructions: 'Fixture role',
      selection: { providerId: 'claude-agent', modelId: 'opus', agent: 'designer', variant: 'medium' },
      nativeModel: 'opus', effort: 'medium', executable: process.execPath, qaHome: root,
      expectedCliVersion: 'fixture-cli', bridgeCliIdentityConfirmed: true, inspectCli: async () => 'fixture-cli', timeoutMs: 1000,
      client: { getHarnessPreflight: async () => { hostCalls++; throw Error('host must not run'); } },
      query: () => { modelCalls++; throw Error('model must not run'); },
      testRunner: () => { fixtureCalls++; throw Error('fixture must not run'); },
      arms: { bridge: () => { trials++; }, native: () => { trials++; } } };
    for (const login of [false, null, undefined]) {
      await assert.rejects(runClaudeBridgeComparison({ ...options, inspectAuth: async ({ executable, environment }) => {
        authCalls++;
        assert.equal(executable, process.execPath);
        assert.deepEqual([environment.USER, environment.LOGNAME, environment.LANG], ['fixture-user', 'fixture-login', 'en_US.UTF-8']);
        assert.equal(environment.CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
        assert.equal(environment.TMPDIR, root);
        assert.equal(environment.HOME, os.userInfo().homedir);
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'ANTHROPIC_BASE_URL']) assert.equal(environment[key], undefined);
        return login;
      } }), { code: 'comparison_native_auth_unavailable' });
    }
    assert.deepEqual([authCalls, trials, modelCalls, fixtureCalls, hostCalls], [3, 0, 0, 0, 0]);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a native cleanup failure after a failed turn is reported with, never instead of, the turn failure', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-comparison-')));
  const realKill = process.kill;
  let child;
  try {
    // The owned child cannot be signalled: cleanup fails after the turn has already failed.
    process.kill = (pid, signal) => {
      if (child && Math.abs(pid) === child.pid && signal !== 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return realKill.call(process, pid, signal);
    };
    await assert.rejects(runNativeClaudeTurn({ query: ({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {} });
      return { async *[Symbol.asyncIterator]() { throw new Error('fixture stream failed'); }, close() {} };
    }, prompt: 'fixture', roleInstructions: 'role', directory: root,
    runFiles: { sourcePath: path.join(root, 'src/source.ts'), testPath: path.join(root, 'src/source.test.mjs'), testRelativePath: 'src/source.test.mjs' },
    model: 'fixture', effort: 'medium', executable: process.execPath, environment: {}, timeoutMs: 10000 }), error => {
      assert.ok(error instanceof AggregateError, `expected both failures, got: ${error.code}`);
      assert.equal(error.code, 'comparison_native_turn_failed', 'the turn failure is the reported code');
      assert.equal(typeof error.measurement?.durationMs, 'number', 'the turn measurement survives');
      assert.equal(error.errors[0].code, 'comparison_native_turn_failed');
      assert.equal(error.errors[1].code, 'comparison_native_cleanup_failed');
      return true;
    });
  } finally {
    process.kill = realKill;
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await fs.rm(root, { recursive: true, force: true });
  }
});
