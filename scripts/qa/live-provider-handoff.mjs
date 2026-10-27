// Persistent attended sign-in and explicitly qualified exercise. No account copying.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { prepareQaNativeBundle, createQaNativeLaunchEnvironment } from './native-profile-preparation.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { createLiveOwnerLink, waitLiveOwnerAttendance, settleLiveOwnerChild } from './live-credential-owner.mjs';
import { assertQaPrivateDirectory, readQaPinnedFile } from './live-setup-mirror.mjs';
import { createRunRoot } from './run-root.mjs';
import { waitForQaHostReady } from './host-readiness.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { defaultNativeRegistrations } from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';
import { DEFAULT_HELPER_MODEL_SELECTION } from '../../packages/shared-runtime/lib/helper-model-selection.js';
import { nativeUpgradeBundleID } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-lifecycle.js';
import { canonicalJSON } from '../../packages/web/server/lib/opencode/runtime-host/bundle-migration-inventory.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { isClaudeInspectionUnavailable } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-inspection.js';
import { writeFileAtomic, withCrossProcessFileLock } from '../../packages/harness-runtime/lib/atomic-file.js';
import { readRuntimeUiLease } from './native-backend-ui-diagnostic.mjs';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const finiteCode = error => /^(?:qa|native|bundle)_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'qa_handoff_failed';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
// The existing owner-session transport remains the only caller. Apply can await
// the managed runtime's readiness window; all other request budgets stay fixed.
export function qa1ExerciseRequestTimeout(pathname, method) {
  if (method === 'POST' && pathname === '/api/config/apply') return 40000;
  return method === 'POST' && pathname === '/api/provider/cursor-acp/configure' ? 25000 : 10000;
}

const qa1ExerciseHttpOperations = new Map([
  ['GET /api/provider', 'provider_catalog'],
  ['GET /api/config/providers', 'feature_providers'],
  ['GET /api/provider/cursor-acp/runtime-status', 'cursor_runtime_status'],
  ['POST /api/provider/cursor-acp/configure', 'cursor_configure'],
  ['GET /api/config/settings', 'settings_read'],
  ['PUT /api/config/settings', 'settings_update'],
  ['GET /api/session/status', 'session_status'],
  ['POST /api/opencode/directory', 'directory_activate'],
  ['GET /api/agent', 'agent_catalog'],
  ['GET /api/config/agent-overrides', 'agent_overrides'],
  ['GET /api/config/apply-status', 'config_apply_status'],
  ['PUT /api/config/agents/explorer/override', 'explorer_override_save'],
  ['DELETE /api/config/agents/explorer/override', 'explorer_override_delete'],
  ['POST /api/session', 'session_create'],
  ['GET /api/orchestration/snapshot', 'orchestration_snapshot'],
  ['POST /api/git/commit-message/draft', 'commit_message_draft'],
  ['POST /api/git/pr-description', 'pr_description'],
]);

export function qa1ExerciseHttpFailure(pathname, method, status) {
  if (method === 'POST' && pathname === '/api/config/apply') return status === 409
    ? 'qa_profile_explorer_apply_revision_conflict' : 'qa_profile_explorer_apply_failed';
  if (status === 404) return 'qa_profile_api_not_found';
  const operation = typeof pathname === 'string' && typeof method === 'string'
    ? qa1ExerciseHttpOperations.get(`${method} ${pathname}`) : undefined;
  return operation && Number.isInteger(status) && status >= 400 && status <= 599
    ? `qa_profile_api_${operation}_${status}` : 'qa_profile_api_failed';
}

