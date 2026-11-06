// Matched-trial hosts for the `adaptiveDelegation` policy factor (Phase 7).
//
// Two private, credential-free DevRyan web hosts on loopback that differ only
// in DEVRYAN_ADAPTIVE_DELEGATION (baseline `0`, candidate `1`): the same
// verified native artifact, one snapshot of the current web build, one sealed
// mirror of the owner's saved OpenCode setup and an identical fixture project
// per arm. Nothing here signs in, prompts or reads an account, database,
// journal, keychain or running app. The owner signs in to OpenAI by hand in
// each host's Providers screen; `bun run agent:eval` then targets each origin.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { comparePairedReports } from '../agent-evals/paired.mjs';
import { captureFixtureManifest } from '../agent-evals/fixture.mjs';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { createQaNativeLaunchEnvironment, prepareQaNativeBundle, readQaNativeSelectionView } from './native-profile-preparation.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { cloneTree, createRunRoot, keepArtifactsRequested, scratchParent } from './run-root.mjs';
import { isQaLiveSetupFile, parseQaSavedGraph, prepareLiveSetupMirror, projectQaLiveSetupFile, qaCache, qaHash, readQaPinnedFile } from './live-setup-mirror.mjs';
import { startOwnedProcess } from './process.mjs';
import { runtimeUiAgentOverrides } from './native-backend-ui-diagnostic.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { defaultNativeRegistrations } from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const OWNER = 'scripts/qa/adaptive-delegation-trials.mjs';
const PROVIDER = 'openai';
const fail = (code, details) => Object.assign(new Error(code), { code, ...(details ? { details } : {}) });

export const TRIAL_ARMS = Object.freeze([
  Object.freeze({ id: 'baseline', adaptiveDelegation: '0' }),
  Object.freeze({ id: 'candidate', adaptiveDelegation: '1' }),
]);

/** Owner setup roots, relative to the owner's home, and their mirror layout.
 * Only `isQaLiveSetupFile` entries under them are read, then projected
 * without credentials; accounts, databases and the DevRyan data root never are. */
export const OWNER_SETUP_ROOTS = Object.freeze([
  Object.freeze({ source: '.config/opencode', target: 'opencode' }),
  Object.freeze({ source: '.agents/skills', target: 'home/.agents/skills' }),
  Object.freeze({ source: '.opencode/skills', target: 'home/.opencode/skills' }),
  Object.freeze({ source: '.opencode/skill', target: 'home/.opencode/skill' }),
]);

const USAGE = 'Usage: node scripts/qa/adaptive-delegation-trials.mjs --artifact-root <repo .cache artifact dir> [--agent <role>] [--helper-model openai/<model>] [--dry-run] [--keep-artifacts]';

