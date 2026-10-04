import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRuntimeBundleStore } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import { createRuntimeBundleCheckpoint } from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { reviewedCouncilMembers } from '../../packages/web/server/lib/opencode/runtime-host/reviewed-council-configuration.js';
import { qaPlatformEnvironment } from './launch-environment.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const within = (root, file) => file === root || file.startsWith(root + path.sep);
async function ownedPath(file, { directory = true } = {}) {
  if (!path.isAbsolute(file ?? '') || path.resolve(file) !== file || !within(path.join(repository, '.cache'), file)
    || await fs.realpath(file) !== file) throw fail('qa_native_input_path_invalid');
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw fail('qa_native_input_path_invalid');
  return file;
}
async function ownedFutureDirectory(file) {
  if (!path.isAbsolute(file ?? '') || path.resolve(file) !== file || !within(path.join(repository, '.cache'), file)) throw fail('qa_native_input_path_invalid');
  let parent = file;
  for (;;) {
    try { await fs.lstat(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
  }
  await ownedPath(parent);
}

/** No ambient home or implicit credential files. The manifest covers the whole copied input. */
export async function verifyQaNativeInput(input) {
  if (!input || Object.keys(input).some(key => !['sourceHome', 'files', 'artifactRoot'].includes(key))) throw fail('qa_native_input_invalid');
  await ownedPath(input.sourceHome); await ownedPath(input.artifactRoot);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 10000) throw fail('qa_native_input_manifest_invalid');
  const expected = new Map();
  for (const row of input.files) {
    if (!row || Object.keys(row).some(key => !['path', 'sha256'].includes(key)) || typeof row.path !== 'string'
      || !row.path || path.isAbsolute(row.path) || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(row.sha256) || expected.has(row.path)) throw fail('qa_native_input_manifest_invalid');
    expected.set(row.path, row.sha256);
  }
  const actual = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw fail('qa_native_input_symlink');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const relative = path.relative(input.sourceHome, file).split(path.sep).join('/');
        if (!expected.has(relative) || hash(await fs.readFile(file)) !== expected.get(relative)) throw fail('qa_native_input_changed');
        actual.push(relative);
      } else throw fail('qa_native_input_invalid');
    }
  }
  await walk(input.sourceHome);
  if (actual.length !== expected.size) throw fail('qa_native_input_changed');
  return hash(JSON.stringify([...expected].sort(([a], [b]) => a.localeCompare(b))));
}

export async function createQaNativeInputVerifier(input) {
  const approvedInput = structuredClone(input), inputDigest = await verifyQaNativeInput(approvedInput);
  approvedInput.files.forEach(Object.freeze); Object.freeze(approvedInput.files); Object.freeze(approvedInput);
  return { input: approvedInput, inputDigest, verifyInputs: async () => {
    if (await verifyQaNativeInput(approvedInput) !== inputDigest) throw fail('qa_native_input_changed');
    return inputDigest;
  } };
}

export async function archiveQaNativeControllerLog(profile, evidenceDirectory, sanitizer) {
  const logRoot = profile.nativeLogRoot;
  if (!within(profile.env.DEVRYAN_QA_RUNTIME_ROOT, logRoot ?? '')) throw fail('qa_native_log_path_invalid');
  await ownedPath(logRoot); await ownedPath(evidenceDirectory);
  const source = path.join(logRoot, 'native-controller.jsonl');
  if (await fs.realpath(source) !== source || !(await fs.lstat(source)).isFile()) throw fail('qa_native_log_path_invalid');
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW), maximum = 4 * 1024 * 1024;
  try {
    if ((await handle.stat()).size > maximum) throw fail('qa_native_log_size_limit');
    const buffer = Buffer.alloc(maximum + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > maximum) throw fail('qa_native_log_size_limit');
    const rows = buffer.subarray(0, bytes).toString('utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.event !== 'native-process-exit') throw fail('qa_native_log_record_invalid');
      const projected = Object.fromEntries(Object.entries(row).filter(([key]) => ['event', 'pid', 'code', 'signal', 'expected', 'instanceID', 'startedAt', 'stderrBytes', 'observationUnavailable'].includes(key)));
      if (row.receipt !== undefined) {
        if (!row.receipt || typeof row.receipt !== 'object' || Array.isArray(row.receipt)) throw fail('qa_native_log_record_invalid');
        projected.receipt = Object.fromEntries(Object.entries(row.receipt).filter(([key]) => ['path', 'terminated', 'confined', 'cancelled', 'exitCode'].includes(key)));
      }
      return projected;
    });
    const output = rows.map(row => JSON.stringify(sanitizer.sanitizeExportValue(row))).join('\n') + (rows.length ? '\n' : '');
    if (Buffer.byteLength(output) > maximum) throw fail('qa_native_log_size_limit');
    const file = 'native-controller.jsonl';
    await fs.writeFile(path.join(evidenceDirectory, file), output, { mode: 0o600 });
    return { file, state: 'captured', bytes, sha256: hash(output), observationUnavailable: rows.some(row => row.observationUnavailable === true) };
  } finally { await handle.close(); }
}