export function projectHandoffChildRefusal(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'code,status'
    || value.status !== 'refused' || typeof value.code !== 'string' || finiteCode(value) !== value.code) return null;
  return { status: 'refused', code: value.code };
}
async function sendHandoffChildRefusal(error) {
  if (process.connected) await new Promise(resolve => process.send({ status: 'refused', code: finiteCode(error) }, () => resolve()));
}
export function createHandoffChildLifetime(channel, controller) {
  const stop = () => controller.abort(fail('qa_handoff_closed'));
  let settle;
  const stopped = new Promise(resolve => { settle = resolve; });
  controller.signal.addEventListener('abort', settle, { once: true });
  for (const event of ['disconnect', 'SIGINT', 'SIGTERM']) channel.once(event, stop);
  if (!channel.connected || controller.signal.aborted) { stop(); settle(); }
  return { stopped, assertCurrent: () => controller.signal.throwIfAborted(),
    dispose: () => {
      for (const event of ['disconnect', 'SIGINT', 'SIGTERM']) channel.off(event, stop);
      controller.signal.removeEventListener('abort', settle);
    } };
}
export async function cleanupHandoffChildResources({ link, handle, primaryError }) {
  const failures = [];
  for (const cleanup of [() => link?.close(), () => handle?.stop({ exitProcess: false })]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw Object.assign(new AggregateError(primaryError ? [primaryError, ...failures] : failures,
    'Handoff child cleanup failed', { cause: primaryError ?? failures[0] }),
  { code: primaryError ? finiteCode(primaryError) : 'qa_handoff_cleanup_failed' });
}
export function assertHandoffUpgradeSettlement(result, receipt, refusal) {
  if (result.teardown !== 'passed') throw fail('qa_handoff_upgrade_unconfirmed');
  const projected = projectHandoffChildRefusal(refusal);
  if (projected) throw fail(projected.code);
  if (result.exitCode !== 0 || !receipt) throw fail('qa_handoff_upgrade_unconfirmed');
}
const currentProfileFile = path.join(repository, '.cache/qa/provider-handoff-current.json');
const profileOwner = 'scripts/qa/live-provider-handoff.mjs';
export const providerHandoffRunParent = path.dirname(currentProfileFile);

// This selector names a retained profile; it confers no runtime/account grant.
export async function readRegisteredProviderHandoff(file = currentProfileFile) {
  await assertQaPrivateDirectory(path.dirname(file));
  let bytes; try { bytes = await readQaPinnedFile(file, undefined, 4096); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(bytes);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'labels,owner,root,schema,stateFile'
    || value.schema !== 1 || value.owner !== profileOwner || value.stateFile !== path.join(value.root ?? '', 'handoff.json')
    || !value.labels || Object.keys(value.labels).sort().join(',') !== 'profile,qa'
    || value.labels.profile !== 'V1' || value.labels.qa !== 'QA1') throw fail('qa_handoff_registration_invalid');
  await pinProviderHandoff(value.root);
  const state = await readHandoffDocument(value.stateFile);
  if (state.root !== value.root) throw fail('qa_handoff_registration_invalid');
  return value;
}

export async function registerProviderHandoffProfile(stateFile, file = currentProfileFile, fsApi = fs) {
  const root = path.dirname(stateFile);
  if (stateFile !== path.join(root, 'handoff.json')) throw fail('qa_handoff_registration_invalid');
  await readHandoffDocument(stateFile);
  await pinProviderHandoff(root); await assertQaPrivateDirectory(path.dirname(file));
  const value = { schema: 1, owner: profileOwner, root, stateFile, labels: { profile: 'V1', qa: 'QA1' } };
  const temporary = path.join(path.dirname(file), `.provider-handoff-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync();
    await handle.close(); handle = undefined;
    try { await fsApi.link(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    await handle?.close(); await fsApi.rm(temporary, { force: true });
    const directory = await fsApi.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  const current = await readRegisteredProviderHandoff(file);
  if (current.stateFile !== stateFile) throw fail('qa_handoff_profile_already_registered');
  return current;
}

export function projectHandoffProviderStatus(value) {
  const record = input => input !== null && typeof input === 'object' && !Array.isArray(input);
  if (!record(value) || !Array.isArray(value.connected) || value.connected.some(id => typeof id !== 'string')
    || !Array.isArray(value.all) || value.catalogIncomplete !== undefined && typeof value.catalogIncomplete !== 'boolean') throw fail('qa_handoff_catalog_invalid');
  const providers = new Map();
  for (const row of value.all) {
    if (!record(row) || typeof row.id !== 'string' || providers.has(row.id) || !record(row.models)) throw fail('qa_handoff_catalog_invalid');
    providers.set(row.id, Object.keys(row.models).length);
  }
  const ids = ['openai', 'cursor-acp', 'opencode', 'anthropic'];
  return { catalogConnected: Object.fromEntries(ids.map(id => [id, value.connected.includes(id)])),
    modelCounts: Object.fromEntries(ids.map(id => [id, providers.get(id) ?? 0])), catalogIncomplete: value.catalogIncomplete ?? false };
}

export function projectHandoffClaudeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.installed !== 'boolean' || typeof value.loggedIn !== 'boolean'
    || !['authenticated', 'unavailable'].includes(value.authStatus)
    || value.authStatus === 'authenticated' && (!value.installed || !value.loggedIn || value.errorCode !== undefined && value.errorCode !== null)
    || value.authStatus === 'unavailable' && (value.loggedIn || !isClaudeInspectionUnavailable(value.errorCode))) throw fail('qa_handoff_claude_status_invalid');
  return { installed: value.installed, loggedIn: value.loggedIn, authStatus: value.authStatus,
    ...(value.authStatus === 'unavailable' ? { errorCode: value.errorCode } : {}) };
}

export function assertHandoffJournalScope(input, ownedSessions, ownedDirectories) {
  if (!input || Object.keys(input).sort().join(',') !== 'directory,sessionIDs,since,until' || !Array.isArray(input.sessionIDs)
    || !input.sessionIDs.length || input.sessionIDs.length > 64 || new Set(input.sessionIDs).size !== input.sessionIDs.length
    || input.sessionIDs.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value) || !ownedSessions.has(value))
    || typeof input.directory !== 'string' || !ownedDirectories.has(input.directory)
    || !Number.isSafeInteger(input.since) || input.since < 0 || !Number.isSafeInteger(input.until)
    || input.until < input.since || input.until - input.since > 3600000) throw fail('qa_profile_journal_scope_invalid');
}

export function parseHandoffCommand(line) {
  if (Buffer.byteLength(line) > 1024) throw fail('qa_handoff_command_invalid');
  let input; try { input = JSON.parse(line); } catch { throw fail('qa_handoff_command_invalid'); }
  if (!input || Array.isArray(input) || Object.keys(input).length !== 1
    || !['status', 'owner-link', 'restart', 'close', 'exercise', 'qualify-providers'].includes(input.command)) throw fail('qa_handoff_command_invalid');
  return input.command;
}

export function handoffSetup(workspace) {
  const primary = { model: 'openai/gpt-6-astra', variant: 'medium' };
  const agents = { builder: primary, orchestrator: primary,
    explorer: { model: 'cursor-acp/grok-4.6', variant: 'medium' } };
  const legacy = { model: primary.model, default_agent: 'orchestrator', agent: agents, plugin: [], mcp: {} };
  return { agents, legacy, settings: { projects: [{ id: 'independent-live-qa', path: workspace, name: 'Independent provider QA' }],
    lastDirectory: workspace, homeDirectory: workspace, defaultAgent: 'orchestrator', defaultModel: primary.model,
    helperModelSelection: DEFAULT_HELPER_MODEL_SELECTION, showReasoningTraces: true, desktopLanAccessEnabled: false } };
}

export async function pinProviderHandoff(root) {
  await assertQaPrivateDirectory(root);
  const run = JSON.parse(await readQaPinnedFile(path.join(root, 'run.json'), undefined, 65536));
  if (run.schemaVersion !== 1 || run.owner !== 'scripts/qa/live-provider-handoff.mjs') throw fail('qa_handoff_identity_invalid');
  const file = path.join(root, 'storage-retention.json');
  const retention = { schemaVersion: 1, owner: run.owner, pinned: true, payloadState: 'ready',
    purpose: 'reusable-provider-profile', createdAt: run.createdAt };
  try { await fs.writeFile(file, JSON.stringify(retention, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error;
    const current = JSON.parse(await readQaPinnedFile(file, undefined, 65536));
    if (current.schemaVersion !== 1 || current.owner !== retention.owner || current.pinned !== true
      || current.payloadState !== 'ready' || current.purpose !== retention.purpose) throw fail('qa_handoff_retention_invalid');
  }
}

export async function prepareProviderHandoff({ artifactRoot, root }) {
  await assertQaPrivateDirectory(root); await assertQaPrivateDirectory(artifactRoot);
  await pinProviderHandoff(root);
  const mirror = path.join(root, 'mirror'), runtimeRoot = path.join(root, 'runtime'), workspace = path.join(root, 'workspace');
  for (const directory of [mirror, runtimeRoot, workspace, path.join(mirror, 'opencode'), path.join(mirror, 'web')]) await fs.mkdir(directory, { mode: 0o700 });
  const { legacy, agents, settings } = handoffSetup(workspace);
  const artifactBytes = await readQaPinnedFile(path.join(artifactRoot, 'native-bundle.json'), undefined, 4 * 1024 * 1024);
  const artifact = JSON.parse(artifactBytes);
  const files = {
    'opencode/opencode.json': legacy, 'opencode/.devryan/config.json': { agentOverrides: agents }, 'web/settings.json': settings,
    'reviewed-native.json': { schema: 1, configuration: translateNativeConfiguration({ legacy, agents }), locations: [],
      catalogRequirements: { agents: ['orchestrator'], tools: ['read'], plugins: [], models: [] } },
    'reviewed-plugins.json': { schema: 1, plugins: defaultNativeRegistrations(artifact.inputs.reviewedPlugins) },
  };
  const inventory = [];
  for (const [relative, value] of Object.entries(files)) {
    const bytes = JSON.stringify(value) + '\n', file = path.join(mirror, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    inventory.push({ path: relative, sha256: hash(bytes) });
  }
  const preparedInput = { sourceHome: mirror, artifactRoot, files: inventory };
  const factory = await createQaNativePreparationFactory({ preparedInput, mirror: { reviewedNativeFile: 'reviewed-native.json',
    reviewedPluginFile: 'reviewed-plugins.json', opencodeConfigDirectory: 'opencode', webConfigDirectory: 'web' },
  bootstrapCredentials: async () => { throw fail('qa_handoff_snapshot_not_authorized'); } });
  const source = await factory.prepareSource({ runtimeRoot, workspace, sourceHome: mirror, artifactRoot });
  await fs.writeFile(path.join(source.launch.webDataDirectory, 'settings.json'), JSON.stringify(settings) + '\n', { flag: 'wx', mode: 0o600 });
  const { binding } = await prepareQaNativeBundle({ runtimeRoot, source, bundleID: 'independent-signin' });
  await fs.writeFile(path.join(binding.descriptor.launch.global.home, '.devryan-qa-home'), 'Independent attended provider sign-in\n', { flag: 'wx', mode: 0o600 });
  const gitTemplate = path.join(root, 'git-template'); await fs.mkdir(gitTemplate, { mode: 0o700 });
  for (const directory of [workspace, binding.descriptor.launch.global.home]) await promisify(execFile)('/usr/bin/git',
    ['init', '--quiet', '--initial-branch=main', `--template=${gitTemplate}`], { cwd: directory, timeout: 10000,
      env: createQaHostLaunchEnvironment({ HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: root }) });
  const state = { schema: 1, root, runtimeRoot, workspace, controlRoot: binding.controlRoot, bundleID: binding.descriptor.bundleID,
    artifactRoot, buildID: artifact.buildId, artifactManifestSha256: hash(artifactBytes), purpose: 'provider-signin-only-no-inference-no-account-copy' };
  const stateFile = path.join(root, 'handoff.json'); await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { state, stateFile };
}

async function readHandoffDocument(stateFile) {
  const state = JSON.parse(await readQaPinnedFile(stateFile, undefined, 65536));
  if (!state || Array.isArray(state) || Object.keys(state).some(key => !['schema', 'root', 'runtimeRoot', 'workspace', 'controlRoot', 'bundleID', 'artifactRoot', 'buildID', 'artifactManifestSha256', 'purpose'].includes(key))
    || state.schema !== 1 || state.purpose !== 'provider-signin-only-no-inference-no-account-copy'
    || stateFile !== path.join(state.root, 'handoff.json') || state.runtimeRoot !== path.join(state.root, 'runtime')
    || state.workspace !== path.join(state.root, 'workspace') || state.controlRoot !== path.join(state.runtimeRoot, 'native-bundles')) throw fail('qa_handoff_identity_invalid');
  return state;
}

async function readState(stateFile, pending) {
  const state = await readHandoffDocument(stateFile);
  for (const directory of [state.root, state.runtimeRoot, state.workspace, state.controlRoot, state.artifactRoot]) await assertQaPrivateDirectory(directory);
  await pinProviderHandoff(state.root);
  const artifact = await readQaPinnedFile(path.join(state.artifactRoot, 'native-bundle.json'), state.artifactManifestSha256, 4 * 1024 * 1024);
  if (JSON.parse(artifact).buildId !== state.buildID) throw fail('qa_handoff_identity_invalid');
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: state.controlRoot });
  if (binding.admission === 'held') throw fail('qa_handoff_identity_invalid');
  if (binding.descriptor.bundleID !== state.bundleID) {
    if (!pending) throw fail('qa_handoff_identity_invalid');
    assertHandoffUpgradeLineage({ state, binding, pending });
  }
  return { state, binding };
}

export function assertHandoffUpgradeLineage({ state, binding, pending }) {
  const selection = binding?.selection, descriptor = binding?.descriptor;
  if (!pending || !Number.isSafeInteger(pending.sourceRevision) || pending.sourceRevision < 1
    || !/^[a-f0-9]{64}$/.test(pending.targetManifestSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(pending.projectMapSha256 ?? '')
    || pending.sourceBundleID !== state.bundleID || binding?.controlRoot !== state.controlRoot
    || selection?.selectedBundleID !== nativeUpgradeBundleID(pending.targetManifestSha256, pending.sourceRevision)
    || selection.previousBundleID !== state.bundleID || selection.revision !== pending.sourceRevision + 1
    || selection.transition !== 'activate' || selection.reconciliationRequired || binding.admission === 'held'
    || descriptor?.bundleID !== selection.selectedBundleID || descriptor.sourceBundleID !== state.bundleID
    || descriptor.checkpoint?.ownerID !== state.bundleID || descriptor.checkpoint?.generation !== 2
    || descriptor.launch?.artifactManifestSha256 !== pending.targetManifestSha256
    || hash(canonicalJSON(descriptor.projectMap)) !== pending.projectMapSha256) throw fail('qa_handoff_upgrade_lineage_invalid');
  return { bundleID: descriptor.bundleID, revision: selection.revision };
}

async function readUpgradeTarget(stateFile, target) {
  if (!target || Object.keys(target).sort().join(',') !== 'targetArtifactRoot,targetBuildID,targetManifestSha256'
    || ['targetBuildID', 'targetManifestSha256'].some(key => !/^[a-f0-9]{64}$/.test(target[key] ?? '')))
    throw fail('qa_handoff_upgrade_target_invalid');
  await assertQaPrivateDirectory(target.targetArtifactRoot);
  const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath: path.join(target.targetArtifactRoot, 'native-bundle.json'),
    manifestSha256: target.targetManifestSha256,
    launcher: path.join(target.targetArtifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
  if (artifacts.manifest.buildId !== target.targetBuildID) throw fail('qa_handoff_upgrade_target_invalid');
  const state = await readHandoffDocument(stateFile);
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: state.controlRoot });
  // This handoff factory has one identity-mapped workspace. Native selected,
  // previous, source and checkpoint proofs recover a committed transition;
  // no mutable intent file or serialized grant is needed.
  return { ...target, sourceBundleID: state.bundleID,
    sourceRevision: binding.selection.revision - (binding.descriptor.bundleID === state.bundleID ? 0 : 1),
    projectMapSha256: hash(canonicalJSON([{ sourceDirectory: state.workspace, targetDirectory: state.workspace, mode: 'identity' }])) };
}

async function runChild(stateFile, target, qualificationReport) {
  let checkpoint, checkpointCount = 0, ownerAdmissions = 0, validatedAdmissions = 0, link, handle, onMessage, closed, readConnections, exerciseAPI, authenticateExerciseBrowser, exerciseJournal, exerciseWork, pendingExercise, mediumSample, primaryError, ownerExitCode = 0;
  const exerciseLifetime = new AbortController();
  const lifetime = createHandoffChildLifetime(process, exerciseLifetime);
  const check = () => { lifetime.assertCurrent(); if (closed) throw fail('qa_handoff_closed'); };
  const send = value => { if (process.connected) process.send(value, () => {}); };
  const close = () => closed ??= (async () => {
    exerciseLifetime.abort(fail('qa_profile_exercise_cancelled'));
    await Promise.allSettled([exerciseWork]);
    let cleanupError;
    try { await cleanupHandoffChildResources({ link, handle, primaryError }); }
    catch (error) { cleanupError = error; ownerExitCode = 1; }
    checkpoint = undefined; readConnections = undefined; exerciseAPI = undefined; authenticateExerciseBrowser = undefined; exerciseJournal = undefined; pendingExercise = undefined; mediumSample = undefined;
    if (handle || link) send({ status: 'owner-returned', exitCode: ownerExitCode });
    if (cleanupError) throw cleanupError;
  })();
  try {
    check();
    await waitLiveOwnerAttendance();
    check();
    const pending = target ? await readUpgradeTarget(stateFile, target) : undefined;
    check();
    const { state, binding } = await readState(stateFile, pending);
    check();
    if (process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT !== state.controlRoot || process.env.DEVRYAN_QA_RUNTIME_ROOT !== state.runtimeRoot
      || process.env.HOME !== binding.descriptor.launch.global.home) throw fail('qa_handoff_environment_invalid');
    if (pending && process.env.DEVRYAN_EXECUTION_ARTIFACTS !== pending.targetArtifactRoot) throw fail('qa_handoff_environment_invalid');
    await import('./isolated-home.mjs');
    check();
    const { startWebUiServer } = await import('../../packages/web/server/index.js');
    check();
    const ownedExerciseSessions = new Set(), ownedExerciseDirectories = new Set([state.workspace]);
    const safeSessionID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
    handle = await startWebUiServer({ host: '127.0.0.1', port: 0, attachSignals: false, exitOnShutdown: false,
      nativeClaudeSecurityHome: userInfo().homedir,
      retainRuntimeBundleCheckpoint: value => { if (++checkpointCount !== 1 || !Object.isFrozen(value)
        || Object.keys(value).some(key => !['ownerID', 'controlRoot', 'withHeldCheckpoint'].includes(key))
        || typeof value.withHeldCheckpoint !== 'function'
        || value.ownerID !== binding.descriptor.bundleID || value.controlRoot !== state.controlRoot) throw fail('qa_handoff_checkpoint_invalid'); checkpoint = value; } });
    // Adopt a late-returning handle before observing stop; finally still owns its cleanup.
    check();
    const origin = `http://127.0.0.1:${handle.getPort()}`;
    await waitForQaHostReady({ origin, checkAlive: check });
    check();
    if (checkpointCount !== 1 || !checkpoint || !handle.isReady()) throw fail('qa_handoff_checkpoint_invalid');
    if (pending) {
      if (binding.descriptor.bundleID === state.bundleID) {
        if (binding.selection.revision !== pending.sourceRevision || hash(canonicalJSON(binding.descriptor.projectMap)) !== pending.projectMapSha256)
          throw fail('qa_handoff_upgrade_lineage_invalid');
        const result = await handle.runtimeBundle.upgrade({ expectedRevision: pending.sourceRevision });
        check();
        if (result.state !== 'restart_required' || result.transition !== 'upgrade' || !result.restartRequired)
          throw fail('qa_handoff_upgrade_lineage_invalid');
      }
      // Fresh host startup verifies a recovered committed target before this
      // receipt. CLI pins alone never admit or edit a descriptor.
      const current = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: state.controlRoot });
      const proof = assertHandoffUpgradeLineage({ state, binding: current, pending });
      check(); send({ status: 'upgrade-committed', ...proof });
      return;
    }
    check();
    link = await createLiveOwnerLink({ handle: { issueLocalOwnerSession: async () => {
      check();
      const cookie = await handle.issueLocalOwnerSession();
      check();
      // The original issuer's memory-only cookie remains within this owned
      // callback. Only fixed-provider flags/counts and typed Claude status cross IPC.
      readConnections = async () => {
        const inspect = async (route, project, code) => {
          const response = await fetch(`${origin}${route}?directory=${encodeURIComponent(state.workspace)}`, {
            headers: { Cookie: `${cookie.name}=${cookie.value}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) { await response.body?.cancel(); throw fail(code); }
          return project(await response.json());
        };
        const [catalog, claude] = await Promise.allSettled([
          inspect('/api/provider', projectHandoffProviderStatus, 'qa_handoff_catalog_unavailable'),
          inspect('/api/provider/anthropic/claude-cli', projectHandoffClaudeStatus, 'qa_handoff_claude_status_unavailable'),
        ]);
        return { ...(catalog.status === 'fulfilled' ? catalog.value : { catalogCode: finiteCode(catalog.reason) }),
          ...(claude.status === 'fulfilled' ? { claudeStatus: claude.value } : { claudeCode: finiteCode(claude.reason) }) };
      };
      // These constructor closures use only this naturally issued owner
      // session. The driver never receives a cookie or provider credential.
      const api = async (route, { signal, method = 'GET', body } = {}) => {
        const requested = new URL(route, origin);
        if (!route.startsWith('/api/') || route.includes('://') || !['GET', 'POST', 'PUT'].includes(method)
          && !(method === 'DELETE' && requested.pathname === '/api/config/agents/explorer/override')) throw fail('qa_profile_api_invalid');
        const response = await fetch(`${origin}${route}`, { method, body, redirect: 'error',
          headers: { Cookie: `${cookie.name}=${cookie.value}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(qa1ExerciseRequestTimeout(requested.pathname, method))]) });
        if (!response.ok) { await response.body?.cancel(); throw fail(qa1ExerciseHttpFailure(requested.pathname, method, response.status)); }
        if (response.status === 204) return null;
        const { projectQa1ExerciseAPIResponse } = await import('./qa1-profile-exercise.mjs');
        const value = await response.json(), parsed = new URL(route, origin);
        if (parsed.pathname === '/api/opencode/directory' && method === 'POST' && value?.success === true) {
          const requested = JSON.parse(body);
          if (typeof requested.path === 'string' && requested.path.startsWith(path.join(repository, '.cache/qa/qa1-'))) ownedExerciseDirectories.add(requested.path);
        }
        if (parsed.pathname === '/api/session' && method === 'POST' && safeSessionID(value?.id)) ownedExerciseSessions.add(value.id);
        const children = /^\/api\/session\/([^/]+)\/children$/.exec(parsed.pathname);
        if (children && ownedExerciseSessions.has(children[1]) && Array.isArray(value)) {
          for (const child of value) if (safeSessionID(child?.id) && child.parentID === children[1]) ownedExerciseSessions.add(child.id);
        }
        if (parsed.pathname === '/api/orchestration/snapshot' && ownedExerciseSessions.has(parsed.searchParams.get('rootSessionId'))) {
          for (const task of value?.tasks ?? []) if (safeSessionID(task?.childSessionId)) ownedExerciseSessions.add(task.childSessionId);
        }
        if (ownedExerciseSessions.size > 256) throw fail('qa_profile_owned_session_bound');
        return projectQa1ExerciseAPIResponse(route, value);
      };
      const authenticate = async cdp => {
        if (closed || !validatedAdmissions) throw fail('qa_profile_manual_admission_required');
        await cdp.send('Network.setCookie', { name: cookie.name, value: cookie.value, url: origin, httpOnly: true, sameSite: 'Strict' });
      };
      const readJournal = async (input, { receiptSettlement = false } = {}) => {
        assertHandoffJournalScope(input, ownedExerciseSessions, ownedExerciseDirectories);
        const current = async () => { const selected = await readState(stateFile);
          if (closed || !handle.isReady() || selected.binding.selection.revision !== binding.selection.revision
            || selected.state.bundleID !== state.bundleID || selected.state.artifactManifestSha256 !== state.artifactManifestSha256) throw fail('qa_profile_selection_changed'); };
        await current();
        const journalDirectory = path.join(binding.descriptor.launch.webDataDirectory, 'harness/journal');
        const flushed = await fetch(`${origin}/api/diagnostics/export`, { method: 'POST', redirect: 'error',
          headers: { Cookie: `${cookie.name}=${cookie.value}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'runtime', format: 'chrome-trace' }), signal: AbortSignal.timeout(10000) });
        await flushed.body?.cancel(); if (!flushed.ok) throw fail('qa_profile_journal_flush_failed');
        const response = await fetch(`${origin}/api/diagnostics/status`, { redirect: 'error',
          headers: { Cookie: `${cookie.name}=${cookie.value}` }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) { await response.body?.cancel(); throw fail('qa_profile_journal_status_failed'); }
        const status = await response.json();
        if (status?.directory !== journalDirectory || typeof status.enabled !== 'boolean' || !Number.isSafeInteger(status.gapRecords)
          || status.gapRecords < 0 || !Number.isSafeInteger(status.queuedRecords) || status.queuedRecords < 0
          || status.lastError !== null && typeof status.lastError !== 'string') throw fail('qa_profile_journal_status_invalid');
        const { readQa1ProviderJournal } = await import('./qa1-provider-qualification.mjs');
        const result = await readQa1ProviderJournal({ ...input, receiptSettlement, runtimeRoot: binding.descriptor.launch.webDataDirectory, journalDirectory,
          coverage: { enabled: status.enabled, gapRecords: status.gapRecords, queuedRecords: status.queuedRecords, lastError: Boolean(status.lastError) } });
        const scoped = new Set(input.sessionIDs);
        for (const row of result.records ?? []) if (row.type === 'title' && scoped.has(row.sessionID) && safeSessionID(row.helperSessionID)) scoped.add(row.helperSessionID);
        if (!Array.isArray(result.records) || result.records.some(row => !scoped.has(row.sessionID))) throw fail('qa_profile_journal_scope_invalid');
        for (const sessionID of scoped) ownedExerciseSessions.add(sessionID);
        await current(); return result;
      };
      pendingExercise = { api, authenticate, readJournal };
      ownerAdmissions++; return cookie;
    } }, hostOrigin: origin, isHeld: () => exerciseLifetime.signal.aborted || Boolean(closed), onAdmission: () => {
      check();
      exerciseAPI = pendingExercise.api; authenticateExerciseBrowser = pendingExercise.authenticate; exerciseJournal = pendingExercise.readJournal;
      pendingExercise = undefined; validatedAdmissions++;
    } });
    check();
    send({ status: 'signin-ready', origin, ...link.issue(), principal: 'local-admin-after-owner-link',
      bundleID: state.bundleID, buildID: state.buildID, inference: 'not-run', accountCopy: 'not-run' });
    onMessage = async value => {
      if (exerciseLifetime.signal.aborted || closed) return;
      if (value?.command === 'status') {
        let inspection;
        try { if (readConnections) inspection = await readConnections(); } catch (error) { inspection = { catalogCode: finiteCode(error) }; }
        send({ status: 'signin-status', origin, ready: handle.isReady(), ownerAdmissions,
          principal: ownerAdmissions ? 'local-admin-owner-link-issued' : 'not-yet-issued',
          ...inspection,
          accountVerification: 'not-run', inference: 'not-run', accountCopy: 'not-run' });
      }
      else if (['exercise', 'qualify-providers'].includes(value?.command)) {
        if (closed || exerciseWork || !validatedAdmissions || !exerciseAPI || !authenticateExerciseBrowser || !qualificationReport) {
          send({ status: 'profile-exercise-refused', code: exerciseWork ? 'qa_profile_exercise_busy'
            : !validatedAdmissions ? 'qa_profile_manual_admission_required' : 'qa_profile_native_qualification_required' }); return;
        }
        exerciseWork = (async () => {
          const ensureCurrent = async () => { const current = await readState(stateFile);
            if (current.binding.selection.revision !== binding.selection.revision || current.state.bundleID !== state.bundleID
              || current.state.artifactManifestSha256 !== state.artifactManifestSha256) throw fail('qa_profile_selection_changed'); };
          const selectedIdentity = { buildID: state.buildID, artifactManifestSha256: state.artifactManifestSha256 };
          if (value.command === 'qualify-providers') {
            const { runQa1ProviderQualification } = await import('./qa1-provider-qualification.mjs');
            return runQa1ProviderQualification({ api: exerciseAPI, qualificationReport, selectedIdentity,
              admitted: () => validatedAdmissions > 0, ready: () => handle.isReady(), ensureCurrent, signal: exerciseLifetime.signal, mediumSample,
              readJournal: exerciseJournal });
          }
          const { runQa1ProfileExercise } = await import('./qa1-profile-exercise.mjs');
          return runQa1ProfileExercise({ api: exerciseAPI, authenticateBrowser: authenticateExerciseBrowser, origin,
            readSettlementJournal: input => exerciseJournal(input, { receiptSettlement: true }),
            retainMediumSample: value => { mediumSample = Object.freeze({ ...value }); },
            inspectPublication: async input => {
              if (!input || Object.keys(input).sort().join(',') !== 'callID,directory,messageID,sessionID'
                || !['sessionID', 'messageID', 'callID'].every(key => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(input[key] ?? ''))
                || !input.directory.startsWith(path.join(repository, '.cache/qa/qa1-original-profile-')) || path.basename(input.directory) !== 'project') throw fail('qa_profile_publication_scope_invalid');
              const lease = await readRuntimeUiLease({ ...input, storage: path.join(binding.descriptor.launch.webDataDirectory, 'harness/session-mutations') });
              if (lease.state !== 'published' || lease.executionKind !== 'process' || lease.directory !== input.directory
                || lease.scope?.sessionID !== input.sessionID || lease.scope.messageID !== input.messageID || lease.scope.callID !== input.callID
                || !/^[a-f0-9-]{36}$/.test(lease.result?.operationID ?? '')) throw fail('qa_profile_live_publication_unconfirmed');
              const receipt = await readSessionExecutionReceipt(lease);
              return { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, operationID: lease.result.operationID,
                published: true, scopeVerified: true, terminated: receipt.terminated, confined: receipt.confined, cancelled: receipt.cancelled, exitCode: receipt.exitCode };
            },
            qualificationReport, selectedIdentity,
            admitted: () => validatedAdmissions > 0, ready: () => handle.isReady(), signal: exerciseLifetime.signal,
            ensureCurrent });
        })();
        try { send(await exerciseWork); }
        catch (error) { send({ status: 'profile-exercise-refused', code: finiteCode(error) }); }
        finally { exerciseWork = undefined; }
      }
      else if (value?.command === 'owner-link') send({ status: 'owner-link', ...link.issue() });
      else if (value?.command === 'close') exerciseLifetime.abort(fail('qa_handoff_closed'));
    };
    process.on('message', onMessage);
    await lifetime.stopped;
  } catch (error) {
    primaryError = error; ownerExitCode = 1;
    // The settler can terminate lingering handles immediately after owner-returned.
    if (handle) await sendHandoffChildRefusal(error);
    throw error;
  } finally {
    try { await close(); } finally { if (onMessage) process.off('message', onMessage); lifetime.dispose(); }
  }
}

export async function upgradeProviderHandoff({ stateFile, targetArtifactRoot, targetBuildID, targetManifestSha256 }) {
  const registered = await readRegisteredProviderHandoff();
  if (registered?.stateFile !== stateFile) throw fail('qa_handoff_registration_invalid');
  const stateSha256 = hash(await readQaPinnedFile(stateFile));
  const target = { targetArtifactRoot, targetBuildID, targetManifestSha256 };
  const pending = await readUpgradeTarget(stateFile, target);
  const { state, binding } = await readState(stateFile, pending);
  if (state.artifactManifestSha256 === targetManifestSha256) throw fail('qa_handoff_upgrade_not_available');
  const env = { ...createQaNativeLaunchEnvironment({ binding, runtimeRoot: state.runtimeRoot }), DEVRYAN_EXECUTION_ARTIFACTS: targetArtifactRoot,
    DEVRYAN_EXECUTION_SUMMARY_MIN_MS: '0' };
  const child = fork(fileURLToPath(import.meta.url), ['--child-upgrade', stateFile, targetArtifactRoot, targetBuildID, targetManifestSha256], { cwd: repository, env,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  let receipt, refusal; child.on('message', value => {
    refusal ??= projectHandoffChildRefusal(value);
    if (value?.status === 'upgrade-committed'
    && Object.keys(value).sort().join(',') === 'bundleID,revision,status') receipt = value; });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 120000);
  let result;
  try { const settling = settleLiveOwnerChild(child); child.send({ status: 'owner-attended', launcherPid: process.pid }); result = await settling; }
  finally { clearTimeout(watchdog); }
  assertHandoffUpgradeSettlement(result, receipt, refusal);
  const current = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: state.controlRoot });
  const proof = assertHandoffUpgradeLineage({ state, binding: current, pending });
  if (receipt.bundleID !== proof.bundleID || receipt.revision !== proof.revision) throw fail('qa_handoff_upgrade_unconfirmed');
  const next = { ...state, bundleID: proof.bundleID, artifactRoot: targetArtifactRoot, buildID: targetBuildID,
    artifactManifestSha256: targetManifestSha256 };
  try {
    await withCrossProcessFileLock(`${stateFile}.lock`, async () => {
      await readQaPinnedFile(stateFile, stateSha256, 65536);
      await writeFileAtomic(stateFile, JSON.stringify(next, null, 2) + '\n');
    });
    await readState(stateFile);
  } catch (error) {
    // Native selection already committed. Preserve that truth and the exact
    // resumable lineage instead of reporting an uncommitted upgrade failure.
    return { status: 'persistent-profile-upgrade-needs-resume', nativeUpgradeCommitted: true,
      ...proof, code: finiteCode(error), labels: registered.labels, accountVerification: 'not-run' };
  }
  return { status: 'persistent-profile-upgraded', ...proof, labels: registered.labels, accountVerification: 'not-run' };
}

export async function launchProviderHandoff({ stateFile, qualificationReport, emitStatus = emit }) {
  let child, settling;
  const start = async () => {
    const { state, binding } = await readState(stateFile);
    const env = { ...createQaNativeLaunchEnvironment({ binding, runtimeRoot: state.runtimeRoot }), DEVRYAN_EXECUTION_SUMMARY_MIN_MS: '0' };
    const launched = fork(fileURLToPath(import.meta.url), ['--child', stateFile, ...(qualificationReport ? [qualificationReport] : [])], { cwd: repository, env,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    // Production diagnostics are not sign-in transcripts. Discard them; only
    // bounded protocol facts and the transient owner link reach this terminal.
    launched.stdout.resume(); launched.stderr.resume();
    child = launched; settling = settleLiveOwnerChild(launched);
    void settling.then(result => emitStatus({ status: 'owned-host-exited', exitCode: result.exitCode, teardown: result.teardown }));
    let reportedRefusal = false;
    launched.on('message', value => {
      const refusal = projectHandoffChildRefusal(value);
      if (refusal) { if (!reportedRefusal) emitStatus(refusal); reportedRefusal = true; return; }
      if (['signin-ready', 'signin-status', 'owner-link', 'profile-exercise-refused', 'profile-exercise-finished', 'provider-qualification-finished'].includes(value?.status)) emitStatus(value);
    });
    launched.send({ status: 'owner-attended', launcherPid: process.pid });
  };
  const stop = async () => { if (child?.connected) child.send({ command: 'close' });
    const result = await settling; if (result?.teardown !== 'passed') throw fail('qa_handoff_cleanup_failed'); };
  await start();
  return { command: async command => {
    if (command === 'restart') { await stop(); emitStatus({ status: 'owned-host-stopped-profile-retained' }); await start(); }
    else if (command === 'close') { await stop(); return false; }
    else if (['status', 'owner-link', 'exercise', 'qualify-providers'].includes(command)) { if (!child?.connected) throw fail('qa_handoff_closed'); child.send({ command }); }
    else throw fail('qa_handoff_command_invalid');
    return true;
  }, close: stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--child' && [2, 3].includes(args.length)) await runChild(args[1], undefined, args[2]);
    else if (args[0] === '--child-upgrade' && args.length === 5) await runChild(args[1], {
      targetArtifactRoot: args[2], targetBuildID: args[3], targetManifestSha256: args[4] });
    else if (args[0] === '--register-profile' && args.length === 2) {
      const stateFile = path.resolve(args[1]); await readState(stateFile);
      await registerProviderHandoffProfile(stateFile);
      emit({ status: 'persistent-profile-registered', stateFile, labels: { profile: 'V1', qa: 'QA1' }, accountVerification: 'not-run' });
    }
    else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw fail('qa_live_owner_attendance_required');
      if (args[0] === '--upgrade-current' && args.length === 7 && args[1] === '--artifact-root'
        && args[3] === '--build-id' && args[5] === '--manifest-sha256') {
        const registered = await readRegisteredProviderHandoff();
        if (!registered) throw fail('qa_handoff_profile_not_registered');
        emit(await upgradeProviderHandoff({ stateFile: registered.stateFile, targetArtifactRoot: path.resolve(args[2]),
          targetBuildID: args[4], targetManifestSha256: args[6] }));
      } else {
      let stateFile, run, qualificationReport;
      if (args[0] === '--artifact-root' && args.length === 2) {
        if (await readRegisteredProviderHandoff()) throw fail('qa_handoff_profile_already_registered');
        run = createRunRoot({ parent: providerHandoffRunParent, prefix: 'live-provider-handoff-',
          owner: 'scripts/qa/live-provider-handoff.mjs', keepArtifacts: true, signals: 'exit' });
        ({ stateFile } = await prepareProviderHandoff({ artifactRoot: path.resolve(args[1]), root: run.dir }));
        await registerProviderHandoffProfile(stateFile);
        emit({ status: 'private-profile-prepared', stateFile, inference: 'not-run', accountCopy: 'not-run' });
      } else if (args[0] === '--resume-current' && (args.length === 1 || args.length === 3 && args[1] === '--qualification-report')) {
        const registered = await readRegisteredProviderHandoff();
        if (!registered) throw fail('qa_handoff_profile_not_registered'); stateFile = registered.stateFile;
        if (args.length === 3) qualificationReport = path.resolve(args[2]);
      } else if (args[0] === '--resume' && args.length === 2) {
        stateFile = path.resolve(args[1]);
        const registered = await readRegisteredProviderHandoff();
        if (registered && registered.stateFile !== stateFile) throw fail('qa_handoff_profile_already_registered');
      }
      else throw fail('qa_handoff_flags_invalid');
      const owner = await launchProviderHandoff({ stateFile, qualificationReport });
      const interrupt = () => { void owner.close().finally(() => process.stdin.destroy()); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      const { createInterface } = await import('node:readline');
      try { for await (const line of createInterface({ input: process.stdin })) {
        try { if (!await owner.command(parseHandoffCommand(line))) break; }
        catch (error) { emit({ status: 'refused', code: finiteCode(error) }); }
      } } finally { await owner.close(); run?.finish('interrupted'); }
      }
    }
  } catch (error) { await sendHandoffChildRefusal(error); emit({ status: 'refused', code: finiteCode(error) }); process.exitCode = 1; }
}