export function parseTrialArgs(argv) {
  const options = { artifactRoot: null, agent: 'orchestrator', helperModel: null, dryRun: false, keepArtifacts: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--keep-artifacts') { options.keepArtifacts = true; continue; }
    const value = argv[index + 1];
    if (!['--artifact-root', '--agent', '--helper-model'].includes(flag) || typeof value !== 'string' || !value || value.startsWith('--')) throw fail('qa_trials_flags_invalid', USAGE);
    index++;
    if (flag === '--artifact-root') options.artifactRoot = path.resolve(value);
    else if (flag === '--agent') {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail('qa_trials_flags_invalid', USAGE);
      options.agent = value;
    } else {
      if (!/^openai\/[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail('qa_trials_helper_not_openai', USAGE);
      options.helperModel = value;
    }
  }
  if (!options.artifactRoot) throw fail('qa_trials_flags_invalid', USAGE);
  return options;
}

/** Every model route the saved graph can use: roles, Council members and backups. */
export function savedGraphRoutes(graph) {
  return [
    ...Object.entries(graph.agentSelections).map(([role, row]) => ({ kind: 'role', role, model: row.model, variant: row.variant ?? null })),
    ...graph.councilMembers.map((row, index) => ({ kind: 'council', role: row.agent, index, model: `${row.providerId}/${row.modelId}`, variant: row.variant ?? null })),
    ...Object.entries(graph.nativeBackupSelections.slim.runtimeChains).flatMap(([role, chain]) => chain.map((model, index) => ({
      kind: 'slim-fallback', role, index, model, variant: graph.nativeBackupSelections.slim.modelArrays[role]?.[index]?.variant ?? null }))),
    ...Object.entries(graph.nativeBackupSelections.devryan).map(([role, row]) => ({ kind: 'backup', role, model: row.model, variant: row.variant ?? null })),
  ];
}

export const foreignGraphRoutes = (graph, provider = PROVIDER) => savedGraphRoutes(graph).filter(route => route.model.split('/')[0] !== provider);

/** The eval selection is the saved route of one role, never a chosen model. */
export function selectionFromGraph(graph, agent) {
  const row = graph.agentSelections[agent];
  if (!row) throw fail('qa_trials_agent_unconfigured', { agent });
  const slash = row.model.indexOf('/');
  return { providerId: row.model.slice(0, slash), modelId: row.model.slice(slash + 1), agent, variant: row.variant ?? null };
}

/** Helper calls (titles, summaries) default to a non-OpenAI model, so the
 * launcher pins one OpenAI model at Default reasoning and reports it. */
export function helperSelection(selection, helperModel) {
  const model = helperModel ?? `${selection.providerId}/${selection.modelId}`;
  const slash = model.indexOf('/');
  if (model.slice(0, slash) !== PROVIDER) throw fail('qa_trials_helper_not_openai');
  return { providerID: PROVIDER, modelID: model.slice(slash + 1), revision: 'qa-adaptive-trials' };
}

/** The arm's host environment: the shared native launch plus exactly one switch. */
export function armLaunchEnvironment(nativeEnvironment, arm, { distDirectory, gitCeiling }) {
  if (!TRIAL_ARMS.some(row => row.id === arm.id && row.adaptiveDelegation === arm.adaptiveDelegation)) throw fail('qa_trials_arm_invalid');
  const environment = { ...nativeEnvironment };
  for (const key of Object.keys(environment)) if (key.startsWith('DEVRYAN_ADAPTIVE_')) delete environment[key];
  return { ...environment, DEVRYAN_QA_RUNTIME: 'web', DEVRYAN_PORT: '0', DEVRYAN_DIST_DIR: distDirectory,
    GIT_CEILING_DIRECTORIES: gitCeiling, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    DEVRYAN_ADAPTIVE_DELEGATION: arm.adaptiveDelegation };
}

const FINGERPRINT_REASONS = new Set(['fingerprint_unavailable', 'configuration_mismatch', 'experimental_factor_unchanged', 'switches_unavailable',
  'switches_changed_during_run', 'policy_source_unattested', 'role_attestation_mismatch']);
// Plugin factory loads are reported only at a run start, and the selected
// model's tool catalog only once its provider is signed in. While both arms
// lack one of them, both carry the same labelled placeholder so that every
// other `matchedFingerprint` rule still applies; the eval run checks the rest.
const PRE_RUN_PLUGIN = Object.freeze({ name: 'pre-run-placeholder', contentHash: '0'.repeat(64), factoryCalls: 1, ownership: 'unknown' });
const PRE_SIGN_IN_CATALOG = Object.freeze({ contentHash: '0'.repeat(64), idsHash: '0'.repeat(64), count: 0, availability: 'pending-sign-in', tools: null });

/** Applies the paired comparator (`matchedFingerprint`, derivation checks) to
 * the arms' preflight fingerprints for the adaptiveDelegation factor. */
export function compareArmFingerprints({ baseline, candidate }) {
  const observed = value => Array.isArray(value?.plugins?.observed) && value.plugins.observed.length > 0;
  const cataloged = value => value?.catalog?.availability === 'available';
  const pending = !observed(baseline) && !observed(candidate);
  const catalogPending = !cataloged(baseline) && !cataloged(candidate);
  const prepared = value => ({ ...value, ...(pending ? { plugins: { ...value?.plugins, observed: [PRE_RUN_PLUGIN] } } : {}),
    ...(catalogPending ? { catalog: PRE_SIGN_IN_CATALOG } : {}) });
  const report = value => ({ executionMode: 'live', fixtureHash: 'f'.repeat(64), environmentHash: 'e'.repeat(64), selection: {}, cleanup: { restored: true },
    runs: [{ caseId: 'launcher-preflight', status: 'passed', harness: { startFingerprint: value, finishFingerprint: value } }] });
  const comparison = comparePairedReports({ pairs: [{ index: 1, order: 'baseline-then-candidate', baseline: report(prepared(baseline)),
    candidate: report(prepared(candidate)) }], factor: 'adaptiveDelegation', targetMetric: 'objectiveDurationMs', requiredPairs: 1 });
  const [row] = comparison.cases;
  const reasons = comparison.reasons.filter(reason => FINGERPRINT_REASONS.has(reason));
  const policies = { baseline: row?.baselineFactor ?? null, candidate: row?.candidateFactor ?? null };
  if (policies.baseline !== false || policies.candidate !== true) reasons.push('arm_policy_unexpected');
  return { matched: Boolean(row?.matched) && reasons.length === 0, matchHash: row?.matchHash ?? null, policies,
    policySources: { baseline: baseline?.policySource ?? null, candidate: candidate?.policySource ?? null },
    derivationIssues: row?.derivationIssues ?? [], reasons: [...new Set(reasons)].sort(),
    observedPlugins: pending ? 'pending-first-run' : 'compared', catalog: catalogPending ? 'pending-sign-in' : 'compared' };
}

const hashTree = async root => {
  const rows = [];
  const walk = async directory => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) rows.push([path.relative(root, file), qaHash(await fs.readFile(file))]);
    }
  };
  await walk(root);
  return { files: rows.length, sha256: qaHash(JSON.stringify(rows)) };
};

const writeSealed = async (file, bytes) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
  return qaHash(bytes);
};

/** The owner's trial graph (decided 2026-11-05): Orchestrator on GPT-6 Astra,
 * every other role, Council member and backup route on GPT-6.1 Sol, all at
 * Medium; helpers on GPT-6 Astra at Default reasoning. */
export const TRIAL_GRAPH = Object.freeze({
  orchestrator: Object.freeze({ model: 'openai/gpt-6-astra', variant: 'medium' }),
  subagents: Object.freeze({ model: 'openai/gpt-6.1-sol', variant: 'medium' }),
  helper: 'openai/gpt-6-astra',
});
export const trialRoute = role => role === 'orchestrator' ? TRIAL_GRAPH.orchestrator : TRIAL_GRAPH.subagents;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pinChain = (chain, route) => chain.map(item => typeof item === 'string' ? route.model
  : record(item) ? { ...item, ...(Object.hasOwn(item, 'id') ? { id: route.model } : { model: route.model }), variant: route.variant } : item);
