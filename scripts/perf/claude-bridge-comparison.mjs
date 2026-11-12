// Directional end-to-end experiment, not a causal adapter overhead benchmark.
// Supply an already isolated QA client/profile. This module never discovers accounts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { assertFixtureReady, allocateRunFiles, cleanupRunFiles, captureFixtureManifest, compareFixtureManifests } from '../agent-evals/fixture.mjs';
import { buildCaseDefinition, prepareCaseFixture, runNodeTests } from '../agent-evals/cases.mjs';
import { runSessionTurn, abortSessionTree, buildOwnedTestEvidenceCommand, EvaluationHttpError } from '../agent-evals/client.mjs';
import { buildClaudeAgentEnvironment } from '../../packages/web/server/lib/opencode/runtime-host/claude-agent-host.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
// A cleanup failure after a failed turn is reported with, never instead of, the
// turn's own failure: the turn's code and measurement stay on the thrown error.
const withCleanupFailure = (failure, cleanupError) => Object.assign(new AggregateError([failure, cleanupError],
  `${failure?.message ?? failure}; ${cleanupError?.message ?? cleanupError}`, { cause: failure }), { code: failure?.code, measurement: failure?.measurement });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const order = ['bridge', 'native', 'native', 'bridge', 'bridge', 'native'];
const numericUsage = usage => Object.fromEntries(Object.entries(usage ?? {}).filter(([key, value]) =>
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].includes(key) && finite(value) !== null));

export function createFixtureToolPolicy({ directory, runFiles }) {
  const reads = new Set([runFiles.sourcePath, runFiles.testPath, path.join(directory, 'AGENTS.md')]);
  const allowed = async (name, input) => {
    if (name === 'Bash') return input.command === buildOwnedTestEvidenceCommand(runFiles.testRelativePath) && input.run_in_background !== true;
    if (name === 'Glob') return (input.path === undefined || path.resolve(directory, input.path) === directory)
      && ['src/*', 'src/*.ts', 'src/*.mjs', runFiles.sourceRelativePath, runFiles.testRelativePath].includes(input.pattern);
    const candidate = typeof (input.file_path ?? input.path) === 'string' ? path.resolve(directory, input.file_path ?? input.path) : null;
    if (!candidate || !reads.has(candidate)) return false;
    try { if (await fs.realpath(candidate) !== candidate) return false; } catch { return false; }
    if (name === 'Read' || name === 'Grep') return true;
    return ['Edit', 'Write'].includes(name) && candidate === runFiles.sourcePath;
  };
  const canUseTool = async (name, input) => await allowed(name, input)
    ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the assigned fixture paths and exact acceptance command are allowed.' };
  // PreToolUse covers auto-approved read tools as well as permission prompts.
  const hook = async input => ({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: await allowed(input.tool_name, input.tool_input) ? 'allow' : 'deny',
    permissionDecisionReason: 'Disposable comparison fixture policy' } });
  return { canUseTool, hooks: { PreToolUse: [{ hooks: [hook] }] } };
}

