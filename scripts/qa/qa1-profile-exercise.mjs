import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { CONFIG_APPLY_SCOPES, CONFIG_APPLY_REASON_CODES } from '../../packages/shared-runtime/lib/config-apply-coordinator.js';
import { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from '../../packages/shared-runtime/lib/helper-model-selection.js';
import { createQaProfileProjectFixture, assertQaProfileProjectFixtureOwned, finishQaProfileProjectFixture, PROFILE_QA_HELD_OUT_CASES } from './profile-project-fixture.mjs';
import { loadPlanModeInstruction } from '../agent-evals/plan-mode.mjs';
import { createEvaluationClient, runSessionTurn } from '../agent-evals/client.mjs';
import { executeEvaluationCase } from '../agent-evals/cases.mjs';
import { allocateRunFiles, assertFixtureReady, captureFixtureManifest } from '../agent-evals/fixture.mjs';
import { captureQaTaskEvidence, cleanupQaSessionTree, projectQaNativeTestEvidence } from './live-task-evidence.mjs';
import { assertQaSubmittedPlanMode, findQaCompletedTurnAssistant } from './submitted-turn.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { readQaPinnedFile, assertQaPrivateDirectory } from './live-setup-mirror.mjs';
import { captureNativeAcceptanceSource } from '../opencode-v2-native/artifacts.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { startReceiptSettlementProbe, finishReceiptSettlementProbe, closeReceiptSettlementProbe, joinReceiptSettlement } from '../perf/receipt-ui-settlement.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const code = error => /^qa_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'qa_profile_exercise_failed';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
export const QA1_EXERCISE_SELECTIONS = Object.freeze({
  builder: { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'medium' },
  orchestrator: { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'medium' },
  explorer: { providerID: 'cursor-acp', modelID: 'grok-4.6', variant: 'medium' },
});
const nativeRequiredCases = ['compiled-production-artifacts', 'compiled-ready-catalog', 'compiled-fresh-native-initialization',
  'compiled-v2-derived-bundle-clone', 'candidate-work-rollback-retention', 'compiled-durable-journal-roots'];

// Retain only the finite coordinator contract; never forward backend warnings or metadata.
function projectExplorerApplyStatus(value) {
  if (!record(value) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0 || value.appliedRevision > value.revision
    || !['clean', 'pending', 'waiting_for_idle', 'applying', 'failed', 'external_restart_required'].includes(value.state)
    || typeof value.pending !== 'boolean' || !Array.isArray(value.scopes) || value.scopes.length > CONFIG_APPLY_SCOPES.length
    || value.scopes.some(scope => !CONFIG_APPLY_SCOPES.includes(scope)) || new Set(value.scopes).size !== value.scopes.length
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > CONFIG_APPLY_REASON_CODES.length
    || value.reasonCodes.some(reason => !CONFIG_APPLY_REASON_CODES.includes(reason)) || new Set(value.reasonCodes).size !== value.reasonCodes.length
    || !Number.isSafeInteger(value.activeSessionCount) || value.activeSessionCount < 0
    || !['managed', 'external'].includes(value.runtimeMode) || typeof value.canApplyWhenIdle !== 'boolean'
    || typeof value.canForceRestart !== 'boolean') throw fail('qa_profile_explorer_response_invalid');
  const { revision, appliedRevision, state, pending, scopes, reasonCodes, activeSessionCount, runtimeMode, canApplyWhenIdle, canForceRestart } = value;
  return { revision, appliedRevision, state, pending, scopes: [...scopes], reasonCodes: [...reasonCodes], activeSessionCount,
    runtimeMode, canApplyWhenIdle, canForceRestart };
}

export function projectQa1ExerciseAPIResponse(route, value) {
  const pathname = new URL(route, 'http://qa.invalid').pathname;
  if (pathname === '/api/provider' || pathname === '/api/config/providers') {
    const feature = pathname === '/api/config/providers';
    if (!record(value) || !Array.isArray(feature ? value.providers : value.all)
      || feature && !record(value.default) || !feature && (!Array.isArray(value.connected) || value.connected.some(id => typeof id !== 'string'))) throw fail('qa_profile_catalog_invalid');
    const selections = [...Object.values(QA1_EXERCISE_SELECTIONS), DEFAULT_HELPER_MODEL_SELECTION];
    const ids = [...new Set(selections.map(row => row.providerID))];
    const all = ids.map(providerID => {
      const found = (feature ? value.providers : value.all).filter(row => row?.id === providerID);
      if (found.length > 1) throw fail('qa_profile_catalog_invalid');
      const models = {};
      for (const selected of selections.filter(row => row.providerID === providerID)) {
        const model = found[0]?.models?.[selected.modelID];
        if (record(model)) models[selected.modelID] = { variants: record(model.variants)
          ? Object.fromEntries(['medium', 'high'].filter(key => Object.hasOwn(model.variants, key)).map(key => [key, {}])) : {} };
      }
      return { id: providerID, models };
    });
    if (value.catalogIncomplete !== undefined && typeof value.catalogIncomplete !== 'boolean') throw fail('qa_profile_catalog_invalid');
    return { all, ...(feature ? {} : { connected: ids.filter(providerID => value.connected.includes(providerID)) }), catalogIncomplete: value.catalogIncomplete ?? false };
  }
  if (pathname === '/api/provider/cursor-acp/configure' || pathname === '/api/provider/cursor-acp/runtime-status') {
    const verify = pathname.endsWith('/configure');
    if (!record(value) || !['sdk', 'fallback', 'unavailable'].includes(value.modelsSource)
      || !Number.isSafeInteger(value.modelCount) || value.modelCount < 0 || value.modelCount > 10000
      || typeof value.lastModelRefreshTimedOut !== 'boolean'
      || verify && ['success', 'ok', 'configured'].some(key => typeof value[key] !== 'boolean')
      || !verify && (typeof value.sdkAuthConfigured !== 'boolean' || !['known', 'unknown'].includes(value.authObservation))) throw fail('qa_profile_cursor_status_invalid');
    return { modelsSource: value.modelsSource, modelCount: value.modelCount, lastModelRefreshTimedOut: value.lastModelRefreshTimedOut,
      ...(verify ? { success: value.success, ok: value.ok, configured: value.configured }
        : { sdkAuthConfigured: value.sdkAuthConfigured, authObservation: value.authObservation }) };
  }
  if (pathname === '/api/config/agent-overrides') {
    if (!record(value?.overrides)) throw fail('qa_profile_explorer_restore_unavailable');
    const previous = value.overrides.explorer;
    if (previous === undefined) return { explorer: null };
    if (!record(previous) || !Object.keys(previous).length || Object.keys(previous).some(key => !['model', 'variant'].includes(key))
      || Object.hasOwn(previous, 'model') && previous.model !== 'cursor-acp/grok-4.6'
      || Object.hasOwn(previous, 'variant') && previous.variant !== null && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(previous.variant)) throw fail('qa_profile_explorer_restore_unavailable');
    return { explorer: structuredClone(previous) };
  }
  if (pathname === '/api/config/apply-status') return projectExplorerApplyStatus(value);
  if (pathname === '/api/config/agents/explorer/override') {
    if (value?.reloadFailed === true) throw fail('qa_profile_explorer_recording_failed');
    if (value?.success !== true || value.runtimeApplied !== false || value.requiresReload !== false
      || typeof value.requiresApply !== 'boolean' || !Number.isSafeInteger(value.applyRevision)
      || !Array.isArray(value.applyScopes)) throw fail('qa_profile_explorer_response_invalid');
    const applyStatus = projectExplorerApplyStatus(value.applyStatus);
    if (value.applyRevision !== applyStatus.revision || value.requiresApply !== applyStatus.pending
      || !isDeepStrictEqual(value.applyScopes, applyStatus.scopes)) throw fail('qa_profile_explorer_response_invalid');
    return { success: true, runtimeApplied: false, requiresReload: false, requiresApply: value.requiresApply,
      applyRevision: value.applyRevision, applyScopes: [...value.applyScopes], applyStatus };
  }
  if (pathname === '/api/config/apply') {
    const status = projectExplorerApplyStatus(value?.status);
    if (!Number.isSafeInteger(value.appliedRevision) || value.appliedRevision !== status.appliedRevision
      || !Array.isArray(value.appliedScopes) || value.appliedScopes.length > 1
      || value.appliedScopes.some(scope => scope !== 'agents') || value.userConfirmed !== false) throw fail('qa_profile_explorer_response_invalid');
    return { status, appliedRevision: value.appliedRevision, appliedScopes: [...value.appliedScopes], userConfirmed: false };
  }
  if (pathname === '/api/agent') {
    if (!Array.isArray(value)) throw fail('qa_profile_catalog_invalid');
    return value.filter(row => Object.hasOwn(QA1_EXERCISE_SELECTIONS, row?.name ?? '') || row?.name === 'build').map(row => {
      const selected = QA1_EXERCISE_SELECTIONS[row.name === 'build' ? 'builder' : row.name];
      const matched = row.model?.providerID === selected.providerID && (row.model?.modelID === selected.modelID
        || row.name !== 'explorer' && row.model?.modelID === 'gpt-6.1-sol');
      return { name: row.name, model: matched ? { providerID: row.model.providerID, modelID: row.model.modelID } : null,
        variant: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(row.variant) ? row.variant : null, hidden: row.hidden === true };
    });
  }
  if (pathname === '/api/config/settings') {
    if (!record(value) || value.activeProjectId !== undefined && value.activeProjectId !== null && !id(value.activeProjectId)
      || value.lastDirectory !== undefined && value.lastDirectory !== null && (typeof value.lastDirectory !== 'string'
        || !value.lastDirectory.startsWith(path.join(repository, '.cache') + path.sep))) throw fail('qa_profile_settings_invalid');
    const helper = parseHelperModelSelection(value.helperModelSelection);
    return { activeProjectId: value.activeProjectId ?? null, lastDirectory: value.lastDirectory ?? null,
      helperModelSelection: helper?.providerID === DEFAULT_HELPER_MODEL_SELECTION.providerID
        && helper?.modelID === DEFAULT_HELPER_MODEL_SELECTION.modelID
        ? { providerID: helper.providerID, modelID: helper.modelID, revision: helper.revision } : null };
  }
  if (pathname === '/api/git/commit-message/draft') {
    if (!record(value) || value.status !== 'complete' || !Array.isArray(value.commits) || value.commits.length > 64) throw fail('qa_profile_helper_response_invalid');
    return { status: 'complete', commits: value.commits.map(() => ({})) };
  }
  if (pathname === '/api/git/pr-description') return { validResponse: typeof value?.title === 'string' && value.title.length > 0
    && typeof value?.body === 'string' && value.body.length > 0 };
  if (pathname === '/api/opencode/directory') return { success: value?.success === true };
  return value;
}

export async function collectQa1ExerciseCatalog(request, directory) {
  const query = directory === undefined ? '' : `?directory=${encodeURIComponent(directory)}`;
  const statuses = await request('/api/session/status');
  if (!record(statuses) || Object.values(statuses).some(value => !record(value) || value.type !== 'idle')) throw fail('qa_profile_runtime_not_idle');
  const verified = await request(`/api/provider/cursor-acp/configure${query}`, { method: 'POST', body: '{}' });
  if (verified?.success !== true || verified.ok !== true || verified.configured !== true || verified.modelsSource !== 'sdk'
    || !Number.isSafeInteger(verified.modelCount) || verified.modelCount <= 0 || verified.lastModelRefreshTimedOut !== false) throw fail('qa_profile_cursor_verification_failed');
  const native = await request(`/api/provider${query}`), feature = await request(`/api/config/providers${query}`);
  const cursor = await request(`/api/provider/cursor-acp/runtime-status${query}`);
  if (cursor?.modelsSource !== 'sdk' || cursor.sdkAuthConfigured !== true || cursor.authObservation !== 'known'
    || !Number.isSafeInteger(cursor.modelCount) || cursor.modelCount <= 0 || cursor.lastModelRefreshTimedOut !== false) throw fail('qa_profile_cursor_verification_failed');
  if (!record(native) || !Array.isArray(native.all) || !Array.isArray(native.connected) || !record(feature) || !Array.isArray(feature.all)
    || native.catalogIncomplete !== false || feature.catalogIncomplete !== false) throw fail('qa_profile_catalog_invalid');
  const providers = feature.all.filter(row => row?.id === 'cursor-acp');
  if (providers.length !== 1 || !record(providers[0].models?.['grok-4.6']?.variants)
    || !Object.hasOwn(providers[0].models['grok-4.6'].variants, 'medium')) throw fail('qa_profile_cursor_model_unavailable');
  return { all: [...native.all.filter(row => row?.id !== 'cursor-acp'), providers[0]],
    connected: [...native.connected.filter(id => id !== 'cursor-acp'), 'cursor-acp'], catalogIncomplete: false };
}

/** This QA owner may apply only its own agents-only revision from a clean baseline.
 * Capture restoration before recording: a failed response can already have saved it. */
export function createQa1ExplorerSelectionOwner({ api, directory }) {
  const query = `?directory=${encodeURIComponent(directory)}`, route = `/api/config/agents/explorer/override${query}`;
  const desired = { model: 'cursor-acp/grok-4.6', variant: 'medium' };
  let before, previousSelection, attempted = false, recorded = false, baseline, ownedRevision;
  const explorer = agents => {
    if (!Array.isArray(agents)) throw fail('qa_profile_saved_selection_mismatch');
    const rows = agents.filter(row => row?.name === 'explorer' && row.hidden !== true);
    if (rows.length !== 1 || rows[0].model?.providerID !== 'cursor-acp' || rows[0].model?.modelID !== 'grok-4.6'
      || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(rows[0].variant)) throw fail('qa_profile_saved_selection_mismatch');
    return rows[0];
  };
  const stage = async (name, operation) => {
    try { return await operation(); }
    catch (error) {
      if (/^qa_profile_explorer_/.test(error?.code ?? '') || ['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
      throw fail(`qa_profile_explorer_${name}_failed`);
    }
  };
  const readStatus = async request => projectExplorerApplyStatus(await request('/api/config/apply-status'));
  const clean = status => status.runtimeMode === 'managed' && status.canApplyWhenIdle && status.state === 'clean'
    && !status.pending && status.revision === status.appliedRevision && !status.scopes.length && !status.reasonCodes.length;
  const owned = (status, revision, restoring = false) => status.runtimeMode === 'managed' && status.canApplyWhenIdle && status.revision === revision
    && (clean(status) || status.pending && status.appliedRevision >= baseline && status.appliedRevision < revision
      && isDeepStrictEqual(status.scopes, ['agents']) && isDeepStrictEqual(status.reasonCodes, ['CONFIG_AGENTS_CHANGED'])
      && ['pending', 'waiting_for_idle', 'applying', ...(restoring ? ['failed'] : [])].includes(status.state));
  const applyRevision = async (request, revision, expectedSelection) => {
    // The endpoint applies a global batch. Recheck the captured scope immediately before admission.
    const captured = await readStatus(request);
    if (['applying', 'waiting_for_idle'].includes(captured.state)) throw fail('qa_profile_explorer_apply_in_progress');
    if (!owned(captured, revision)) throw fail('qa_profile_explorer_apply_revision_conflict');
    const result = projectQa1ExerciseAPIResponse('/api/config/apply', await stage('apply', () => request('/api/config/apply', {
      method: 'POST', body: JSON.stringify({ expectedRevision: revision, mode: 'when-idle' }),
    })));
    if (result.status.revision === revision && result.status.state === 'failed') throw fail('qa_profile_explorer_apply_failed');
    if (!owned(result.status, revision)) throw fail('qa_profile_explorer_apply_revision_conflict');
    const deadline = performance.now() + 20000;
    while (true) {
      const status = await stage('convergence', () => readStatus(request));
      if (status.revision === revision && status.state === 'failed') throw fail('qa_profile_explorer_apply_failed');
      if (!owned(status, revision)) throw fail('qa_profile_explorer_apply_revision_conflict');
      if (clean(status) && isDeepStrictEqual(explorer(await stage('convergence', () => request(`/api/agent${query}`))), expectedSelection)) {
        const settled = await readStatus(request);
        if (!clean(settled) || settled.revision !== revision) throw fail('qa_profile_explorer_apply_revision_conflict');
        return;
      }
      if (performance.now() >= deadline) throw fail('qa_profile_explorer_convergence_failed');
      await pause(250);
    }
  };
  const recordOverride = async (request, options, previousStatus) => {
    ownedRevision = previousStatus.revision + 1;
    const result = projectQa1ExerciseAPIResponse(route, await stage('recording', () => request(route, options)));
    if (result.applyRevision !== ownedRevision || !result.requiresApply || result.applyStatus.appliedRevision !== previousStatus.appliedRevision
      || !owned(result.applyStatus, ownedRevision)) throw fail('qa_profile_explorer_recording_revision_conflict');
    recorded = true;
    if (['applying', 'waiting_for_idle'].includes(result.applyStatus.state)) throw fail('qa_profile_explorer_recording_apply_in_progress');
  };
  return {
    async apply(request) {
      const current = explorer(await request(`/api/agent${query}`));
      if (current.variant === 'medium') return;
      const status = await readStatus(request);
      if (!clean(status)) throw fail('qa_profile_explorer_apply_baseline_not_clean');
      baseline = status.revision; previousSelection = current;
      before = (await request(`/api/config/agent-overrides${query}`)).explorer;
      if (!(before === null || record(before))) throw fail('qa_profile_explorer_restore_unavailable');
      // Guard the read-to-write window too; no unrelated staged batch may be adopted.
      if (!isDeepStrictEqual(await readStatus(request), status)) throw fail('qa_profile_explorer_apply_revision_conflict');
      attempted = true;
      await recordOverride(request, { method: 'PUT', body: JSON.stringify(desired) }, status);
      if (!isDeepStrictEqual((await request(`/api/config/agent-overrides${query}`)).explorer, desired)) throw fail('qa_profile_explorer_recording_failed');
      await applyRevision(request, ownedRevision, { ...current, variant: 'medium' });
    },
    async restore() {
      if (!attempted) return;
      const signal = AbortSignal.timeout(60000);
      const cleanupRequest = (route, options = {}) => api(route, { ...options, signal });
      const latest = (await cleanupRequest(`/api/config/agent-overrides${query}`)).explorer;
      const status = await readStatus(cleanupRequest);
      // A timed-out request may still own a server-side restart. Never overlap
      // it with a newer restoration batch or cancel its idle watcher by writing.
      if (['applying', 'waiting_for_idle'].includes(status.state)) throw fail('qa_profile_explorer_restore_apply_in_progress');
      if (isDeepStrictEqual(latest, before)) {
        if (!clean(status) || ![baseline, ownedRevision].includes(status.revision)
          || !isDeepStrictEqual(explorer(await cleanupRequest(`/api/agent${query}`)), previousSelection)) throw fail('qa_profile_explorer_restore_convergence_failed');
        return;
      }
      // A route can persist before markChanged fails. Only the unchanged clean
      // baseline permits recording that exact saved rollback without adopting a batch.
      const unrecorded = !recorded && clean(status) && status.revision === baseline;
      if (!isDeepStrictEqual(latest, desired) || !unrecorded && !owned(status, ownedRevision, true)) throw fail('qa_profile_explorer_restore_changed');
      await stage('restore', async () => {
        await recordOverride(cleanupRequest, before === null ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify(before) }, status);
        if (!isDeepStrictEqual((await cleanupRequest(`/api/config/agent-overrides${query}`)).explorer, before)) throw fail('qa_profile_explorer_restore_recording_failed');
        await applyRevision(cleanupRequest, ownedRevision, previousSelection);
      });
    },
  };
}

export function assertQa1NativeQualification({ report, run, expected, currentSource, runnerSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(expected?.buildID ?? '') || !/^[a-f0-9]{64}$/.test(expected?.artifactManifestSha256 ?? '')
    || run?.schemaVersion !== 1 || run.owner !== 'scripts/verify-opencode-v2-package.mjs' || run.status !== 'passed'
    || report?.status !== 'passed' || ['diagnostic', 'preflight', 'managedCorrectness', 'retainedShellDiagnostic'].some(key => report[key] !== false)
    || !Array.isArray(report.cleanupFailures) || report.cleanupFailures.length || !Array.isArray(report.remainingMandatoryGates) || report.remainingMandatoryGates.length
    || report.sourceCohort?.valid !== true || !Array.isArray(report.sourceCohort.changedPaths) || report.sourceCohort.changedPaths.length
    || !Array.isArray(report.cases) || report.cases.some(row => !record(row) || row.status !== 'passed')
    || nativeRequiredCases.some(required => report.cases.filter(row => row.id === required).length !== 1)
    || report.artifact?.buildId !== expected.buildID || report.artifact?.manifestSha256 !== expected.artifactManifestSha256
    || !/^[a-f0-9]{64}$/.test(runnerSha256 ?? '') || report.runnerSha256 !== runnerSha256
    || !/^[a-f0-9]{64}$/.test(currentSource?.sourceDigest ?? '') || !isDeepStrictEqual(report.source, currentSource)) throw fail('qa_profile_native_qualification_required');
  return { buildID: report.artifact.buildId, manifestSha256: report.artifact.manifestSha256,
    sourceDigest: report.source.sourceDigest, runnerSha256, requiredCases: [...nativeRequiredCases] };
}

export async function readQa1NativeQualification(reportFile, expected) {
  if (typeof reportFile !== 'string' || path.resolve(reportFile) !== reportFile || path.dirname(path.dirname(reportFile)) !== path.join(repository, '.cache/v2-validation')
    || path.basename(reportFile) !== 'result.json' || !/^package-[A-Za-z0-9]+$/.test(path.basename(path.dirname(reportFile)))) throw fail('qa_profile_native_qualification_required');
  await assertQaPrivateDirectory(path.dirname(reportFile));
  const bytes = await readQaPinnedFile(reportFile, undefined, 16 * 1024 * 1024);
  const run = JSON.parse(await readQaPinnedFile(path.join(path.dirname(reportFile), 'run.json'), undefined, 65536));
  const report = JSON.parse(bytes);
  if (report.root !== path.dirname(reportFile)) throw fail('qa_profile_native_qualification_required');
  const proof = assertQa1NativeQualification({ report, run, expected, currentSource: await captureNativeAcceptanceSource(),
    runnerSha256: hash(await fs.readFile(path.join(repository, 'scripts/verify-opencode-v2-package.mjs'))) });
  await readQaPinnedFile(reportFile, hash(bytes), 16 * 1024 * 1024);
  return { ...proof, reportSha256: hash(bytes) };
}

export function assertQa1ExerciseAdmission({ admitted, ready, statuses, catalog, agents, helper }) {
  if (admitted !== true) throw fail('qa_profile_manual_admission_required');
  if (ready !== true) throw fail('qa_profile_host_not_ready');
  if (!record(statuses) || Object.values(statuses).some(value => !record(value) || value.type !== 'idle')) throw fail('qa_profile_runtime_not_idle');
  if (!record(catalog) || !Array.isArray(catalog.all) || !Array.isArray(catalog.connected) || catalog.catalogIncomplete === true
    || catalog.catalogIncomplete !== undefined && typeof catalog.catalogIncomplete !== 'boolean'
    || !Array.isArray(agents)) throw fail('qa_profile_catalog_invalid');
  for (const [name, selected] of Object.entries(QA1_EXERCISE_SELECTIONS)) {
    const providers = catalog.all.filter(row => row?.id === selected.providerID);
    const model = providers.length === 1 ? providers[0].models?.[selected.modelID] : undefined;
    let matches = agents.filter(row => row?.name === name && row.hidden !== true);
    if (name === 'builder' && !matches.length) matches = agents.filter(row => row?.name === 'build' && row.hidden !== true);
    if (!catalog.connected.includes(selected.providerID) || !record(model) || !record(model.variants) || !Object.hasOwn(model.variants, selected.variant)
      || matches.length !== 1 || matches[0].hidden === true
      || name === 'explorer' && (matches[0].model?.providerID !== selected.providerID || matches[0].model?.modelID !== selected.modelID
        || matches[0].variant !== selected.variant)) throw fail('qa_profile_saved_selection_mismatch');
  }
  if (!record(helper) || helper.providerID !== DEFAULT_HELPER_MODEL_SELECTION.providerID || helper.modelID !== DEFAULT_HELPER_MODEL_SELECTION.modelID
    || !parseHelperModelSelection(helper)) throw fail('qa_profile_helper_selection_mismatch');
  const helperProvider = catalog.all.find(row => row.id === helper.providerID);
  if (!catalog.connected.includes(helper.providerID) || !record(helperProvider?.models?.[helper.modelID])) throw fail('qa_profile_helper_catalog_unavailable');
  return { selections: structuredClone(QA1_EXERCISE_SELECTIONS), helper: { providerID: helper.providerID, modelID: helper.modelID, revision: helper.revision }, selectionMode: 'per-turn-primary; saved-explorer' };
}

export async function gradeQa1ProfileFiles(fixture, { planned = false } = {}) {
  await assertQaProfileProjectFixtureOwned(fixture);
  const current = captureFixtureManifest(fixture.fixtureRoot);
  const allowed = entry => !planned && entry.path === 'src/profile-appearance.mjs';
  const unchanged = fixture.seed.manifest.tracked.every(original => allowed(original)
    || JSON.stringify(current.tracked.find(entry => entry.path === original.path)) === JSON.stringify(original));
  if (!unchanged || planned && current.untracked.some(entry => !fixture.seed.planPrefixes.some(prefix => entry.path.startsWith(prefix)))) {
    throw fail('qa_profile_protected_fixture_changed');
  }
  const protectedHashes = Object.fromEntries(await Promise.all(fixture.seed.protectedPaths.map(async file => [file, hash(await fs.readFile(path.join(fixture.fixtureRoot, file)))])));
  return { originalTrackedPreserved: unchanged, protectedHashes };
}

export function projectQa1CausalRepair(sessions, directory) {
  const events = [];
  for (const session of sessions) for (const message of session.messages) for (const part of message.parts) {
    if (part.type !== 'tool' || part.state?.status !== 'completed' || !id(part.callID)
      || !Number.isFinite(part.state.time?.start) || !Number.isFinite(part.state.time?.end)) continue;
    const input = part.state.input, file = ['filePath', 'file_path', 'path'].filter(key => typeof input?.[key] === 'string');
    const source = file.length === 1 && path.resolve(directory, input[file[0]]) === path.join(directory, 'src/profile-appearance.mjs');
    let kind = source && ['read', 'file_read', 'oc_read'].includes(part.tool) ? 'read'
      : source && ['edit', 'write', 'oc_edit', 'oc_write', 'multiedit'].includes(part.tool) ? 'mutation' : undefined;
    if (part.tool === 'apply_patch' && typeof input?.patchText === 'string'
      && [...input.patchText.matchAll(/^\*\*\* (?:Add File|Update File): (.+)$/gm)].some(match =>
        path.resolve(directory, match[1]) === path.join(directory, 'src/profile-appearance.mjs'))) kind = 'mutation';
    const selected = input?.command?.trim() === 'node --test test/profile.test.mjs'
      ? { ...part, state: { ...part.state, input: { ...input, command: 'node --test test/tasks.test.mjs' } } } : part;
    const test = projectQaNativeTestEvidence(selected, directory);
    if (kind || test) events.push({ sessionID: session.sessionID, messageID: message.info?.id, callID: part.callID, kind: kind ?? test.kind,
      start: part.state.time.start, end: part.state.time.end, ...(test ? { exitCode: test.exitCode } : {}) });
  }
  const failed = events.find(event => event.kind === 'original-test-file' && event.exitCode > 0
    && events.some(read => read.kind === 'read' && read.end <= event.start));
  const write = failed && events.find(event => event.kind === 'mutation' && event.start >= failed.end);
  const original = write && events.find(event => event.kind === 'original-test-file' && event.exitCode === 0 && event.start >= write.end);
  const suite = original && events.find(event => event.kind === 'qa-npm-suite' && event.exitCode === 0 && event.start >= original.end);
  return { passed: Boolean(suite), nativeRead: Boolean(failed), failingOriginalTest: Boolean(failed), observedCompletedMutation: Boolean(write),
    passingOriginalTest: Boolean(original), passingFullSuite: Boolean(suite), events };
}

export async function preserveQa1StartupFailure(primary, cleanup) {
  try { await cleanup(); } catch (error) {
    throw Object.assign(new AggregateError([primary, error], 'QA browser startup and owned cleanup failed', { cause: primary }),
      { code: 'qa_profile_browser_startup_cleanup_failed', qaCleanupFailed: true });
  }
  throw primary;
}

async function openBrowser({ origin, root, authenticate, signal, deadline }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw fail('qa_profile_browser_origin_invalid');
  const port = await reservePort(), profile = path.join(root, 'browser');
  const require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
  const env = createQaHostLaunchEnvironment({ HOME: root, TMPDIR: root }, { DEVRYAN_QA_ORIGIN: origin, DEVRYAN_QA_BACKGROUND: '0' });
  const processOwner = startOwnedProcess(require('electron'), [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    fileURLToPath(new URL('./browser-shell.cjs', import.meta.url))], { cwd: repository, env });
  let cdp, closing;
  const check = () => { signal.throwIfAborted(); if (performance.now() >= deadline) throw fail('qa_profile_exercise_deadline'); };
  const abort = () => cdp?.close(); signal.addEventListener('abort', abort, { once: true });
  const close = () => closing ??= (async () => {
    signal.removeEventListener('abort', abort);
    cdp?.close();
    const settled = await Promise.allSettled([processOwner.stop({ deadline: performance.now() + 15000 })]);
    // Do not remove a live browser's profile when physical cleanup is unknown.
    if (settled[0].status === 'fulfilled') await fs.rm(profile, { recursive: true, force: true });
    else throw fail('qa_profile_browser_cleanup_unconfirmed');
  })();
  try {
    check();
    const target = await discoverPageTarget(port, Math.max(1, Math.min(5000, deadline - performance.now()))); check();
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl, { timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now())) }); check();
    const bounded = { send: async (method, params, options = {}) => {
      check(); const result = await cdp.send(method, params, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 10000, 10000, deadline - performance.now())) });
      check(); return result;
    }, waitFor: (method, timeoutMs = 10000) => { check(); return cdp.waitFor(method, Math.max(1, Math.min(timeoutMs, 10000, deadline - performance.now()))); } };
    await bounded.send('Page.enable'); await bounded.send('Runtime.enable'); await bounded.send('Network.enable');
    await authenticate?.(bounded);
    await bounded.send('Page.navigate', { url: origin });
    const ui = createQaUiDriver(bounded, { signal, deadline, timeoutMs: 30000, navigationReads: true, checkAlive: () => processOwner.check() });
    return { cdp: bounded, ui, close };
  } catch (error) { return preserveQa1StartupFailure(error, close); }
}