/** One agent entry on its trial route; Council members and fallback chains included. */
export function pinTrialAgentEntry(role, entry) {
  const route = trialRoute(role);
  if (typeof entry === 'string') return route.model;
  if (!record(entry)) return entry;
  const pinned = { ...entry, model: route.model, variant: route.variant };
  if (Array.isArray(entry.councillors)) pinned.councillors = entry.councillors.map(() => ({ ...TRIAL_GRAPH.subagents }));
  for (const key of ['models', 'fallback_models', 'fallbackModels']) if (Array.isArray(entry[key])) pinned[key] = pinChain(entry[key], route);
  if (Array.isArray(entry.modelRefs)) pinned.modelRefs = entry.modelRefs.map(() => TRIAL_GRAPH.subagents.model);
  return pinned;
}
const pinAgentMap = map => record(map) ? Object.fromEntries(Object.entries(map).map(([role, entry]) => [role, pinTrialAgentEntry(role, entry)])) : map;
const CONFIG_AGENT_MAPS = Object.freeze([
  [/^opencode\/(?:config|opencode)\.jsonc?$/, ['agent']],
  [/^opencode\/(?:oh-my-opencode-slim|devryan-agents)\.jsonc?$/, ['agents', 'presets']],
  [/^opencode\/\.(?:devryan|openchamber)\/config\.json$/, ['agentOverrides']],
]);
const AGENT_MARKDOWN = /^opencode\/agents?\/([A-Za-z0-9._-]+)\.md$/;
const COUNCIL_COMPANION = /^opencode\/agents?\/[A-Za-z0-9._-]+\.models\.json$/;

/** Rewrites only model routes in an already credential-free setup file, so
 * the compiled configuration owner resolves the trial graph from every layer. */
export function pinTrialSetupFile(file, bytes) {
  const markdown = file.match(AGENT_MARKDOWN);
  if (markdown) {
    const text = bytes.toString('utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) return { bytes, pinned: false };
    const route = trialRoute(markdown[1]);
    const frontmatter = match[1].replace(/^model:.*$/m, `model: ${route.model}`).replace(/^variant:.*$/m, `variant: ${route.variant}`);
    const next = Buffer.from(`---\n${frontmatter}\n---${text.slice(match[0].length - (match[0].endsWith('\n') ? 1 : 0))}`);
    return { bytes: next, pinned: !next.equals(bytes) };
  }
  if (COUNCIL_COMPANION.test(file)) {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(value?.councillors)) return { bytes, pinned: false };
    const next = Buffer.from(JSON.stringify({ ...value, councillors: value.councillors.map(() => ({ ...TRIAL_GRAPH.subagents })) }, null, 2) + '\n');
    return { bytes: next, pinned: !next.equals(bytes) };
  }
  const maps = CONFIG_AGENT_MAPS.find(([pattern]) => pattern.test(file))?.[1];
  if (!maps) return { bytes, pinned: false };
  const value = JSON.parse(bytes.toString('utf8'));
  if (!record(value)) return { bytes, pinned: false };
  const next = { ...value };
  for (const key of maps) {
    if (key === 'presets') { if (record(next.presets)) next.presets = Object.fromEntries(Object.entries(next.presets).map(([name, preset]) => [name, pinAgentMap(preset)])); }
    else if (record(next[key])) next[key] = pinAgentMap(next[key]);
  }
  if (typeof next.model === 'string') next.model = TRIAL_GRAPH.orchestrator.model;
  if (typeof next.small_model === 'string') next.small_model = TRIAL_GRAPH.helper;
  const output = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  return { bytes: output, pinned: !output.equals(bytes) };
}

// The reviewed sidecar override layer (as focused-provider-inputs pins it):
// every packaged role and its Council members, on top of whatever the owner
// saved, so packaged defaults such as the Council companion cannot leak in.
export const TRIAL_OVERRIDES_FILE = 'opencode/.devryan/config.json';
const UNROUTED_ROLES = new Set(['build', 'plan']);
export function trialAgentOverrides(existing = {}) {
  const generated = Object.fromEntries(Object.entries(runtimeUiAgentOverrides()).filter(([name]) => !UNROUTED_ROLES.has(name))
    .map(([name, row]) => [name, pinTrialAgentEntry(name, row)]));
  return { ...existing, agentOverrides: { ...pinAgentMap(record(existing.agentOverrides) ? existing.agentOverrides : {}), ...generated } };
}

/** Resolved routes that are not on the trial graph. */
export const trialGraphMismatches = graph => savedGraphRoutes(graph).filter(route => {
  const expected = route.kind === 'council' ? TRIAL_GRAPH.subagents : trialRoute(route.role);
  return route.model !== expected.model || route.variant !== expected.variant;
});

/** Reads only allowlisted, nonsymlinked setup files and writes their
 * credential-free projection; raw bytes never reach disk or output. */
async function projectOwnerSetup(ownerHome, sourceHome) {
  const files = [], skipped = { symlinks: 0, other: 0 }, pinned = [];
  let overrides = {};
  for (const root of OWNER_SETUP_ROOTS) {
    const base = path.join(ownerHome, root.source);
    let stat;
    try { stat = await fs.lstat(base); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory()) { skipped.other++; continue; }
    const walk = async (directory, relative) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.DS_Store') continue;
        const file = path.join(directory, entry.name), mirrored = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) { skipped.symlinks++; continue; }
        if (entry.isDirectory()) { await walk(file, mirrored); continue; }
        if (!entry.isFile()) { skipped.other++; continue; }
        if (!isQaLiveSetupFile(mirrored)) continue;
        const projection = pinTrialSetupFile(mirrored, projectQaLiveSetupFile(mirrored, await fs.readFile(file)).bytes);
        if (projection.pinned) pinned.push(mirrored);
        const bytes = projection.bytes;
        if (mirrored === TRIAL_OVERRIDES_FILE) { overrides = JSON.parse(bytes.toString('utf8')); continue; }
        files.push({ path: mirrored, sha256: await writeSealed(path.join(sourceHome, mirrored), bytes) });
        if (files.length > 4096) throw fail('qa_trials_setup_too_large');
      }
    };
    await walk(base, root.target);
  }
  if (!files.some(row => row.path.startsWith('opencode/'))) throw fail('qa_trials_owner_setup_missing');
  files.push({ path: TRIAL_OVERRIDES_FILE, sha256: await writeSealed(path.join(sourceHome, TRIAL_OVERRIDES_FILE),
    Buffer.from(JSON.stringify(trialAgentOverrides(record(overrides) ? overrides : {}), null, 2) + '\n')) });
  pinned.push(TRIAL_OVERRIDES_FILE);
  return { files, skipped, pinned };
}