export function assertQaNativeSelection(cell, view) {
  const selection = view.agentSelections[cell.agent];
  if (!selection || selection.model !== `${cell.providerId}/${cell.modelId}` || (selection.variant ?? null) !== cell.variant
    || Object.keys(cell.agentAssignments ?? {}).length || cell.allowCrossProviderAssignments) throw fail('qa_native_saved_selection_mismatch');
}

export function projectQaNativeSnapshot(snapshot, directory, { devryanBackupSelections = {} } = {}) {
  const location = snapshot.locations.find(row => row.directory === directory);
  if (!location || !/^[a-f0-9]{64}$/.test(snapshot.digest) || !/^[a-f0-9]{64}$/.test(snapshot.sourceStamp)) throw fail('qa_native_location_missing');
  const agentSelections = Object.fromEntries(Object.entries(location.configuration.agents ?? {}).map(([name, row]) => [name, {
    model: typeof row.model === 'string' ? row.model : row.model ? `${row.model.providerID}/${row.model.model}` : undefined,
    variant: row.model?.variant ?? null, promptSha256: hash(row.system ?? ''),
  }]).filter(([, row]) => row.model));
  const native = location.compatibility?.slim?.nativeRuntime;
  const activeSlim = location.activeRegistrationIDs?.includes('devryan.slim') || native !== undefined;
  const slim = { runtimeChains: {}, modelArrays: {}, fallback: {}, effectiveExecutionVariant: 'default' };
  if (activeSlim) {
    if (!native || typeof native !== 'object' || !native.runtimeChains || typeof native.runtimeChains !== 'object' || Array.isArray(native.runtimeChains)
      || !native.modelArrays || typeof native.modelArrays !== 'object' || Array.isArray(native.modelArrays)
      || !native.fallback || typeof native.fallback !== 'object' || Array.isArray(native.fallback)) throw fail('qa_native_backup_routes_missing');
    for (const [agent, chain] of Object.entries(native.runtimeChains)) {
      const models = native.modelArrays[agent];
      if (!Array.isArray(chain) || !chain.length || !Array.isArray(models) || chain.length !== models.length
        || chain.some((model, index) => typeof model !== 'string' || !/^[^/]+\/.+/.test(model)
          || models[index]?.id !== model || models[index].variant !== undefined && typeof models[index].variant !== 'string')) throw fail('qa_native_backup_routes_invalid');
    }
    if (Object.keys(native.modelArrays).some(agent => !Object.hasOwn(native.runtimeChains, agent))) throw fail('qa_native_backup_routes_invalid');
    slim.runtimeChains = structuredClone(native.runtimeChains);
    slim.modelArrays = Object.fromEntries(Object.entries(native.modelArrays).map(([agent, models]) => [agent, models.map(model => ({ id: model.id, variant: model.variant ?? null }))]));
    for (const key of ['enabled', 'maxRetries', 'initialRetryDelayMs', 'retryDelayMs']) {
      if (native.fallback[key] !== undefined) slim.fallback[key] = native.fallback[key];
    }
  }
  const devryan = {};
  for (const [agent, selection] of Object.entries(devryanBackupSelections)) {
    if (!agentSelections[agent] || typeof selection?.model !== 'string' || !/^[^/]+\/.+/.test(selection.model)
      || selection.variant !== null && typeof selection.variant !== 'string') throw fail('qa_native_backup_routes_invalid');
    devryan[agent] = { model: selection.model, variant: selection.variant };
  }
  return { snapshotDigest: snapshot.digest, sourceDigest: snapshot.sourceStamp, agentSelections,
    nativeCompactionSettings: structuredClone(location.configuration.compaction ?? {}),
    nativeBackupSelections: { slim, devryan },
    councilMembers: reviewedCouncilMembers(snapshot, { directory, preset: 'default' }) };
}