export async function runNativeClaudeTurn({ query, prompt, roleInstructions, projectInstructions = '', directory, runFiles, model, effort, executable, environment, timeoutMs, signal }) {
  const controller = new AbortController();
  let rejectDeadline;
  const abort = () => { controller.abort(); rejectDeadline?.(fail('comparison_turn_timeout_or_cancelled')); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let session, result, failed = false, failure;
  const processes = [];
  const spawnOwned = options => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume(); processes.push(child); return child;
  };
  const tools = {}, models = new Set();
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { abort(); rejectDeadline(fail('comparison_turn_timeout_or_cancelled')); }, timeoutMs);
  const started = performance.now();
  try {
    if (controller.signal.aborted) throw fail('comparison_turn_timeout_or_cancelled');
    session = query({ prompt, options: { cwd: directory, model, effort, pathToClaudeCodeExecutable: executable,
      env: environment, abortController: controller, spawnClaudeCodeProcess: spawnOwned, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      ...createFixtureToolPolicy({ directory, runFiles }),
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: `${roleInstructions}\n\n${projectInstructions}` },
      settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false,
      permissionMode: 'default', maxTurns: 260 } });
    await Promise.race([(async () => { for await (const message of session) {
      if (message.type === 'assistant') {
        if (typeof message.message?.model === 'string') models.add(message.message.model);
        for (const part of message.message?.content ?? []) if (part.type === 'tool_use' && typeof part.name === 'string') tools[part.name] = (tools[part.name] ?? 0) + 1;
      }
      if (message.type === 'result') result = message;
    } })(), deadline]);
    if (controller.signal.aborted) throw fail('comparison_turn_timeout_or_cancelled');
    if (!result || result.subtype !== 'success') throw fail('comparison_native_turn_failed');
    return { durationMs: performance.now() - started, tools, models: [...models], sdkModelTurns: finite(result.num_turns),
      usage: numericUsage(result.usage), costUsd: finite(result.total_cost_usd) };
  } catch {
    failed = true;
    failure = Object.assign(fail(controller.signal.aborted ? 'comparison_turn_timeout_or_cancelled' : 'comparison_native_turn_failed'),
      { measurement: { durationMs: performance.now() - started, tools, models: [...models] } });
    throw failure;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); session?.close();
    try { for (const child of processes) {
      const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw fail('comparison_native_cleanup_failed'); } };
      kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
        const timer = setTimeout(done, 1000); child.once('exit', done);
      });
      kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
        const timer = setTimeout(done, 1000); child.once('exit', done);
      });
      if (child.exitCode === null && child.signalCode === null) throw fail('comparison_native_cleanup_failed');
    } } catch (cleanupError) { throw failed ? withCleanupFailure(failure, cleanupError) : cleanupError; }
  }
}

// This privileged diagnostic is optional for this experiment only. General
// agent-evals permissions and execution failure behavior remain unchanged.
export function createBenchmarkTimingClient(client) {
  let availability = { available: null, reason: 'not_requested' };
  return { client: { ...client, async getTurnTiming(...args) {
    try {
      const result = await client.getTurnTiming(...args);
      availability = { available: true };
      return result;
    } catch (error) {
      if (!(error instanceof EvaluationHttpError) || error.statusCode !== 403) throw error;
      availability = { available: false, reason: 'turn_timing_forbidden', httpStatus: 403 };
      return { records: [] };
    }
  } }, getAvailability: () => ({ ...availability }) };
}

async function runBridgeTurn(input) {
  let result, failed = false, failure;
  const timing = createBenchmarkTimingClient(input.client);
  try {
    result = await runSessionTurn({ client: timing.client, directory: input.directory, selection: input.selection,
      prompt: input.prompt, timeoutMs: input.timeoutMs, signal: input.signal, caseId: 'repair-and-test', runFiles: input.runFiles });
    const fingerprint = result.harnessEvidence?.finishFingerprint;
    if (fingerprint?.role?.contentHash !== hash(input.roleInstructions)) throw fail('comparison_role_changed');
    const tools = {};
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const entry of result.sessionTree) for (const message of entry.messages) if (message.info?.role === 'assistant') {
      const tokens = message.info.tokens;
      for (const [key, value] of Object.entries({ input_tokens: tokens?.input, output_tokens: tokens?.output,
        cache_read_input_tokens: tokens?.cache?.read, cache_creation_input_tokens: tokens?.cache?.write })) if (finite(value) !== null) usage[key] += value;
    }
    for (const tool of result.tools) tools[tool.tool] = (tools[tool.tool] ?? 0) + 1;
    return { durationMs: result.durationMs, usage, tools, turnTiming: result.turnTiming, turnTimingAvailability: timing.getAvailability(), sessionId: result.rootSessionId,
      models: [...new Set(result.sessionTree.flatMap(entry => entry.messages.filter(message => message.info?.role === 'assistant')
        .map(message => message.info.modelID).filter(Boolean)))], fingerprint };
  } catch (error) {
    failed = true; failure = error;
    throw error;
  } finally {
    if (result) {
      try {
        const cleanup = await abortSessionTree(input.client, result.rootSessionId, input.directory, { timeoutMs: 5000, knownSessionIds: result.childSessionIds });
        if (!cleanup.complete) throw fail('comparison_session_cleanup_failed');
      } catch (cleanupError) { throw failed ? withCleanupFailure(failure, cleanupError) : cleanupError; }
    }
  }
}