const credentialFree = async () => { throw fail('qa_trials_credential_free'); };

/** A credential-free native bundle from the sealed inputs, through the same
 * factory, migration and checkpoint owners as every native QA profile. */
async function prepareArmBundle({ preparedInput, mirror, runScope, runtimeRoot, workspace }) {
  const factory = await createQaNativePreparationFactory({ preparedInput, mirror, bootstrapCredentials: credentialFree, runScope });
  await fs.mkdir(runtimeRoot, { mode: 0o700 });
  const source = await factory.prepareSource({ runtimeRoot, workspace, sourceHome: preparedInput.sourceHome, artifactRoot: preparedInput.artifactRoot });
  const { binding, store } = await prepareQaNativeBundle({ runtimeRoot, source, runScope });
  await fs.writeFile(path.join(binding.descriptor.launch.global.home, '.devryan-qa-home'), 'DevRyan isolated native QA\n', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(runtimeRoot, 'credentials.env.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const env = createQaNativeLaunchEnvironment({ binding, runtimeRoot });
  const view = await readQaNativeSelectionView(binding, env, workspace);
  return { binding, store, env, view };
}

const graphOf = view => parseQaSavedGraph(Object.fromEntries(['agentSelections', 'nativeBackupSelections', 'nativeCompactionSettings', 'councilMembers'].map(key => [key, view[key]])));

const FIXTURE_FILES = Object.freeze({
  'package.json': JSON.stringify({ name: 'devryan-eval-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# DevRyan evaluation fixture\n\nA small module project for matched agent evaluations. Cases add and remove their own files under `src/`.\n',
  'src/index.mjs': 'export function add(left, right) {\n  return left + right;\n}\n',
  'src/index.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './index.mjs';\n\ntest('adds two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
});

async function createFixture(workspace, privateRoot) {
  await fs.mkdir(workspace, { mode: 0o700 });
  for (const [file, bytes] of Object.entries(FIXTURE_FILES)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(workspace, file), bytes, { mode: 0o644 });
  }
  const gitConfig = path.join(privateRoot, 'gitconfig'), template = path.join(privateRoot, 'git-template');
  if (!existsSync(gitConfig)) { await fs.writeFile(gitConfig, '', { mode: 0o600 }); await fs.mkdir(template, { mode: 0o700 }); }
  const env = createQaHostLaunchEnvironment({ HOME: privateRoot, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(workspace),
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'DevRyan QA', GIT_AUTHOR_EMAIL: 'qa@devryan.invalid', GIT_COMMITTER_NAME: 'DevRyan QA',
    GIT_COMMITTER_EMAIL: 'qa@devryan.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  const git = args => promisify(execFile)('git', args, { cwd: workspace, env, timeout: 15000 });
  await git(['init', '--quiet', `--template=${template}`, '--initial-branch=main']);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Evaluation fixture']);
  return qaHash(JSON.stringify(captureFixtureManifest(workspace)));
}

const getJson = async (origin, route, timeoutMs = 15000) => {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw fail('qa_trials_http_failed', { route: route.split('?')[0], status: response.status });
  const body = await response.json();
  return body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'data') ? body.data : body;
};

/** Restarts every arm's host in place after a host-side code change: all stop
 * before any starts, each stale ready file goes before its host starts, and the
 * new origins are returned. Run roots, sign-ins and fixtures are untouched.
 * A stop that ended the host and every recorded process but could not finish
 * its audit (one missed process snapshot makes it unverifiable) still
 * restarts; that arm is listed in `unverifiedCleanup`. A host or recorded
 * process still running, or one that cannot be observed, refuses the restart. */
export async function restartTrialHosts({ arms, hosts, startHost, removeReady, waitReady }) {
  const unverifiedCleanup = [];
  for (const arm of arms) {
    const host = hosts.get(arm.id);
    try { await host.stop(); }
    catch {
      const remaining = await host.observe().catch(() => null);
      const { exitCode, exitSignal } = host.getCleanupEvidence();
      if (!Array.isArray(remaining) || remaining.length || exitCode === null && exitSignal === null) throw fail('qa_trials_restart_stop_incomplete', { arm: arm.id });
      unverifiedCleanup.push(arm.id);
    }
  }
  for (const arm of arms) { await removeReady(arm); startHost(arm); }
  const ready = await Promise.all(arms.map(arm => waitReady(arm, hosts.get(arm.id))));
  return { origins: Object.fromEntries(arms.map((arm, index) => [arm.id, ready[index].origin])), unverifiedCleanup };
}

async function waitForNativeReady(host, runtimeRoot, check, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let ready = null, health = null;
  while (Date.now() < deadline) {
    check(); host.check();
    if (!ready) {
      try { ready = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'ready.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (ready) {
      try {
        const response = await fetch(new URL('/health', ready.origin), { signal: AbortSignal.timeout(10000) });
        if (response.ok) health = await response.json();
      } catch { /* listener still binding */ }
      if (health?.openCodeStartup?.state === 'failed') throw fail('qa_trials_native_start_failed', { code: health.openCodeStartup.code ?? null });
      if (health?.isOpenCodeReady === true && health.openCodeGeneration === 2 && Number.isInteger(health.openCodePort) && health.openCodePort > 0) {
        assert.equal(new URL(ready.origin).hostname, '127.0.0.1');
        return { origin: new URL(ready.origin).origin, health };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw fail('qa_trials_native_ready_timeout');
}

/** Read-only, credential-free host checks: health, providers, policy, fingerprint. */
async function inspectArm({ origin, workspace, selection }) {
  const query = `?directory=${encodeURIComponent(workspace)}`;
  const health = await getJson(origin, '/health');
  const providers = await getJson(origin, `/api/provider${query}`);
  const auth = await getJson(origin, `/api/provider/auth${query}`);
  const openai = Array.isArray(providers?.all) ? providers.all.find(row => row?.id === PROVIDER) : null;
  const preflightQuery = new URLSearchParams({ directory: workspace, providerID: selection.providerId, modelID: selection.modelId, agent: selection.agent,
    ...(selection.variant === null ? {} : { variant: selection.variant }) });
  const preflight = await getJson(origin, `/api/diagnostics/harness/preflight?${preflightQuery}`, 60000);
  const fingerprint = preflight?.runFingerprint ?? null;
  return {
    health: { ok: health?.isOpenCodeReady === true, openCodeStartup: health?.openCodeStartup?.state ?? null, openCodeGeneration: health?.openCodeGeneration ?? null,
      openCodeVersion: health?.openCodeVersion ?? null },
    providers: { listed: (providers?.all ?? []).map(row => row?.id).filter(id => typeof id === 'string'),
      connected: (providers?.connected ?? []).filter(id => typeof id === 'string'),
      openai: { present: Boolean(openai), configured: Array.isArray(providers?.connected) && providers.connected.includes(PROVIDER),
        selectedModelAdvertised: Boolean(openai?.models?.[selection.modelId]), models: Object.keys(openai?.models ?? {}).sort().slice(0, 64),
        signInMethods: Array.isArray(auth?.[PROVIDER]) ? auth[PROVIDER].map(method => ({ type: typeof method?.type === 'string' ? method.type : null,
          label: typeof method?.label === 'string' ? method.label : null })) : [] } },
    fingerprint,
    fingerprintSummary: fingerprint && {
      runtimeVersion: fingerprint.runtimeVersion, runtimeHash: fingerprint.runtimeHash, policySource: fingerprint.policySource, policies: fingerprint.policies,
      role: { source: fingerprint.role?.source ?? null, contentHash: fingerprint.role?.contentHash ?? null, attestedContentHash: fingerprint.role?.attestedContentHash ?? null,
        templateHash: fingerprint.role?.templateHash ?? null, rendererHash: fingerprint.role?.rendererHash ?? null, templatePolicies: fingerprint.role?.templatePolicies ?? null },
      switches: fingerprint.switches, observedPlugins: fingerprint.plugins?.observation ?? null,
      catalog: { availability: fingerprint.catalog?.availability ?? null, count: fingerprint.catalog?.count ?? null },
      configuredPlugins: (fingerprint.plugins?.configured ?? []).map(row => row?.name), configurationHash: fingerprint.configurationHash },
  };
}

export async function runAdaptiveDelegationTrials(options, { ownerHome = os.homedir(), write = line => process.stdout.write(`${JSON.stringify(line)}\n`) } = {}) {
  const keepArtifacts = keepArtifactsRequested({ keep: options.keepArtifacts, argv: [] });
  const artifactRoot = await fs.realpath(options.artifactRoot);
  if (!artifactRoot.startsWith(qaCache + path.sep)) throw fail('qa_trials_artifact_root_invalid');
  // Sealed setup inputs are pinned repository-cache files (live-setup-mirror);
  // profiles, fixtures and the web build snapshot live in OS temp.
  const sealed = createRunRoot({ parent: path.join(qaCache, 'qa'), prefix: 'adaptive-trials-', owner: OWNER, keepArtifacts, argv: [], signals: 'exit' });
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'adaptive-trials-', owner: OWNER, keepArtifacts, argv: [], signals: 'exit' });
  const hosts = new Map(), hostEnvironments = new Map();
  const startHost = arm => hosts.set(arm.id, startOwnedProcess(process.versions.bun ? 'node' : process.execPath,
    [fileURLToPath(new URL('./isolated-host.mjs', import.meta.url))], { cwd: repository, env: hostEnvironments.get(arm.id) }));
  let interrupted = false, wake = null, status = 'failed', restartRequested = false;
  const interrupt = () => { interrupted = true; wake?.(); };
  const requestRestart = () => { restartRequested = true; };
  const check = () => { if (interrupted) throw fail('qa_trials_interrupted'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const sanitizer = createDiagnosticSanitizer({ homeDir: ownerHome, pathMappings: [{ path: run.dir, placeholder: '<QA_RUN>' },
    { path: sealed.dir, placeholder: '<QA_SEALED>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
  const result = { status: 'failed', arms: {}, cleanup: null };
  try {
    write({ stage: 'prepare', runRoot: run.dir, sealedRoot: sealed.dir });
    const manifestPath = path.join(artifactRoot, 'native-bundle.json');
    const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: qaHash(await readQaPinnedFile(manifestPath, undefined, 4 * 1024 * 1024)),
      launcher: path.join(artifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
    result.artifact = { root: artifactRoot, manifestSha256: artifacts.manifestSha256, buildID: artifacts.manifest.buildId };
    check();

    // 1. Credential-free projection of the owner's saved OpenCode setup.
    const inputHome = path.join(sealed.dir, 'input');
    await fs.mkdir(inputHome, { mode: 0o700 });
    const projected = await projectOwnerSetup(ownerHome, inputHome);
    for (const directory of ['home', 'opencode', 'web-config']) await fs.mkdir(path.join(inputHome, directory), { recursive: true, mode: 0o700 });
    const reviewed = { 'reviewed-native.json': { schema: 1, configuration: translateNativeConfiguration({ legacy: {}, agents: {} }), locations: [],
      catalogRequirements: { agents: [], models: [], plugins: [], tools: [] } },
    'reviewed-plugins.json': { schema: 1, plugins: defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins) } };
    const inputFiles = [...projected.files];
    for (const [file, value] of Object.entries(reviewed)) inputFiles.push({ path: file, sha256: await writeSealed(path.join(inputHome, file), JSON.stringify(value) + '\n') });
    const probeInput = { sourceHome: inputHome, artifactRoot, files: inputFiles.sort((a, b) => a.path.localeCompare(b.path)) };
    const mirrorLayout = { reviewedNativeFile: 'reviewed-native.json', reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode',
      webConfigDirectory: 'web-config', homeDirectory: 'home' };
    result.ownerSetup = { files: projected.files.length, skipped: projected.skipped, roots: OWNER_SETUP_ROOTS.map(row => row.source), pinnedFiles: projected.pinned };
    check();

    // 2. Resolve the saved graph through the compiled configuration owner.
    const probeRoot = path.join(run.dir, 'graph-probe'), probeWorkspace = path.join(probeRoot, 'workspace');
    await fs.mkdir(probeRoot, { mode: 0o700 });
    await createFixture(probeWorkspace, probeRoot);
    const probe = await prepareArmBundle({ preparedInput: probeInput, mirror: mirrorLayout, runScope: run.scope, runtimeRoot: path.join(probeRoot, 'runtime'), workspace: probeWorkspace });
    const savedGraph = graphOf(probe.view);
    await fs.rm(probeRoot, { recursive: true, force: true });
    result.roles = savedGraphRoutes(savedGraph);
    // Trials need an OpenAI-only graph and no route is ever substituted. A dry
    // run may still prove the hosts; it reports the routes as trial blockers.
    const foreign = foreignGraphRoutes(savedGraph), offGraph = trialGraphMismatches(savedGraph);
    result.trialBlockers = [...(foreign.length ? [{ code: 'qa_trials_foreign_provider_routes', routes: foreign }] : []),
      ...(offGraph.length ? [{ code: 'qa_trials_graph_not_pinned', routes: offGraph }] : [])];
    if (result.trialBlockers.length && !options.dryRun) throw fail(result.trialBlockers[0].code, { blockers: result.trialBlockers });
    const selection = selectionFromGraph(savedGraph, options.agent);
    const helper = helperSelection(selection, options.helperModel ?? TRIAL_GRAPH.helper);
    result.selection = selection; result.helperModelSelection = helper;
    check();

    // 3. Seal the mirror once through the reviewed mirror owner.
    const inputFile = path.join(sealed.dir, 'input.json'), graphFile = path.join(sealed.dir, 'graph.json');
    const inputSha256 = await writeSealed(inputFile, JSON.stringify({ preparedInput: { sourceHome: inputHome, files: projected.files } }) + '\n');
    const graphSha256 = await writeSealed(graphFile, JSON.stringify(savedGraph) + '\n');
    const sealedMirror = await prepareLiveSetupMirror({ inputFile, inputSha256, graphFile, graphSha256, artifactRoot, outputRoot: path.join(sealed.dir, 'mirror') });
    const mirror = JSON.parse(await readQaPinnedFile(sealedMirror.preparationFile, sealedMirror.sha256, 4 * 1024 * 1024));
    result.mirror = { sha256: sealedMirror.sha256, inputDigest: mirror.inputDigest, files: sealedMirror.files, disabledMcpEntries: mirror.disabledMcpEntries };
    check();

    // 4. One snapshot of the current web build for both arms.
    const distDirectory = path.join(run.dir, 'web-dist');
    cloneTree(path.join(repository, 'packages/web/dist'), distDirectory);
    result.webBuild = await hashTree(distDirectory);
    check();

    // 5. Per arm: identical fixture and bundle from the same sealed mirror.
    for (const arm of TRIAL_ARMS) {
      const armRoot = path.join(run.dir, arm.id), workspace = path.join(armRoot, 'fixture'), runtimeRoot = path.join(armRoot, 'runtime');
      await fs.mkdir(armRoot, { mode: 0o700 });
      const fixtureHash = await createFixture(workspace, armRoot);
      const bundle = await prepareArmBundle({ preparedInput: mirror.preparedInput, mirror: mirror.mirror, runScope: run.scope, runtimeRoot, workspace });
      if (!isDeepStrictEqual(graphOf(bundle.view), savedGraph)) throw fail('qa_trials_saved_graph_changed', { arm: arm.id });
      await bundle.store.verify({ bundleID: 'candidate', phase: 'resume' });
      const launch = bundle.binding.descriptor.launch;
      await fs.writeFile(path.join(launch.webDataDirectory, 'settings.json'), JSON.stringify({ lastDirectory: workspace, homeDirectory: workspace,
        helperModelSelection: helper }) + '\n', { mode: 0o600 });
      const env = armLaunchEnvironment(bundle.env, arm, { distDirectory, gitCeiling: armRoot });
      result.arms[arm.id] = { adaptiveDelegation: arm.adaptiveDelegation, fixtureRoot: workspace, fixtureHash, runtimeRoot, roles: savedGraphRoutes(graphOf(bundle.view)),
        journal: path.join(launch.webDataDirectory, 'harness/journal'), bundleID: bundle.binding.descriptor.bundleID, env };
      check();
    }
    if (result.arms.baseline.fixtureHash !== result.arms.candidate.fixtureHash) throw fail('qa_trials_fixture_mismatch');

    // 6. Start both hosts and wait for native readiness.
    for (const arm of TRIAL_ARMS) {
      const row = result.arms[arm.id];
      hostEnvironments.set(arm.id, row.env);
      startHost(arm);
      delete row.env;
    }
    write({ stage: 'starting', arms: TRIAL_ARMS.map(arm => arm.id) });
    const ready = await Promise.all(TRIAL_ARMS.map(arm => waitForNativeReady(hosts.get(arm.id), result.arms[arm.id].runtimeRoot, check)));
    check();

    // 7. Verify each arm read-only, then compare the fingerprints.
    const fingerprints = {};
    for (const [index, arm] of TRIAL_ARMS.entries()) {
      const row = result.arms[arm.id];
      row.origin = ready[index].origin;
      const inspection = await inspectArm({ origin: row.origin, workspace: row.fixtureRoot, selection });
      fingerprints[arm.id] = inspection.fingerprint;
      Object.assign(row, { health: inspection.health, providers: inspection.providers, fingerprint: inspection.fingerprintSummary });
      if (!inspection.health.ok) throw fail('qa_trials_health_failed', { arm: arm.id });
      // Before sign-in OpenAI is offered only through its sign-in methods; the
      // catalog lists it once an account exists. The eval's own availability
      // preflight refuses an unavailable model after sign-in.
      if (!inspection.providers.openai.signInMethods.length || inspection.providers.openai.configured) {
        throw fail('qa_trials_openai_sign_in_unavailable', { arm: arm.id, providers: inspection.providers });
      }
      if (inspection.providers.openai.present && !inspection.providers.openai.selectedModelAdvertised
        && !result.trialBlockers.some(row => row.code === 'qa_trials_selected_model_unadvertised')) {
        result.trialBlockers.push({ code: 'qa_trials_selected_model_unadvertised', model: `${selection.providerId}/${selection.modelId}`,
          advertised: inspection.providers.openai.models });
      }
    }
    result.comparison = compareArmFingerprints(fingerprints);
    write({ stage: 'inspected', arms: Object.fromEntries(TRIAL_ARMS.map(arm => [arm.id, { health: result.arms[arm.id].health,
      providers: result.arms[arm.id].providers, fingerprint: result.arms[arm.id].fingerprint }])), comparison: result.comparison });
    if (!result.comparison.matched) {
      result.trialBlockers.push({ code: 'qa_trials_fingerprint_mismatch', reasons: result.comparison.reasons, derivationIssues: result.comparison.derivationIssues });
      if (!options.dryRun) throw fail('qa_trials_fingerprint_mismatch', { comparison: result.comparison });
    }
    check();

    for (const arm of TRIAL_ARMS) {
      const row = result.arms[arm.id];
      write({ arm: arm.id, DEVRYAN_ADAPTIVE_DELEGATION: arm.adaptiveDelegation, origin: row.origin, providersUrl: `${row.origin}/?settings=providers`,
        journal: row.journal, fixtureRoot: row.fixtureRoot, roles: row.roles.map(route => `${route.kind}:${route.role}${route.index === undefined ? '' : `#${route.index}`}=${route.model}@${route.variant ?? 'default'}`), policy: { adaptiveDelegation: row.fingerprint.policies.adaptiveDelegation, source: row.fingerprint.policySource },
        openai: row.providers.openai, evalConfig: { devRyanBaseUrl: row.origin, fixtureRoot: row.fixtureRoot, providerId: selection.providerId,
          modelId: selection.modelId, agent: selection.agent, variant: selection.variant } });
    }
    write({ stage: 'verified', trialReady: result.trialBlockers.length === 0, trialBlockers: result.trialBlockers, pinnedGraph: TRIAL_GRAPH, artifact: result.artifact, ownerSetup: result.ownerSetup, roles: result.roles, helperModelSelection: helper, webBuild: result.webBuild, mirror: result.mirror,
      fixtureHash: result.arms.baseline.fixtureHash, comparison: result.comparison, providers: Object.fromEntries(TRIAL_ARMS.map(arm => [arm.id, result.arms[arm.id].providers])),
      fingerprints: Object.fromEntries(TRIAL_ARMS.map(arm => [arm.id, result.arms[arm.id].fingerprint])) });

    if (options.dryRun) { status = 'passed'; return result; }
    write({ stage: 'holding', message: 'Sign in to OpenAI in each providersUrl. The launcher re-verifies both fingerprints once both arms are signed in; run bun run agent:eval after that line. Press Ctrl-C to stop both hosts and remove every created file.' });
    // After the owner signs in to both arms, the tool catalog becomes
    // observable: compare once more, read-only, and report the result.
    let signedInVerified = false, verifying = false;
    const verifySignedIn = async () => {
      if (signedInVerified || verifying) return;
      verifying = true;
      try {
        const connected = await Promise.all(TRIAL_ARMS.map(arm => getJson(result.arms[arm.id].origin,
          `/api/provider?directory=${encodeURIComponent(result.arms[arm.id].fixtureRoot)}`).then(body => Array.isArray(body?.connected) && body.connected.includes(PROVIDER))));
        if (!connected.every(Boolean)) return;
        const inspections = await Promise.all(TRIAL_ARMS.map(arm => inspectArm({ origin: result.arms[arm.id].origin, workspace: result.arms[arm.id].fixtureRoot, selection })));
        signedInVerified = true;
        const comparison = compareArmFingerprints(Object.fromEntries(TRIAL_ARMS.map((arm, index) => [arm.id, inspections[index].fingerprint])));
        const advertised = inspections.every(row => row.providers.openai.selectedModelAdvertised);
        result.signedInComparison = comparison;
        write({ stage: 'signed-in-verification', trialReady: comparison.matched && advertised, selectedModelAdvertised: advertised, comparison,
          fingerprints: Object.fromEntries(TRIAL_ARMS.map((arm, index) => [arm.id, inspections[index].fingerprintSummary])) });
      } catch (error) {
        write({ stage: 'signed-in-verification', error: error.code ?? 'qa_trials_verification_failed' });
      } finally { verifying = false; }
    };
    // SIGUSR2 restarts both hosts in place after a host-side code change, with
    // the same environments and run roots; the new origins are printed.
    process.on('SIGUSR2', requestRestart);
    // A failed restart never ends the run: its root and sign-ins stay while the
    // hosts are down, until another SIGUSR2 retries or Ctrl-C removes them.
    let restarting = false, restartBroken = false;
    const restartHosts = async () => {
      restarting = true; restartRequested = false;
      try {
        write({ stage: 'restarting', arms: TRIAL_ARMS.map(arm => arm.id) });
        const { origins, unverifiedCleanup } = await restartTrialHosts({ arms: TRIAL_ARMS, hosts, startHost,
          removeReady: arm => fs.rm(path.join(result.arms[arm.id].runtimeRoot, 'ready.json'), { force: true }),
          waitReady: (arm, host) => waitForNativeReady(host, result.arms[arm.id].runtimeRoot, check) });
        for (const arm of TRIAL_ARMS) result.arms[arm.id].origin = origins[arm.id];
        signedInVerified = false; restartBroken = false;
        if (unverifiedCleanup.length) (result.unverifiedRestartCleanup ??= []).push(...unverifiedCleanup);
        write({ stage: 'restarted', arms: Object.fromEntries(TRIAL_ARMS.map(arm => [arm.id, { origin: origins[arm.id],
          providersUrl: `${origins[arm.id]}/?settings=providers` }])), ...(unverifiedCleanup.length ? { unverifiedCleanup } : {}) });
      } finally { restarting = false; }
    };
    await new Promise(resolve => {
      let ticks = 0;
      const timer = setInterval(() => {
        if (restarting) return;
        if (restartRequested) {
          void restartHosts().catch(error => {
            restartBroken = true;
            (result.restartFailures ??= []).push(error.code ?? 'qa_trials_restart_failed');
            write({ stage: 'restart-failed', code: error.code ?? 'qa_trials_restart_failed',
              ...(error.details ? { details: sanitizer.sanitizeExportValue(error.details) } : {}),
              message: 'The hosts are down; the run root and its sign-ins are kept. Send SIGUSR2 to retry, or press Ctrl-C to stop and remove every created file.' });
          });
          return;
        }
        if (restartBroken) return;
        for (const [id, host] of hosts) {
          try { host.check(); } catch { result.hostExited ??= id; finish(); }
        }
        if (++ticks % 5 === 0) void verifySignedIn();
      }, 2000);
      const finish = () => { clearInterval(timer); wake = null; resolve(); };
      wake = finish;
      if (interrupted) finish();
    });
    if (result.hostExited) throw fail('qa_trials_host_exited', { arm: result.hostExited });
    status = 'passed';
    return result;
  } catch (error) {
    status = interrupted ? 'interrupted' : 'failed';
    result.failure = { code: error.code ?? null, message: sanitizer.sanitizeText(String(error.message)).slice(0, 512),
      ...(error.details ? { details: sanitizer.sanitizeExportValue(error.details) } : {}) };
    for (const [id, host] of hosts) result.arms[id] && (result.arms[id].startupCodes = [...new Set(host.getLog().match(/(?:native|context|execution|mutation|opencode)_[a-z_0-9]+/g) ?? [])].slice(0, 32));
    return result;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); process.off('SIGUSR2', requestRestart);
    const cleanup = { hosts: {}, failures: [] };
    for (const [id, host] of hosts) {
      try { const evidence = await host.stop(); cleanup.hosts[id] = { stopped: true, exitCode: evidence.exitCode, exitSignal: evidence.exitSignal, shutdownDurationMs: evidence.shutdownDurationMs }; }
      catch (error) { cleanup.hosts[id] = { stopped: false }; cleanup.failures.push({ arm: id, message: sanitizer.sanitizeText(String(error.message)).slice(0, 256) }); }
    }
    if (cleanup.failures.length && status === 'passed') status = 'failed';
    result.status = status;
    for (const root of [run, sealed]) {
      try { root.finish(status); } catch (error) { cleanup.failures.push({ root: root.dir, message: String(error.message).slice(0, 256) }); }
    }
    cleanup.removed = [run.dir, sealed.dir].filter(dir => !existsSync(dir));
    cleanup.remaining = [run.dir, sealed.dir].filter(dir => existsSync(dir));
    cleanup.keptArtifacts = keepArtifacts;
    if (cleanup.remaining.length && !keepArtifacts) { result.status = 'failed'; }
    result.cleanup = cleanup;
    write({ stage: 'stopped', status: result.status, failure: result.failure ?? null, ...(result.failure && result.roles ? { roles: result.roles } : {}), cleanup });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let options;
  try { options = parseTrialArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.details ?? error.message}\n`); process.exit(2); }
  const result = await runAdaptiveDelegationTrials(options);
  // 3: the hosts and cleanup passed, but the arms are not ready for trials.
  process.exitCode = result.status !== 'passed' ? 1 : result.trialBlockers?.length ? 3 : 0;
}