export function qaNativeRequiredProviders(view) {
  return [...new Set([...Object.values(view.agentSelections).map(row => row.model.split('/')[0]),
    ...view.councilMembers.map(row => row.providerId),
    ...Object.values(view.nativeBackupSelections.slim.runtimeChains).flat().map(model => model.split('/')[0]),
    ...Object.values(view.nativeBackupSelections.devryan).map(row => row.model.split('/')[0])])];
}

export function assertQaNativeCredentialAdmission(providerId, credentials, timeoutMs, now = Date.now()) {
  const row = credentials?.[providerId];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !row) throw fail('qa_native_credential_prerequisite');
  const shared = ['kind', 'providerId', 'bundleID', 'controlRoot', 'expires', 'checkedAt', 'expiryCheck'];
  let proof, oauth;
  if (row.kind === 'meridian-profile' && providerId === 'anthropic') {
    if (Object.keys(row).some(key => ![...shared, 'profileID', 'configurationFingerprint', 'authKind'].includes(key))
      || typeof row.profileID !== 'string' || !row.profileID || !/^[a-f0-9]{64}$/.test(row.configurationFingerprint)
      || !['api', 'claude-max', 'oauth-token'].includes(row.authKind)) throw fail('qa_native_credential_prerequisite');
    proof = { kind: row.kind, profileID: row.profileID, configurationFingerprint: row.configurationFingerprint, authKind: row.authKind };
    oauth = row.authKind !== 'api';
  } else if (row.kind === 'native-credential' && providerId !== 'anthropic') {
    if (Object.keys(row).some(key => ![...shared, 'credentialID', 'expectedFingerprint', 'valueType'].includes(key))
      || !['key', 'oauth'].includes(row.valueType) || typeof row.credentialID !== 'string' || !row.credentialID
      || !/^[a-f0-9]{64}$/.test(row.expectedFingerprint)) throw fail('qa_native_credential_prerequisite');
    proof = { kind: row.kind, credentialID: row.credentialID, expectedFingerprint: row.expectedFingerprint, valueType: row.valueType };
    oauth = row.valueType === 'oauth';
  } else throw fail('qa_native_credential_prerequisite');
  if (oauth && (!Number.isFinite(row.expires) || row.expires < now + timeoutMs + 600000)) throw fail('qa_native_credential_expiry');
  return { ...proof, providerId, bundleID: row.bundleID, controlRoot: row.controlRoot,
    checkedAt: now, expiryCheck: oauth ? 'passed' : 'not-applicable-to-key', ...(oauth ? { expires: row.expires } : {}) };
}

export function createQaNativeLaunchEnvironment({ binding, runtimeRoot, baseEnvironment = process.env }) {
  const launch = binding.descriptor.launch;
  return { ...qaPlatformEnvironment(baseEnvironment), DEVRYAN_RUNTIME_BUNDLE_ROOT: binding.controlRoot, DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot,
    DEVRYAN_QA_HOME: launch.global.home, HOME: launch.global.home, OPENCODE_TEST_HOME: launch.global.home,
    XDG_CONFIG_HOME: launch.global.config, XDG_DATA_HOME: launch.global.data,
    XDG_STATE_HOME: launch.global.state, XDG_CACHE_HOME: launch.global.cache, TMPDIR: launch.global.tmp,
    NODE_OPTIONS: `--import=${JSON.stringify(fileURLToPath(new URL('./isolated-home.mjs', import.meta.url)))}`,
    OPENCHAMBER_DATA_DIR: launch.webDataDirectory, OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(runtimeRoot, 'browser-profile'), OPENCHAMBER_ELECTRON_DEV: '1' };
}