export async function prepareQa1IndependentFiles(fixture, signal) {
  await assertQaProfileProjectFixtureOwned(fixture);
  const env = createQaHostLaunchEnvironment({ HOME: fixture.fixtureRoot, TMPDIR: fixture.evidenceDirectory,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const permissions = ['--permission', `--allow-fs-read=${fixture.fixtureRoot}`];
  // Model-authored project code gets no network, subprocess, worker, addon or
  // account filesystem permission during the independent behavior check.
  const run = args => execute(process.execPath, [...permissions, ...args], { cwd: fixture.fixtureRoot, env, signal, timeout: 30000, maxBuffer: 65536 });
  let baselineCode = 0;
  try { await run(['--test-isolation=none', '--test', 'test/profile.test.mjs']); } catch (error) { baselineCode = error.code; }
  if (baselineCode !== 1) throw fail('qa_profile_independent_suite_failed');
  return { run, baselineFailed: true };
}

export async function verifyQa1HeldOut(fixture, run) {
  const expression = `import assert from 'node:assert/strict';import {profileAppearance} from './src/profile-appearance.mjs';
    const cases=${JSON.stringify(PROFILE_QA_HELD_OUT_CASES)};for(const test of cases)for(const [index,input]of test.inputs.entries()){
      const actual=profileAppearance(input),expected=test.expectedByInput?.[index]??test.expected;
      for(const [key,value]of Object.entries(expected))assert.equal(actual[key],value);
    }process.stdout.write(JSON.stringify({passed:cases.map(test=>test.id)}));`;
  const result = await run(['--input-type=module', '-e', expression]);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.passed, PROFILE_QA_HELD_OUT_CASES.map(test => test.id));
  const files = (await fs.readdir(path.join(fixture.fixtureRoot, 'test'))).filter(file => /^[a-zA-Z0-9_.-]+\.test\.mjs$/.test(file)).map(file => `test/${file}`);
  await run(['--test-isolation=none', '--test', ...files]);
  return { passed: value.passed, standaloneSuitePassed: true, permissionConfined: true };
}

async function verifyPublicBrowser(fixture, signal, deadline) {
  const port = await reservePort(), origin = `http://127.0.0.1:${port}`;
  const root = path.join(fixture.evidenceDirectory, 'public-browser'); await fs.mkdir(root, { mode: 0o700 });
  const env = createQaHostLaunchEnvironment({ HOME: fixture.fixtureRoot, TMPDIR: fixture.evidenceDirectory, PORT: String(port) });
  env.PORT = String(port);
  const server = startOwnedProcess(process.execPath, ['--permission', `--allow-fs-read=${fixture.fixtureRoot}`, '--allow-net', 'src/server.mjs'],
    { cwd: fixture.fixtureRoot, env });
  let browser, failure;
  const scenes = [];
  try {
    for (;;) {
      signal.throwIfAborted(); server.check();
      if (performance.now() >= deadline) throw fail('qa_profile_exercise_deadline');
      try { const response = await fetch(origin, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'error' });
        await response.body?.cancel(); if (response.ok) break; } catch (error) { signal.throwIfAborted(); if (error.code?.startsWith('qa_')) throw error; }
      await pause(100);
    }
    // This separate, unauthenticated profile never receives the application
    // owner's cookie (cookies are host-scoped, not port-scoped).
    browser = await openBrowser({ origin, root, signal, deadline });
    const routes = { professional: '/professionals/demo', clinic: '/clinics/demo', service: '/services/demo', editor: '/dashboard/professional/profile' };
    const rgb = color => color === 'transparent' ? 'rgba(0, 0, 0, 0)'
      : `rgb(${[1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).join(', ')})`;
    for (const test of PROFILE_QA_HELD_OUT_CASES) for (const [index, input] of test.inputs.entries()) {
      signal.throwIfAborted();
      const mobile = test.id === 'signed-out-mobile-viewport';
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1280,
        height: input.visualViewportHeight, deviceScaleFactor: 1, mobile });
      const query = new URLSearchParams({ theme: input.theme, signedIn: input.signedIn ? '1' : '0' });
      await browser.cdp.send('Page.navigate', { url: `${origin}${routes[input.surface]}?${query}` });
      await browser.ui.waitExpression('profile fixture appearance loaded', `document.body?.dataset.theme===${JSON.stringify(input.theme)}&&Boolean(document.querySelector('#profile-title')?.textContent)`);
      if (input.scrolled) await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 300, deltaX: 0, deltaY: 500 });
      const actual = await browser.ui.waitFor('actual profile held-out styles', async () => {
        const value = await evaluate(browser.cdp, `(() => {
          const css=id=>getComputedStyle(document.querySelector(id));
          return {chatBottom:parseFloat(css('#chat').bottom),navigationVisible:!document.querySelector('#bottom-nav').hidden,
            selectedTabFill:css('[role=tab][aria-selected=true]').backgroundColor,headerFill:css('#profile-header').backgroundColor,
            qualificationFill:css('#qualifications').backgroundColor,qualificationBorder:css('#qualifications').borderTopColor,
            certificationFill:css('#certifications').backgroundColor,certificationBorder:css('#certifications').borderTopColor,
            layoutViewportHeight:innerHeight,visualViewportHeight:visualViewport.height,scrollY};})()`);
        if (input.scrolled && value.scrollY <= 0) return false;
        const expected = test.expectedByInput?.[index] ?? test.expected;
        for (const [key, selected] of Object.entries(expected)) if (value[key] !== (typeof selected === 'string' ? rgb(selected) : selected)) return false;
        return value;
      });
      const screenshot = `heldout-${test.id}-${index}.png`;
      const result = await browser.cdp.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(fixture.evidenceDirectory, screenshot), Buffer.from(result.data, 'base64'), { flag: 'wx', mode: 0o600 });
      scenes.push({ caseID: test.id, index, surface: input.surface, theme: input.theme, mobile, actual, screenshot });
    }
  } catch (error) { failure = error; }
  const cleanup = await Promise.allSettled([browser?.close(), server.stop({ deadline: performance.now() + 15000 })]);
  if (cleanup.some(row => row.status === 'rejected')) return preserveQa1StartupFailure(failure ?? fail('qa_profile_public_browser_cleanup_failed'), async () => { throw fail('qa_profile_public_browser_cleanup_failed'); });
  if (failure) throw failure;
  return { passed: true, scenes, cookieInstalled: false, mobileScope: 'emulated viewport resize; actual browser chrome movement is not qualified' };
}