/** Exactly three alternating pairs. Stop on failure; never replace a failed trial.
 * `roleInstructions` must be the configured QA role body (not frontmatter).
 * CLI identity is caller-attested for the bridge, independently checked here for
 * the direct arm. No production HTTP/configuration seam is added for this probe.
 */
export async function runClaudeBridgeComparison(options) {
  const { client, fixtureRoot, roleInstructions, selection, nativeModel, effort, executable, qaHome, expectedCliVersion } = options;
  if (!client || selection?.providerId !== 'claude-agent' || selection.variant !== effort
    || typeof roleInstructions !== 'string' || !roleInstructions || typeof nativeModel !== 'string' || nativeModel !== selection.modelId
    || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000
    || typeof expectedCliVersion !== 'string' || !expectedCliVersion || !options.bridgeCliIdentityConfirmed
    || typeof qaHome !== 'string' || !qaHome.startsWith('/') || typeof executable !== 'string' || !executable.startsWith('/')) throw fail('comparison_configuration_invalid');
  const canonicalHome = await fs.realpath(qaHome);
  const accountHomes = [os.homedir(), os.userInfo().homedir].map(value => path.resolve(value));
  if (canonicalHome !== path.resolve(qaHome) || accountHomes.includes(canonicalHome)) throw fail('comparison_isolated_home_required');
  // Explicit QA HOME/config, no ambient auth/session/gateway variables.
  const environment = buildClaudeAgentEnvironment({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    { home: qaHome, tmpdir: qaHome });
  environment.CLAUDE_CONFIG_DIR = `${qaHome}/.claude`;
  const inspectCli = options.inspectCli ?? (async () => (await promisify(execFile)(executable, ['--version'], { env: environment, timeout: 5000, maxBuffer: 4096 })).stdout.trim());
  if (await inspectCli() !== expectedCliVersion) throw fail('comparison_cli_version_mismatch');
  const inspectAuth = options.inspectAuth ?? (async () => {
    try {
      const { stdout } = await promisify(execFile)(executable, ['auth', 'status'], { env: environment, timeout: 5000, maxBuffer: 16384 });
      return JSON.parse(stdout)?.loggedIn === true;
    } catch { return false; }
  });
  if (await inspectAuth({ executable, environment }) !== true) throw fail('comparison_native_auth_unavailable');
  const cliSha256 = hash(await fs.readFile(executable));
  const preflight = await client.getHarnessPreflight(fixtureRoot, selection, options.signal);
  if (preflight?.runFingerprint?.role?.contentHash !== hash(roleInstructions)) throw fail('comparison_role_mismatch');
  const availability = await client.getAdvertisedAvailability?.(fixtureRoot, selection, options.signal);
  if (availability?.available !== true || availability.variantAvailable !== true) throw fail('comparison_model_unavailable');
  const startingManifest = assertFixtureReady(fixtureRoot);
  const agentsPath = `${fixtureRoot}/AGENTS.md`;
  let agentInstructions = '';
  try { agentInstructions = await fs.readFile(agentsPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sdkPackage = JSON.parse(await fs.readFile(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
  if (sdkPackage.version !== '0.3.301') throw fail('comparison_sdk_version_mismatch');
  const query = options.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  const rows = [];
  for (const [index, arm] of order.entries()) {
    options.signal?.throwIfAborted();
    const runFiles = allocateRunFiles(fixtureRoot, 'claude-comparison');
    let cleanup, measurement, promptSha256;
    const trialStarted = performance.now();
    try {
      const prepared = prepareCaseFixture('repair-and-test', runFiles);
      const baseline = await (options.testRunner ?? runNodeTests)({ fixtureRoot, testRelativePath: runFiles.testRelativePath, timeoutMs: 10000 });
      if (baseline.timedOut || baseline.exitCode === 0) throw fail('comparison_invalid_baseline');
      // Same task and fixture guidance in both arms; native CLAUDE.md discovery is disabled.
      const prompt = buildCaseDefinition('repair-and-test', runFiles).prompt;
      promptSha256 = hash(prompt);
      const input = { client, directory: fixtureRoot, selection, prompt, roleInstructions, projectInstructions: agentInstructions, timeoutMs: options.timeoutMs,
        runFiles, query, model: nativeModel, effort, executable, environment, signal: options.signal };
      const armStarted = performance.now();
      measurement = await (options.arms?.[arm] ?? (arm === 'bridge' ? runBridgeTurn : runNativeClaudeTurn))(input);
      measurement.armWallMs = performance.now() - armStarted;
      const final = await (options.testRunner ?? runNodeTests)({ fixtureRoot, testRelativePath: runFiles.testRelativePath, timeoutMs: 10000 });
      if (final.timedOut || final.exitCode !== 0 || await fs.readFile(runFiles.sourcePath, 'utf8') === prepared.baselineSource || await fs.readFile(runFiles.testPath, 'utf8') !== prepared.baselineTest) throw fail('comparison_acceptance_failed');
      rows.push({ pair: Math.floor(index / 2) + 1, arm, promptSha256: hash(prompt), ...measurement, accepted: true });
    } catch (error) {
      rows.push({ pair: Math.floor(index / 2) + 1, arm, promptSha256, ...(measurement ?? error?.measurement), accepted: false,
        durationMs: measurement?.durationMs ?? error?.measurement?.durationMs ?? performance.now() - trialStarted,
        errorCode: /^comparison_[a-z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'comparison_trial_failed' });
    } finally {
      try { cleanup = cleanupRunFiles({ fixtureRoot, runFiles, startingManifest }); }
      catch { cleanup = { restored: false, errorCode: 'comparison_fixture_cleanup_failed' }; }
      if (rows[index]) rows[index].cleanup = cleanup;
    }
    if (!rows[index]?.accepted || !cleanup.restored || !compareFixtureManifests(startingManifest, captureFixtureManifest(fixtureRoot)).matches) break;
  }
  return { schemaVersion: 1, complete: rows.length === 6 && rows.every(row => row.accepted && row.cleanup.restored), sdkVersion: '0.3.301', cliVersion: expectedCliVersion, cliSha256, selection, nativeModel, effort,
    roleSha256: hash(roleInstructions), projectInstructionsSha256: hash(agentInstructions), fixtureSha256: hash(JSON.stringify(startingManifest)), rows,
    limitations: ['Three pairs provide directional observations only; no causal speedup claim.',
      'Privileged turn timing may be unavailable (HTTP 403); turnTimingAvailability marks absence, not zero measured timing.',
      'armWallMs includes arm execution and process/session cleanup, excluding baseline/final acceptance tests; durationMs is HTTP turn/diagnostic time or SDK query/result time respectively.',
      'Bridge CLI identity is caller-confirmed; direct executable bytes/version are checked.',
      'Native Claude kernel/builtin tools, compaction and permission ownership differ from the bridge.',
      'AGENTS.md is discovered by the bridge and explicitly appended to native system instructions; it is not duplicated in either user task.',
      'Other bridge-injected runtime/project guidance is not captured; role body, fixture guidance and task match.',
      'Direct native tools use a fixture-only PreToolUse/permission policy; this is not an OS sandbox.',
      'Title/helper model selection must be pinned in the isolated host by its owner; no production configuration is changed.',
      'SDK model turns and native primary steps are different counters; this runner does not equate them.',
      'Shared provider caches may be warm and are not reset between alternating arms.'] };
}