export async function validateQaNativeSourceLaunch(launch, runtimeRoot) {
  if (!launch || Object.keys(launch).some(key => !['opencodeDatabasePath', 'webDataDirectory', 'webConfigDirectory', 'opencodeConfigDirectory', 'global'].includes(key))
    || !launch.global || Object.keys(launch.global).some(key => key !== 'home')) throw fail('qa_native_source_not_isolated');
  const file = launch.opencodeDatabasePath;
  if (!within(runtimeRoot, file ?? '')) throw fail('qa_native_source_not_isolated');
  await ownedPath(file, { directory: false });
  const directories = [launch.webDataDirectory, launch.webConfigDirectory, launch.opencodeConfigDirectory,
    launch.global?.home];
  for (const directory of directories) {
    if (!within(runtimeRoot, directory ?? '')) throw fail('qa_native_source_not_isolated');
    await ownedPath(directory);
  }
}

/** Fresh process imports the production binding before configuration owners.
 * It reports routes and prompt hashes only; never raw prompts or credentials. */
async function snapshotView(binding, environment, workspace) {
  const module = fileURLToPath(new URL('../../packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js', import.meta.url));
  const bindingModule = fileURLToPath(new URL('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js', import.meta.url));
  const source = `
    const {selectedRuntimeBundle:binding}=await import(${JSON.stringify(bindingModule)});
    const {loadNativeRuntimeBundle}=await import(${JSON.stringify(module)});
    const {projectQaNativeSnapshot}=await import(${JSON.stringify(fileURLToPath(import.meta.url))});
    const bundle=await loadNativeRuntimeBundle({binding,launcher:process.env.DEVRYAN_QA_LAUNCHER});
    const snapshot=await bundle.resolveConfiguration(binding.selection.revision);
    const directory=process.env.DEVRYAN_QA_WORKSPACE;
    const {resolveLocalAgentBackupExecution}=await import(${JSON.stringify(fileURLToPath(new URL('../../packages/web/server/lib/opencode/agents.js', import.meta.url)))});
    const location=snapshot.locations.find(row=>row.directory===directory);
    const devryanBackupSelections={};
    for(const agent of Object.keys(location.configuration.agents??{})){
      const selected=resolveLocalAgentBackupExecution({directory,agent});
      if(selected)devryanBackupSelections[agent]={model:selected.providerId+'/'+selected.modelId,variant:selected.variant};
    }
    process.stdout.write(JSON.stringify(projectQaNativeSnapshot(snapshot,directory,{devryanBackupSelections})));`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repository, env: { ...environment, DEVRYAN_QA_WORKSPACE: workspace,
      DEVRYAN_QA_LAUNCHER: path.join(path.dirname(binding.descriptor.launch.controllerBinary), `DevRyan-execution-${process.platform}-${process.arch}`) },
    timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stderr) throw fail('qa_native_snapshot_stderr');
  return JSON.parse(stdout);
}

/** Source/credential callbacks are constructor-owned production owners, never
 * matrix JSON. Source copying uses the actual checkpoint and migration store. */