export const QA1_ADDITIONAL_AGENT_CASES = Object.freeze(['inspect', 'repair-and-test', 'managed-independent']);

export async function runQa1AdditionalAgentTasks({ root, api, origin, signal, deadline, beforeRequest, activate,
  caseExecutor = executeEvaluationCase, sessionRunner = runSessionTurn }) {
  const directory = path.join(root, 'agent-tasks');
  await fs.mkdir(path.join(directory, 'src'), { recursive: true, mode: 0o700 });
  const env = createQaHostLaunchEnvironment({ HOME: directory, TMPDIR: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  await fs.writeFile(path.join(directory, 'AGENTS.md'), '# Disposable QA tasks\nWork only in this fixture. Preserve existing tests. No dependencies, commits, network or account access.\n', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(directory, 'src/smoke.test.mjs'), "import{test}from'node:test';import assert from'node:assert/strict';test('seed',()=>assert.equal(1+1,2));\n", { flag: 'wx', mode: 0o600 });
  const template = path.join(root, 'agent-git-template'); await fs.mkdir(template, { mode: 0o700 });
  const git = args => execute('/usr/bin/git', args, { cwd: directory, env, timeout: 10000, signal });
  await git(['init', '-q', '--initial-branch=qa-agent-tasks', `--template=${template}`]); await git(['add', '.']);
  await git(['-c', 'user.name=DevRyan QA', '-c', 'user.email=qa@devryan.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Seed disposable QA tasks']);
  await activate(directory);
  const client = createEvaluationClient({ baseUrl: origin, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin || !parsed.pathname.startsWith('/api/')) throw fail('qa_profile_api_invalid');
    if (/\/prompt_async$/.test(parsed.pathname)) await beforeRequest();
    // The existing eval client supplies fresh independent cancellation signals
    // for tree cleanup. Do not replace them with the aborted main signal.
    return Response.json(await api(parsed.pathname + parsed.search, options));
  } });
  const testRunner = async ({ fixtureRoot, testRelativePath, timeoutMs }) => {
    if (fixtureRoot !== directory) throw fail('qa_profile_fixture_owner_invalid');
    const files = testRelativePath ? [testRelativePath] : ['src/smoke.test.mjs'];
    try {
      const result = await execute(process.execPath, ['--permission', `--allow-fs-read=${directory}`, '--test-isolation=none', '--test', ...files],
        { cwd: directory, env, signal, timeout: Math.max(1, Math.ceil(Math.min(30000, timeoutMs, deadline - performance.now()))), maxBuffer: 65536 });
      return { exitCode: 0, timedOut: false, stdout: result.stdout, stderr: result.stderr, outputTruncated: false };
    } catch (error) {
      return { exitCode: Number.isInteger(error.code) ? error.code : null, timedOut: error.killed === true,
        signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', outputTruncated: false };
    }
  };
  const results = [];
  for (const caseId of QA1_ADDITIONAL_AGENT_CASES) {
    signal.throwIfAborted(); await beforeRequest();
    const timeoutMs = Math.max(1, Math.min(180000, deadline - performance.now()));
    if (timeoutMs < 1000) throw fail('qa_profile_exercise_deadline');
    const startingManifest = assertFixtureReady(directory), runFiles = allocateRunFiles(directory, `qa1-${caseId}`);
    const selected = { providerId: 'openai', modelId: 'gpt-6-astra', variant: 'medium',
      agent: caseId === 'managed-independent' ? 'orchestrator' : 'builder' };
    const result = await caseExecutor({ caseId, repetition: 1, fixtureRoot: directory, startingManifest, runFiles, selection: selected,
      timeoutMs, client, testRunner, sessionRunner: async options => {
        const result = await sessionRunner({ ...options, signal });
        const root = result.sessionTree?.find(row => row.sessionId === result.rootSessionId);
        if (!root?.messages.some(row => row.info?.role === 'user' && row.info.agent === selected.agent
          && row.info.model?.providerID === selected.providerId && row.info.model?.modelID === selected.modelId
          && (row.info.model.variant ?? row.info.variant) === selected.variant)) throw fail('qa_profile_canonical_selection_mismatch');
        for (const task of result.managedSnapshot?.tasks ?? []) if (task.agent === 'explorer') {
          const child = result.sessionTree?.find(row => row.sessionId === task.childSessionId);
          if (task.providerId !== 'cursor-acp' || task.modelId !== 'grok-4.6' || task.variant !== 'medium'
            || !child?.messages.some(row => row.info?.role === 'user' && row.info.model?.providerID === 'cursor-acp'
              && row.info.model?.modelID === 'grok-4.6' && (row.info.model.variant ?? row.info.variant) === 'medium')) throw fail('qa_profile_grok_execution_unobserved');
        }
        return result;
      } });
    results.push({ caseId, status: result.status === 'passed' ? 'passed' : 'failed', selection: selected,
      durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
      graders: (result.graders ?? []).map(row => ({ id: row.id, passed: row.passed === true })),
      sessionIDs: (result.sessionIds ?? []).filter(id),
      cleanup: { restored: result.cleanup?.restored === true, sessionComplete: result.cleanup?.sessionComplete === true,
        sessionDiscoveryComplete: result.cleanup?.sessionDiscoveryComplete === true, sessionAbortFailureCount: result.cleanup?.sessionAbortFailureCount ?? null } });
    if (result.status !== 'passed' || result.cleanup?.restored !== true) break;
  }
  return results;
}

/** Only the original attended handoff supplies these constructor closures.
 * No URL, cookie, credential store or checkpoint is accepted from a CLI flag. */
export async function runQa1ProfileExercise({ api, authenticateBrowser, inspectPublication, retainMediumSample, readSettlementJournal, origin, admitted, ready, ensureCurrent, qualificationReport, selectedIdentity, signal: parentSignal }) {
  if (admitted() !== true) throw fail('qa_profile_manual_admission_required');
  const qualification = await readQa1NativeQualification(qualificationReport, selectedIdentity);
  const controller = new AbortController(), signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const deadline = performance.now() + 15 * 60_000;
  const timer = setTimeout(() => controller.abort(fail('qa_profile_exercise_deadline')), 15 * 60_000);
  const check = async () => { signal.throwIfAborted(); await ensureCurrent(); if (!ready()) throw fail('qa_profile_host_not_ready'); };
  const request = async (route, options = {}) => { await check(); const value = await api(route, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }); await check(); return value; };
  const wait = async action => { for (;;) { await check(); const result = await action(); if (result) return result; await pause(250); } };
  let fixture, browser, sessionID, previousSettings, explorerSelection, changedProject = false;
  const ownedDirectories = new Set();
  let outcome = 'failed';
  const evidence = { schemaVersion: 1, status: 'failed', inference: 'not-run', accountCopy: 'not-run', providerCredentialExport: false,
    qualification, scope: 'original-profile-behavior-and-canonical-tool-observation',
    nativeLivePublicationReceipt: { status: 'gap', reason: 'completed-canonical-mutation-and-current-files-do-not-replace-the-original-durable-lease-receipt' },
    helper: { status: 'gap', reason: 'saved-selection-checked-physical-helper-sampling-not-owned-by-this-driver' },
    silence: { status: 'gap', reason: 'existing-source-and-compiled-synthetic-silence-cases-do-not-establish-live-provider-silence' } };
  evidence.receiptSettlement = [];
  const startSettlement = async previousUserIDs => {
    if (!readSettlementJournal) return null;
    try { return await startReceiptSettlementProbe({ cdp: browser.cdp, sessionID, directory: fixture.fixtureRoot, previousUserIDs,
      timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }); }
    catch {
      await closeReceiptSettlementProbe(browser.cdp);
      evidence.receiptSettlement.push({ status: 'gap', reason: 'renderer-clock-or-probe-unavailable' });
      return null;
    }
  };
  const finishSettlement = async (probe, objectiveID, rows, since, workload) => {
    try {
      const observation = await finishReceiptSettlementProbe({ cdp: browser.cdp, ...probe, wait });
      const journal = await readSettlementJournal({ sessionIDs: [sessionID], directory: fixture.fixtureRoot, since, until: Date.now() });
      evidence.receiptSettlement.push(joinReceiptSettlement({ journal, rows, sessionID, objectiveID, probe: observation,
        cohort: { ...selectedIdentity, sourceDigest: qualification.sourceDigest, runnerSha256: qualification.runnerSha256, uiSha256: evidence.uiArtifact.sha256,
          workload, agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-6-astra', variant: 'medium' } }));
    } catch {
      await closeReceiptSettlementProbe(browser.cdp);
      evidence.receiptSettlement.push({ status: 'gap', reason: 'settlement-observation-unavailable' });
    }
  };
  let failure, startupCleanupFailed = false;
  try {
    previousSettings = await request('/api/config/settings');
    if (typeof previousSettings.lastDirectory !== 'string') throw fail('qa_profile_directory_restore_unavailable');
    const initialQuery = `?directory=${encodeURIComponent(previousSettings.lastDirectory)}`;
    const initialCatalog = await collectQa1ExerciseCatalog(request, previousSettings.lastDirectory);
    const initialAgents = await request(`/api/agent${initialQuery}`);
    // Validate every other admission predicate before the exact effort change.
    assertQa1ExerciseAdmission({ admitted: admitted(), ready: ready(), statuses: await request('/api/session/status'), catalog: initialCatalog,
      agents: initialAgents.map(row => row.name === 'explorer' ? { ...row, variant: 'medium' } : row), helper: previousSettings.helperModelSelection });
    explorerSelection = createQa1ExplorerSelectionOwner({ api, directory: previousSettings.lastDirectory });
    await explorerSelection.apply(request);
    const selection = assertQa1ExerciseAdmission({ admitted: admitted(), ready: ready(), statuses: await request('/api/session/status'),
      catalog: initialCatalog, agents: await request(`/api/agent${initialQuery}`), helper: previousSettings.helperModelSelection });
    evidence.selection = selection;
    fixture = await createQaProfileProjectFixture({ runId: 'qa1-original-profile', keepArtifacts: true });
    const independent = await prepareQa1IndependentFiles(fixture, signal); evidence.baselineFailed = independent.baselineFailed;
    const initialProtected = await gradeQa1ProfileFiles(fixture, { planned: true });
    changedProject = true; ownedDirectories.add(fixture.fixtureRoot);
    await request('/api/opencode/directory', { method: 'POST', body: JSON.stringify({ path: fixture.fixtureRoot }) });
    const query = `directory=${encodeURIComponent(fixture.fixtureRoot)}`;
    const after = await request(`/api/agent?${query}`);
    assertQa1ExerciseAdmission({ admitted: admitted(), ready: ready(), statuses: await request('/api/session/status'),
      catalog: await collectQa1ExerciseCatalog(request, fixture.fixtureRoot), agents: after, helper: previousSettings.helperModelSelection });
    const session = await request(`/api/session?${query}`, { method: 'POST', body: JSON.stringify({ title: 'QA1 original profile request', agent: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-6-astra' } }) });
    if (!id(session?.id) || !Number.isSafeInteger(session.time?.created) || typeof session.slug !== 'string') throw fail('qa_profile_session_invalid');
    sessionID = session.id; evidence.sessionID = sessionID;
    browser = await openBrowser({ origin, root: fixture.evidenceDirectory, authenticate: authenticateBrowser, signal, deadline });
    await browser.cdp.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(sessionID)}` });
    await browser.ui.waitExpression('owned QA1 composer', 'Boolean(document.querySelector("textarea"))');
    const manifest = JSON.parse(await fs.readFile(path.join(repository, 'packages/web/dist/.vite/manifest.json'), 'utf8'));
    const entry = manifest['index.html'];
    if (entry?.isEntry !== true || typeof entry.file !== 'string' || !/^assets\/[a-zA-Z0-9_.-]+\.js$/.test(entry.file)) throw fail('qa_profile_ui_artifact_invalid');
    const expectedUI = hash(await fs.readFile(path.join(repository, 'packages/web/dist', entry.file)));
    const loadedUI = await evaluate(browser.cdp, `(async()=>{const script=[...document.scripts].find(s=>new URL(s.src,location.href).pathname===${JSON.stringify('/' + entry.file)});
      if(!script)return null;const response=await fetch(script.src,{cache:'no-store'});if(!response.ok)return null;
      const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');})()`);
    if (loadedUI !== expectedUI) throw fail('qa_profile_ui_artifact_changed');
    evidence.uiArtifact = { file: entry.file, sha256: expectedUI, sourceBuildQualification: 'separate-root-gate' };
    const messageID = createV2MessageId();
    await readQa1NativeQualification(qualificationReport, selectedIdentity);
    const mediumSince = Date.now();
    const planProbe = await startSettlement([]);
    evidence.inference = 'request-attempted';
    await request(`/api/session/${sessionID}/prompt_async?${query}`, { method: 'POST', body: JSON.stringify({ messageID, agent: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'medium', planMode: true,
      parts: [{ type: 'text', text: loadPlanModeInstruction(), synthetic: true }, { type: 'text', text: fixture.prompts.initial }] }) });
    evidence.inference = 'request-accepted';
    const messages = () => request(`/api/session/${sessionID}/message?${query}&limit=200`);
    const settled = async () => {
      const statuses = await request(`/api/session/status?${query}`), rows = await messages();
      if (!Array.isArray(rows)) throw fail('qa_profile_messages_invalid');
      if (rows.some(row => row.info?.role === 'assistant' && row.info.error)) throw fail('qa_profile_turn_failed');
      return findQaCompletedTurnAssistant({ rows, previousIds: new Set(), submittedUser: rows.findLast(row => row.info?.role === 'user'),
        sessionID, status: statuses }) ? rows : false;
    };
    let rows = await wait(settled);
    if (planProbe) await finishSettlement(planProbe, messageID, rows, mediumSince, 'qa1-profile-plan');
    else evidence.receiptSettlement.push({ status: 'gap', reason: 'attended-journal-owner-unavailable' });
    const user = rows.find(row => row.info?.id === messageID);
    if (user?.info?.agent !== 'orchestrator' || user.info.model?.providerID !== 'openai' || user.info.model?.modelID !== 'gpt-6-astra'
      || (user.info.model.variant ?? user.info.variant) !== 'medium') throw fail('qa_profile_canonical_selection_mismatch');
    assertQaSubmittedPlanMode(user, true);
    let saved;
    await wait(async () => {
      for (const source of rows.filter(row => row.info?.role === 'assistant' && row.info.time?.completed).toReversed()) {
        try {
          const identity = new URLSearchParams({ directory: fixture.fixtureRoot, sessionCreated: String(session.time.created), sessionSlug: session.slug });
          const revision = await request(`/api/session/${sessionID}/plan-revisions/${source.info.id}?${identity}`);
          if (typeof revision?.content !== 'string' || !/^[a-f0-9]{64}$/.test(revision.version ?? '')
            || hash(revision.content) !== revision.version || revision.sourceIdentity?.current !== true) throw fail('qa_profile_saved_plan_invalid');
          saved = { sourceMessageID: source.info.id, version: revision.version, sha256: hash(revision.content) }; return true;
        } catch (error) { if (error.code !== 'qa_profile_api_not_found') throw error; }
      }
      return false;
    });
    evidence.plan = { ...saved, ...await gradeQa1ProfileFiles(fixture, { planned: true }) };
    assert.deepEqual(evidence.plan.protectedHashes, initialProtected.protectedHashes);
    const approval = `[data-plan-source-message-id=${JSON.stringify(saved.sourceMessageID)}] button`;
    await browser.ui.reveal(approval, 'Implement Plan', { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
    const before = new Set(rows.map(row => row.info.id));
    await readQa1NativeQualification(qualificationReport, selectedIdentity);
    await browser.ui.waitExpression('canonical Astra Medium selection restored before approval', `(() => {
      const selected=window.__zustand_config_store__?.getState();
      return selected?.currentAgentName==='orchestrator'&&selected.currentProviderId==='openai'
        &&selected.currentModelId==='gpt-6-astra'&&selected.currentVariant==='medium';})()`);
    const implementSince = Date.now();
    const implementProbe = await startSettlement(rows.filter(row => row.info.role === 'user').map(row => row.info.id));
    await browser.ui.click({ selector: approval, text: 'Implement Plan' });
    rows = await wait(async () => {
      const next = await settled();
      return next && next.some(row => row.info.role === 'user' && !before.has(row.info.id)
        && row.parts.some(part => part.type === 'text' && part.text.startsWith('[openchamber-plan-action:v1] ')))
        && next.some(row => row.info.role === 'assistant' && !before.has(row.info.id) && row.info.time?.completed) ? next : false;
    });
    const approvalUsers = rows.filter(row => row.info.role === 'user' && !before.has(row.info.id)
      && row.parts.some(part => part.type === 'text' && part.synthetic === true && part.text.startsWith('[openchamber-plan-action:v1] ')));
    if (approvalUsers.length !== 1) throw fail('qa_profile_plan_approval_invalid');
    const approved = approvalUsers[0], markers = approved.parts.filter(part => part.type === 'text' && part.synthetic === true
      && part.text.startsWith('[openchamber-plan-action:v1] '));
    if (markers.length !== 1) throw fail('qa_profile_plan_approval_invalid');
    assert.deepEqual(JSON.parse(markers[0].text.slice('[openchamber-plan-action:v1] '.length)), { action: 'implement', sourceSessionId: sessionID,
      sourceMessageId: saved.sourceMessageID, planIndex: 0, projectDirectory: fixture.fixtureRoot, version: saved.version });
    if (approved.info.agent !== 'orchestrator' || approved.info.model?.providerID !== 'openai' || approved.info.model?.modelID !== 'gpt-6-astra'
      || (approved.info.model.variant ?? approved.info.variant) !== 'medium') throw fail('qa_profile_canonical_selection_mismatch');
    assertQaSubmittedPlanMode(approved, false);
    if (implementProbe) await finishSettlement(implementProbe, approved.info.id, rows, implementSince, 'qa1-profile-implement');
    evidence.approval = 'actual-plan-card-click';
    await browser.close(); browser = undefined;
    evidence.files = await gradeQa1ProfileFiles(fixture);
    assert.deepEqual(evidence.files.protectedHashes, initialProtected.protectedHashes);
    evidence.heldOut = await verifyQa1HeldOut(fixture, independent.run);
    evidence.browser = await verifyPublicBrowser(fixture, signal, deadline);
    evidence.tasks = await captureQaTaskEvidence({ api: request, rootSessionID: sessionID, directory: fixture.fixtureRoot,
      agent: 'orchestrator', requireProjectWork: false, timeoutMs: 30000 });
    if (!evidence.tasks.passed) throw fail('qa_profile_task_evidence_failed');
    const snapshot = await request(`/api/orchestration/snapshot?rootSessionId=${encodeURIComponent(sessionID)}`);
    const explorer = snapshot.tasks?.filter(task => task.agent === 'explorer');
    if (!Array.isArray(explorer) || !explorer.length || explorer.some(task => task.providerId !== 'cursor-acp' || task.modelId !== 'grok-4.6'
      || task.variant !== 'medium' || !id(task.childSessionId))) throw fail('qa_profile_grok_execution_unobserved');
    const sessions = [{ sessionID, messages: rows }];
    for (const childID of evidence.tasks.sessionIDs.filter(value => value !== sessionID)) {
      sessions.push({ sessionID: childID, messages: await request(`/api/session/${childID}/message?${query}&limit=200`) });
    }
    for (const task of explorer) {
      const child = sessions.find(session => session.sessionID === task.childSessionId);
      if (!child?.messages.some(message => message.info?.role === 'user' && message.info.model?.providerID === 'cursor-acp'
        && message.info.model?.modelID === 'grok-4.6' && (message.info.model.variant ?? message.info.variant) === 'medium')) throw fail('qa_profile_grok_execution_unobserved');
    }
    evidence.explorer = { canonicalChildSelectionsVerified: true, childSessionIDs: explorer.map(task => task.childSessionId),
      providerID: 'cursor-acp', modelID: 'grok-4.6', variant: 'medium' };
    evidence.repair = projectQa1CausalRepair(sessions, fixture.fixtureRoot);
    if (!evidence.repair.passed) throw fail('qa_profile_causal_repair_unobserved');
    const publications = [];
    for (const event of evidence.repair.events.filter(event => event.kind === 'mutation')) {
      if (!id(event.messageID)) throw fail('qa_profile_publication_scope_invalid');
      publications.push(await inspectPublication({ directory: fixture.fixtureRoot, sessionID: event.sessionID, messageID: event.messageID, callID: event.callID }));
    }
    if (!publications.length || publications.some(value => value?.published !== true || value.scopeVerified !== true || value.terminated !== true
      || value.confined !== true || value.cancelled !== false || value.exitCode !== 0)) throw fail('qa_profile_live_publication_unconfirmed');
    evidence.nativeLivePublicationReceipt = { status: 'passed', records: publications };
    retainMediumSample?.({ sessionID, messageID, directory: fixture.fixtureRoot, since: mediumSince, until: Date.now(),
      providerID: 'openai', modelID: 'gpt-6-astra', variant: 'medium', canonicalSelectionVerified: true });
    evidence.additionalAgentTasks = await runQa1AdditionalAgentTasks({ root: fixture.evidenceDirectory, api, origin, signal, deadline,
      beforeRequest: async () => { await check(); await readQa1NativeQualification(qualificationReport, selectedIdentity); },
      activate: async directory => { ownedDirectories.add(directory); await request('/api/opencode/directory', { method: 'POST', body: JSON.stringify({ path: directory }) });
        assertQa1ExerciseAdmission({ admitted: admitted(), ready: ready(), statuses: await request('/api/session/status'),
          catalog: await collectQa1ExerciseCatalog(request, directory), agents: await request(`/api/agent?directory=${encodeURIComponent(directory)}`), helper: previousSettings.helperModelSelection }); } });
    if (evidence.additionalAgentTasks.some(row => row.status !== 'passed' || !row.cleanup.restored)) throw fail('qa_profile_additional_tasks_failed');
    evidence.inference = 'completed'; outcome = 'passed';
  } catch (error) { failure = error; startupCleanupFailed = error?.qaCleanupFailed === true; evidence.code = code(error); }
  finally {
    const cleanup = startupCleanupFailed ? ['qa_profile_browser_cleanup_unconfirmed'] : [];
    if (sessionID && fixture) try {
      const result = await cleanupQaSessionTree({ api, rootSessionID: sessionID, directory: fixture.fixtureRoot, timeoutMs: 12000 });
      if (!result.complete) throw fail('qa_profile_session_cleanup_failed');
    } catch (error) { cleanup.push(code(error)); }
    if (browser) try { await closeReceiptSettlementProbe(browser.cdp); } catch (error) { cleanup.push(code(error)); }
    try { await browser?.close(); } catch (error) { cleanup.push(code(error)); }
    try { await explorerSelection?.restore(); } catch (error) { cleanup.push(code(error)); }
    if (changedProject) try {
      const latest = await api('/api/config/settings');
      if (ownedDirectories.has(latest.lastDirectory)) {
        if (typeof previousSettings.lastDirectory !== 'string') throw fail('qa_profile_directory_restore_unavailable');
        await api('/api/opencode/directory', { method: 'POST', body: JSON.stringify({ path: previousSettings.lastDirectory }) });
        const restored = await api('/api/config/settings');
        if (restored.lastDirectory === previousSettings.lastDirectory) await api('/api/config/settings', { method: 'PUT',
          body: JSON.stringify({ activeProjectId: previousSettings.activeProjectId ?? null, lastDirectory: previousSettings.lastDirectory }) });
        else throw fail('qa_profile_directory_restore_changed');
      }
    } catch (error) { cleanup.push(code(error)); }
    clearTimeout(timer); evidence.cleanup = { passed: cleanup.length === 0, codes: cleanup };
    if (cleanup.length) { outcome = 'failed'; failure ??= fail('qa_profile_cleanup_failed'); }
    evidence.status = outcome;
    if (fixture) {
      const sanitizer = createDiagnosticSanitizer({ homeDir: fixture.fixtureRoot,
        pathMappings: [{ path: fixture.evidenceDirectory, placeholder: '<QA_RUN>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
      await fs.writeFile(path.join(fixture.evidenceDirectory, 'exercise-result.json'), JSON.stringify(sanitizer.sanitizeExportValue(evidence), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await finishQaProfileProjectFixture(fixture, outcome);
    }
  }
  return { status: 'profile-exercise-finished', outcome, ...(failure ? { code: code(failure) } : {}),
    evidenceDirectory: fixture?.evidenceDirectory ?? null, inference: evidence.inference, cleanup: evidence.cleanup, accountCopy: 'not-run',
    receiptSettlement: evidence.receiptSettlement,
    fullLiveQualification: false, outstandingChecks: ['physical-helper-sampling', 'live-provider-silence', 'actual-mobile-browser-chrome'] };
}