export async function prepareQaNativeProfile({ runtimeRoot, workspace, cell, nativePreparation }) {
  if (typeof nativePreparation?.prepareSource !== 'function' || typeof nativePreparation?.bootstrapCredentials !== 'function') throw fail('qa_native_preparation_prerequisite');
  const { input, inputDigest, verifyInputs } = await createQaNativeInputVerifier(nativePreparation.preparedInput);
  let preparationFailure;
  try {
  await ownedPath(workspace);
  await ownedFutureDirectory(runtimeRoot);
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 }); await ownedPath(runtimeRoot);
  const source = await nativePreparation.prepareSource({ runtimeRoot, workspace, sourceHome: input.sourceHome, artifactRoot: input.artifactRoot });
  if (typeof source?.checkpointOptions !== 'function' || typeof source?.runMigration !== 'function') throw fail('qa_native_checkpoint_prerequisite');
  for (const key of ['controllerBinary', 'writerBinary', 'artifactManifestPath']) {
    const file = source.nativeArtifacts?.[key];
    if (!within(input.artifactRoot, file ?? '') || await fs.realpath(file) !== file) throw fail('qa_native_artifact_input_mismatch');
  }
  await validateQaNativeSourceLaunch(source.launch, runtimeRoot);
  if (!source.projectMap?.some(row => row.targetDirectory === workspace)) throw fail('qa_native_location_missing');
  const controlRoot = path.join(runtimeRoot, 'native-bundles'), descriptors = new Map(), checkpoints = new Map();
  const store = createRuntimeBundleStore({ controlRoot, runMigration: source.runMigration,
    withQuiescedSource: async (scope, action) => {
      const ownerID = scope.kind === 'legacy' ? 'qa-source' : scope.bundleID;
      const captured = scope.kind === 'legacy' ? { launch: source.launch, generation: 1 } : descriptors.get(ownerID);
      const launch = captured?.launch;
      if (!launch) throw fail('qa_native_checkpoint_prerequisite');
      if (!checkpoints.has(ownerID)) checkpoints.set(ownerID, createRuntimeBundleCheckpoint({
        ...await source.checkpointOptions({ ownerID, generation: captured.generation, launch }), ownerID, generation: captured.generation, launch,
      }));
      return checkpoints.get(ownerID)(scope, action);
    } });
  const candidate = await store.prepare({ bundleID: 'candidate', generation: 2, source: { kind: 'legacy', launch: source.launch },
    projectMap: source.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts: source.nativeArtifacts });
  descriptors.set('candidate', candidate);
  await store.select({ bundleID: 'candidate', expectedRevision: 0 });
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }), launch = binding.descriptor.launch;
  if (!within(runtimeRoot, launch.global.log)) throw fail('qa_native_log_path_invalid');
  const nativeLogRoot = await ownedPath(launch.global.log);
  await fs.writeFile(path.join(launch.global.home, '.devryan-qa-home'), 'DevRyan isolated native QA\n', { mode: 0o600 });
  await fs.writeFile(path.join(runtimeRoot, 'credentials.env.json'), '{}\n', { mode: 0o600 });
  const env = createQaNativeLaunchEnvironment({ binding, runtimeRoot });
  const view = await snapshotView(binding, env, workspace); assertQaNativeSelection(cell, view);
  const requiredProviders = qaNativeRequiredProviders(view);
  const bootstrap = await nativePreparation.bootstrapCredentials({ binding, requiredProviders, savedSelections: view.agentSelections, savedBackupSelections: view.nativeBackupSelections });
  if (bootstrap?.status !== 'ready') throw fail('qa_native_credential_prerequisite');
  if (requiredProviders.some(provider => bootstrap.credentials?.[provider]?.bundleID !== binding.descriptor.bundleID
    || bootstrap.credentials[provider].controlRoot !== binding.controlRoot)) throw fail('qa_native_credential_binding');
  const admission = requiredProviders.map(providerId => assertQaNativeCredentialAdmission(providerId, bootstrap.credentials, cell.timeoutMs));
  await store.verify({ bundleID: 'candidate', phase: 'resume' });
  return { env, nativeLogRoot, verifyInputs, bootstrapPath: fileURLToPath(new URL('./isolated-host.mjs', import.meta.url)), evidence: { generation: 2, inputDigest, ...view, credentials: Object.fromEntries(admission.map(row => [row.providerId, row])),
    nativeBundle: { bundleID: binding.descriptor.bundleID, revision: binding.selection.revision, artifactManifestSha256: launch.artifactManifestSha256 },
    preservedOrchestration: true } };
  } catch (error) { preparationFailure = error; throw error; }
  finally {
    try { await verifyInputs(); }
    catch (error) {
      if (preparationFailure) throw new AggregateError([preparationFailure, error], 'qa_native_input_changed');
      throw error;
    }
  }
}
