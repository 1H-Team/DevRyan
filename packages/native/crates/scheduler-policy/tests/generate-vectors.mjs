#!/usr/bin/env node
// Writes the scheduler-policy vectors (tests/vectors/*.jsonl): every row is a
// call of the REAL modules of packages/orchestration-runtime on an input built
// here (seeded, so the files are the same on every machine) or captured from
// the real scheduler driven under Node, with the JavaScript's outcome. The
// crate's cargo test requires the Rust to give the same outcome for every
// row; the workspace's Rust-free contract regenerates every file in memory
// and requires the tracked bytes.
//
//   node generate-vectors.mjs           rewrite the tracked files
//   node generate-vectors.mjs --check   exit 1 when a tracked file differs
//
// The format is in vector-format.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOps, encode, encodeThrow, repeated } from './vector-format.mjs';
import * as autoResume from '../../../../orchestration-runtime/auto-resume-policy.js';
import * as approvedPlan from '../../../../orchestration-runtime/approved-plan.js';
import * as checkCorrection from '../../../../orchestration-runtime/check-correction.js';
import * as codec from '../../../../orchestration-runtime/codec.js';
import * as contract from '../../../../orchestration-runtime/contract.js';
import * as stepBudget from '../../../../orchestration-runtime/designer-step-budget.js';
import * as segments from '../../../../orchestration-runtime/native-job-segments.js';
import * as proofStore from '../../../../orchestration-runtime/native-job-proof-store.js';
import * as persistence from '../../../../orchestration-runtime/persistence.js';
import * as capabilities from '../../../../orchestration-runtime/provider-capabilities.js';
import * as retry from '../../../../orchestration-runtime/provider-retry-policy.js';
import * as requiredChecks from '../../../../orchestration-runtime/required-checks.js';
import * as envelopes from '../../../../orchestration-runtime/result-envelope.js';
import * as scheduler from '../../../../orchestration-runtime/scheduler.js';
import * as prerequisites from '../../../../orchestration-runtime/task-prerequisites.js';
import * as transitions from '../../../../orchestration-runtime/transitions.js';
import * as transport from '../../../../orchestration-runtime/transport-recovery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VECTOR_DIR = path.join(HERE, 'vectors');
const RUNTIME_DIR = path.join(HERE, '..', '..', '..', '..', 'orchestration-runtime');

/** mulberry32: a seeded PRNG of integer arithmetic only (the same everywhere). */
function prng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const int = (count) => Math.floor(next() * count);
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p };
}

// ---------------------------------------------------------------------------
// Calls: the vector name of each function and how a row's arguments reach it.

const sameOrEncode = (result, args) => {
  const index = args.findIndex(arg => arg !== null && typeof arg === 'object' && arg === result);
  return index >= 0 ? { $: 'arg', index } : encode(result);
};

const breakerFrom = (table) => table === null ? null
  : (providerId) => (typeof providerId === 'string' && Object.hasOwn(table, providerId) ? table[providerId] : undefined);

const createErrorFrom = (name) => name === 'tagged'
  ? (code, detail) => Object.assign(new RangeError(`${code}:${JSON.stringify(detail)}`), { code: `x_${code}` })
  : undefined;

/** The JavaScript of every vector function name. */
const CALLS = {
  failureText: (value) => ({
    a: retry.isProviderAuthenticationFailure(value),
    c: retry.isProviderConfigurationFailure(value),
    k: retry.isManagedTaskCapabilityFailure(value),
    r: retry.classifyProviderRetryFailure(value),
    u: retry.isDefiniteProviderUsageLimit(value),
    p: retry.isProviderPromptRejected(value),
    d: retry.isManagedTaskDeadlineExceeded(value),
    m: retry.isManagedTaskModelUnavailable(value),
    f: retry.classifyManagedTaskFailure(value),
    t: retry.classifyProviderTransportFailure(null, value),
    n: retry.classifyProviderTransportFailure(value, null),
    s: retry.classifyProviderRetryStatus({ message: value }),
  }),
  formatManagedTaskFailureReason: retry.formatManagedTaskFailureReason,
  classifyProviderTransportFailure: retry.classifyProviderTransportFailure,
  classifyProviderRetryStatus: retry.classifyProviderRetryStatus,
  supportsManagedReadOnlyProvider: (id, options) => capabilities.supportsManagedReadOnlyProvider(id, options),
  truncateManagedText: contract.truncateManagedText,
  isManagedTaskId: codec.isManagedTaskId,
  compareManagedTaskQueueOrder: scheduler.compareManagedTaskQueueOrder,
  canTransitionManagedTaskStatus: transitions.canTransitionManagedTaskStatus,
  managedNativeJobProofShard: proofStore.managedNativeJobProofShard,
  managedNativeJobProofShardFile: proofStore.managedNativeJobProofShardFile,
  isManagedNativeJobProofShard: proofStore.isManagedNativeJobProofShard,
  createLineageId: autoResume.createLineageId,
  findManagedResultPayloadMismatch: (task, envelope, options) => codec.findManagedResultPayloadMismatch(task, envelope, options),
  isAutoResumeActiveState: codec.isAutoResumeActiveState,
  isAutoResumeActive: autoResume.isAutoResumeActive,
  constants: () => ({
    MANAGED_TASK_ID_PREFIX: codec.MANAGED_TASK_ID_PREFIX,
    MANAGED_WAVE_ID_PREFIX: codec.MANAGED_WAVE_ID_PREFIX,
    MANAGED_TASK_STATUSES: codec.MANAGED_TASK_STATUSES,
    MANAGED_TASK_LIVE_STATUSES: codec.MANAGED_TASK_LIVE_STATUSES,
    MANAGED_TASK_TERMINAL_STATUSES: codec.MANAGED_TASK_TERMINAL_STATUSES,
    MANAGED_TASK_FAILURE_KINDS: codec.MANAGED_TASK_FAILURE_KINDS,
    AUTO_RESUME_STATES: codec.AUTO_RESUME_STATES,
    AUTO_RESUME_ACTIVE_STATES: codec.AUTO_RESUME_ACTIVE_STATES,
    AUTO_RESUME_RESET_SOURCES: codec.AUTO_RESUME_RESET_SOURCES,
    AUTO_RESUME_REASONS: codec.AUTO_RESUME_REASONS,
    MANAGED_RESULT_PAYLOAD_FIELDS: codec.MANAGED_RESULT_PAYLOAD_FIELDS,
    MANAGED_RESULT_COMPACTED_FIELDS: codec.MANAGED_RESULT_COMPACTED_FIELDS,
    MANAGED_TASK_OWNER: contract.MANAGED_TASK_OWNER,
    MAX_MANAGED_TASK_LABEL_BYTES: contract.MAX_MANAGED_TASK_LABEL_BYTES,
    MAX_MANAGED_TASK_PROMPT_BYTES: contract.MAX_MANAGED_TASK_PROMPT_BYTES,
    MAX_MANAGED_TASK_PREVIEW_BYTES: contract.MAX_MANAGED_TASK_PREVIEW_BYTES,
    MAX_MANAGED_TASK_FAILURE_BYTES: contract.MAX_MANAGED_TASK_FAILURE_BYTES,
    MANAGED_TASK_WAITING_REASON_KINDS: contract.MANAGED_TASK_WAITING_REASON_KINDS,
    DUPLICATE_DISPATCH_WINDOW_MS: scheduler.DUPLICATE_DISPATCH_WINDOW_MS,
    PROVIDER_TRANSPORT_FAILURE_KINDS: retry.PROVIDER_TRANSPORT_FAILURE_KINDS,
    MANAGED_TASK_TIMEOUT_REASON_PREFIX: retry.MANAGED_TASK_TIMEOUT_REASON_PREFIX,
    DEFAULT_MANAGED_TERMINAL_MAX_RECORDS: persistence.DEFAULT_MANAGED_TERMINAL_MAX_RECORDS,
    DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS: persistence.DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS,
    DEFAULT_MANAGED_LEDGER_MAX_BYTES: persistence.DEFAULT_MANAGED_LEDGER_MAX_BYTES,
    MAX_RETAINED_LINEAGE_RECORDS: persistence.MAX_RETAINED_LINEAGE_RECORDS,
    MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT,
    AUTO_RESUME_MAX_ATTEMPTS: autoResume.AUTO_RESUME_MAX_ATTEMPTS,
    AUTO_RESUME_MAX_LINEAGE_MS: autoResume.AUTO_RESUME_MAX_LINEAGE_MS,
    AUTO_RESUME_BACKOFF_MS: autoResume.AUTO_RESUME_BACKOFF_MS,
    AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW: autoResume.AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW,
    AUTO_RESUME_MAX_HOST_FAILURES: autoResume.AUTO_RESUME_MAX_HOST_FAILURES,
    AUTO_RESUME_RESET_JITTER_MS: autoResume.AUTO_RESUME_RESET_JITTER_MS,
    AUTO_RESUME_MIN_DELAY_MS: autoResume.AUTO_RESUME_MIN_DELAY_MS,
    AUTO_RESUME_HOST_RETRY_MS: autoResume.AUTO_RESUME_HOST_RETRY_MS,
    MANAGED_LINEAGE_ID_PREFIX: autoResume.MANAGED_LINEAGE_ID_PREFIX,
    MANAGED_NATIVE_JOB_PROOF_DIRECTORY: proofStore.MANAGED_NATIVE_JOB_PROOF_DIRECTORY,
    MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT: proofStore.MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT,
    MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES: proofStore.MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES,
    MANAGED_NATIVE_JOB_PROOF_SHARDS: proofStore.MANAGED_NATIVE_JOB_PROOF_SHARDS,
  }),
  schedulerRandomIdSource: () => /const createRandomId = \(prefix\) => \{[\s\S]*?\n\};/.exec(readFileSync(path.join(RUNTIME_DIR, 'scheduler.js'), 'utf8'))[0],
  validateManagedTaskRecord: contract.validateManagedTaskRecord,
  createManagedTaskRecord: contract.createManagedTaskRecord,
  validateRequiredChecks: (value) => requiredChecks.validateRequiredChecks(value),
  validateRequiredCheckReceipts: (receipts, checks) => requiredChecks.validateRequiredCheckReceipts(receipts, checks),
  visualCheckPassed: requiredChecks.visualCheckPassed,
  validateCheckCorrection: checkCorrection.validateCheckCorrection,
  validateCheckCorrectionHistory: (history) => checkCorrection.validateCheckCorrectionHistory(history),
  applyCheckCorrection: (state, correction) => checkCorrection.applyCheckCorrection(state, correction),
  isCheckCorrectionTransition: checkCorrection.isCheckCorrectionTransition,
  validateTaskPrerequisites: (value) => prerequisites.validateTaskPrerequisites(value),
  validateApprovedPlanRef: approvedPlan.validateApprovedPlanRef,
  validatePrimaryStepBudget: stepBudget.validatePrimaryStepBudget,
  validateManagedExecutionBackend: segments.validateManagedExecutionBackend,
  validateManagedNativeJobSegments: segments.validateManagedNativeJobSegments,
  isManagedNativeJobReceiptTransition: segments.isManagedNativeJobReceiptTransition,
  validateManagedTransportRecovery: transport.validateManagedTransportRecovery,
  validateManagedTaskResultEnvelope: envelopes.validateManagedTaskResultEnvelope,
  validateManagedTaskAutoResume: envelopes.validateManagedTaskAutoResume,
  createManagedTaskResultEnvelope: envelopes.createManagedTaskResultEnvelope,
  assertManagedTaskResultEnvelopeMatchesTask: envelopes.assertManagedTaskResultEnvelopeMatchesTask,
  taskPredicates: (task, envelope) => ({
    terminal: contract.isTerminalManagedTaskStatus(task?.status),
    pending: contract.hasPendingOperatorStop(task),
    accepted: contract.hasAcceptedUserStop(task),
    agentRetry: contract.isManagedTaskAgentRetryAvailable(task),
    stopped: contract.isStoppedRecoveryAvailable(task, envelope),
    userStopped: contract.isUserStoppedRecoveryAvailable(task, envelope),
    manual: contract.requiresManualModelRecovery(task, envelope),
    eligible: autoResume.isAutoResumeEligible(task, envelope),
    backup: transport.isManagedTransportBackupEligible(task),
    disposition: segments.requiresManagedNativeInputDisposition(task),
  }),
  isStoppedRecoveryAvailable: contract.isStoppedRecoveryAvailable,
  requiresManualModelRecovery: contract.requiresManualModelRecovery,
  requiresManagedNativeInputDisposition: segments.requiresManagedNativeInputDisposition,
  isAutoResumeEligible: autoResume.isAutoResumeEligible,
  toManagedTaskEvent: (task, envelope) => contract.toManagedTaskEvent(task, envelope),
  toManagedTaskRemovalEvent: contract.toManagedTaskRemovalEvent,
  decodeLedgerSnapshot: (value, options) => codec.decodeLedgerSnapshot(value, options === undefined ? undefined
    : { requireResultEnvelopes: options.requireResultEnvelopes, createError: createErrorFrom(options.createError) }),
  encodeLedgerSnapshot: codec.encodeLedgerSnapshot,
  decodeManagedTaskRecord: codec.decodeManagedTaskRecord,
  decodeResultEnvelope: codec.decodeResultEnvelope,
  compactManagedOrchestrationState: (input, options) => persistence.compactManagedOrchestrationState(input, options),
  isManagedNativeJobTombstone: persistence.isManagedNativeJobTombstone,
  assertManagedTaskTransition: (previous, next) => transitions.assertManagedTaskTransition(previous, next),
  initialAutoResumeState: autoResume.initialAutoResumeState,
  recordProviderRejection: autoResume.recordProviderRejection,
  planAutoResumeAttempt: (input, breakers) => autoResume.planAutoResumeAttempt({ ...input, breakerUntil: breakerFrom(breakers) }),
  buildAutoResumeAcknowledgeParams: autoResume.buildAutoResumeAcknowledgeParams,
  decodeManagedNativeJobProofShard: proofStore.decodeManagedNativeJobProofShard,
  decodeManagedNativeJobProof: proofStore.decodeManagedNativeJobProof,
  encodeManagedNativeJobProofShard: proofStore.encodeManagedNativeJobProofShard,
};

const REF = Symbol('base reference');

/** One vector file: its bases and rows, in order. */
class VectorFile {
  constructor(name) {
    this.name = name;
    this.lines = [];
    this.bases = new Map();
  }

  /** Defines a base value; returns a reference to it. */
  base(name, value) {
    if (this.bases.has(name)) throw new Error(`${this.name}: base ${name} twice`);
    this.bases.set(name, structuredClone(value));
    this.lines.push(JSON.stringify({ base: name, value: encode(value) }));
    return this.ref(name);
  }

  /** A copy of a base with ops applied (an argument). */
  ref(name, ops = []) {
    if (!this.bases.has(name)) throw new Error(`${this.name}: no base ${name}`);
    return {
      [REF]: true,
      value: applyOps(this.bases.get(name), ops),
      encoded: { $: 'base', name, ops: ops.map(([op, at, item]) => (op === 'delete' ? [op, at] : [op, at, encode(item)])) },
    };
  }

  /** Calls the JavaScript and writes the row; returns the result (or the error). */
  call(fn, args, { refuse = false } = {}) {
    const impl = CALLS[fn];
    if (!impl) throw new Error(`no vector function ${fn}`);
    const values = args.map(arg => (arg?.[REF] ? arg.value : arg));
    const encodedArgs = args.map(arg => (arg?.[REF] ? arg.encoded : encode(arg)));
    const row = { fn, args: encodedArgs };
    let outcome;
    try {
      outcome = { ok: impl(...values) };
      row.ok = sameOrEncode(outcome.ok, values);
    } catch (error) {
      outcome = { error };
      row.throw = encodeThrow(error);
    }
    if (refuse) row.refuse = true;
    this.lines.push(JSON.stringify(row));
    return outcome;
  }

  render() {
    return `${this.lines.join('\n')}\n`;
  }
}

// ---------------------------------------------------------------------------
// Inputs shared by several files.

const hex32 = (n) => n.toString(16).padStart(32, '0');
const TASK_ID = (n) => `dvr_task_${hex32(n)}`;
const HASH = (c) => c.repeat(64);
const USAGE_LIMIT = "You've hit your session limit · resets 7:30pm";

const baseTaskInput = (n = 1, overrides = {}) => ({
  taskId: TASK_ID(n), idempotencyKey: `key-${n}`, rootSessionId: 'ses_root', parentTaskId: null, directory: '/workspace', sequence: n,
  mode: 'orchestrator', providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer', variant: null, label: `Task ${n}`,
  prompt: `Perform task ${n}.`, attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1_000 + n, timeoutAt: null,
  ...overrides,
});

const queuedTask = (n = 1, overrides = {}) => contract.createManagedTaskRecord(baseTaskInput(n, overrides));

const settledTask = (n, overrides = {}) => ({
  ...queuedTask(n, { dispatchGroupId: 'msg_group' }),
  status: 'failed', childSessionId: `ses_child_${n}`, leaseToken: `dvr_lease_${hex32(n)}`, startedAt: 1_100 + n, finishedAt: 2_000 + n,
  failureReason: USAGE_LIMIT, partial: true, recoverablePreview: `partial ${n}`, canonicalRefs: [{ type: 'message', id: `msg_${n}` }],
  ...overrides,
});

const VISUAL_CHECK = {
  name: 'screens', command: 'npx playwright test', paths: ['src/ui/page.tsx', 'src/ui/page.css'], kind: 'visual',
  visual: { state: 'populated', dataSource: 'fixture', reportPath: 'reports/screens.json', assertions: ['header shown', 'table populated'] },
};
const COMMAND_CHECK = { name: 'unit', command: 'npm test', paths: ['src/api.js'], cwd: 'packages/api', environment: 'native', purpose: 'implementation', prerequisites: ['build'] };
const PASSED_RECEIPT = { name: 'unit', callId: 'call_1', messageId: 'msg_check', exitCode: 0, observedAt: 3_000, status: 'passed', contentHash: HASH('a') };
const VISUAL_OBSERVATION = {
  state: 'populated', dataSource: 'fixture', reportHash: HASH('b'),
  assertions: [{ name: 'header shown', status: 'passed' }, { name: 'table populated', status: 'passed' }],
  evidence: [{ path: 'reports/screens.png', sha256: HASH('c') }], servedFreshness: 'fresh',
};
const VISUAL_RECEIPT = { name: 'screens', callId: 'call_2', messageId: 'msg_visual', exitCode: 0, observedAt: 3_100, status: 'passed', contentHash: HASH('d'), visual: VISUAL_OBSERVATION };
const EDGE_CHECK = { name: 'edge', command: 'npx vitest run supabase/functions/send-mail/__tests__', paths: ['supabase/functions/send-mail', 'supabase/functions/send-mail/index.ts'] };
const EDGE_IDENTITY = {
  kind: 'edge-deno-function-v1', packagePath: 'package.json', packageSha256: HASH('1'), scriptPath: 'scripts/testing/run-deno-tests.mjs', scriptSha256: HASH('2'),
  functionName: 'send-mail', selector: '--function', testPath: 'supabase/functions/send-mail/__tests__', coverageHash: HASH('3'), verifiedBy: 'host-policy',
};
const EDGE_CORRECTION = {
  name: 'edge', previousCommand: EDGE_CHECK.command, command: 'npm run test:edge -- --function send-mail', reason: 'repository_edge_deno_runner', observedAt: 4_000,
  runnerIdentity: EDGE_IDENTITY,
};
const EDGE_RECEIPT = { name: 'edge', callId: 'call_3', messageId: 'msg_edge', exitCode: 1, observedAt: 3_500, status: 'failed', contentHash: HASH('e') };
const PLAN_REF = {
  rootSessionId: 'ses_root', objectiveId: 'obj_1', sourceMessageId: 'msg_plan', version: HASH('f'), phase: 'Phase 1', paths: ['src/api.js', 'docs\\plan.md'],
  content: '## Phase 1\nDo it.', contentHash: HASH('0'),
};
const PREREQUISITE = { taskId: TASK_ID(90), checkName: 'interface', paths: ['src/api.js'], contentHash: HASH('a') };
const STEP_BUDGET = {
  acceptedPrompts: [{ userMessageID: 'msg_u1', createdAt: 10 }, { userMessageID: 'msg_u2', createdAt: 20 }], userMessageID: 'msg_u2',
  assistantMessageIDs: ['msg_a1', 'msg_a2'], warningClaimedAt: null, maintenanceParents: [{ parentID: 'msg_p1', userMessageID: 'msg_u1' }], retiredPromptThrough: 15,
};
const SEGMENT = { jobID: 'dvr_job_one', notificationID: 'msg_notification', messageID: 'msg_prompt', state: 'accepted', completion: 'pending' };
const TRANSPORT = {
  revision: 2, phase: 'exhausted', kind: 'stream_idle_timeout', sameModelAttempts: 1, backupAttempts: 0, failedMessageId: 'msg_failed', failedUserMessageId: null,
  recoveryMessageId: 'msg_recovery', eventId: null, reservedAt: 5_000, submittedAt: 5_100,
};
const AUTO_RESUME = {
  revision: 3, trigger: 'provider_usage_limit', enabled: true, state: 'scheduled', cancelGeneration: 1, lineageStartedAt: 1_000, expiresAt: 22_601_000,
  attemptCount: 2, noSignalProbes: 1, rejectionsInWindow: 1, windowResetAt: 9_000, nextAttemptAt: 9_015, resetAt: 9_000, resetSource: 'opencode_status',
  target: { kind: 'original', providerId: 'github-copilot', modelId: 'gpt-4.1', variant: null }, recoveryCycleTaskId: TASK_ID(2), backupAttemptTaskId: null,
  lastAttemptTaskId: TASK_ID(3), lastAttemptAt: 8_000, lastError: { code: 'provider_rejected', message: 'still limited', at: 8_100 }, hostFailures: 0, reason: null,
};

/** A full native-job record: every optional validator has something to check. */
const nativeTask = (n = 7) => ({
  ...settledTask(n, {
    status: 'interrupted', executionBackend: 'native-job', nativeJobSegments: [SEGMENT], requiredChecks: [COMMAND_CHECK, VISUAL_CHECK],
    requiredCheckReceipts: [PASSED_RECEIPT, VISUAL_RECEIPT], taskPrerequisites: [PREREQUISITE], approvedPlanRef: PLAN_REF, primaryStepBudget: STEP_BUDGET,
    dispatchObjectiveId: 'obj_1', transportRecovery: TRANSPORT, failureReason: 'stream idle timeout', terminationIntent: 'user_stopped',
    operatorStop: { requestedAt: 1_900, requestId: 'stop_1', leaseToken: `dvr_lease_${hex32(n)}`, state: 'accepted' },
  }),
});

/** A record whose required check was corrected once (a real applyCheckCorrection). */
const correctedTask = (n = 8) => {
  const applied = checkCorrection.applyCheckCorrection({ checks: [EDGE_CHECK], receipts: [EDGE_RECEIPT], history: [] }, { ...EDGE_CORRECTION, previousReceipt: EDGE_RECEIPT });
  return { ...settledTask(n, { status: 'completed', failureReason: null, partial: false }), requiredChecks: structuredClone(applied.checks), requiredCheckReceipts: [], requiredCheckCorrections: structuredClone(applied.history) };
};

const envelopeOf = (task, sequence = 50, options = {}) => envelopes.createManagedTaskResultEnvelope(task, { sequence, createdAt: task.finishedAt ?? 2_500, resumable: true, ...options });

// ---------------------------------------------------------------------------
// retry.jsonl: provider-retry-policy.js and the read-only provider check.

const PHRASES = [
  'authentication_error', 'authentication error', 'authenticationerror', 'authentication failed', 'authentication failure', 'authentication expired',
  'authentication invalid', 'authorizationerror', 'authorization failed', 'authorization failure', 'unauthorized', 'forbidden', 'invalid api key',
  'invalid credential', 'invalid credentials', 'invalid access token', 'invalid authentication', 'missing api key', 'expired token', 'expired access token',
  'expired refresh token', 'token expired', 'oauth token has expired', 'access token is expired', 'refresh token expired', 'not logged in', 'HTTP 401',
  'http:403', 'http : 401', 'http 402', 'an active opencode go subscription is required',
  'native_web_denied', 'native_web_denied: unauthorized', 'forbidden by native_session_access_revoked', 'native_managed_task_closed', 'native_permit_x', 'native_session_access_revoked', 'native_web_', 'native_web_Denied', 'xnative_web_a',
  'Runtime capability unavailable: x', 'Runtime capability unavailable', 'Runtime capability unavailable x', 'admission.prompt: the native permission action for tool bash.run:x-y is unavailable',
  'admission.prompt: the native permission action for tool bad tool is unavailable', 'admission.prompt: the native permission action for tool bash is unavailable.',
  'model requires global region', 'model requires global regions', "select global in your workspace's privacy settings", 'select global in your workspaces privacy settings',
  'select global in your workspace’s privacy settings', 'select global in your workspaceʼs privacy settings', 'Model   requires\nglobal REGION',
  'select global in your worKspace\'s privacy settings', 'model requires global regions', 'amodel requires global region',
  'invalid prompt: your prompt was flagged as potentially violating our usage policy', 'Invalid prompt flagged for policy violation', 'invalid prompt flagged',
  'invalid prompt flagged, violating policy', 'personal team blocked spending limit', 'personal team blocKed spending limit', 'out of usage', 'usage exceeded',
  'usage limit', 'hit your limit', 'session limit', 'rate limit', 'rate-limited', 'quota limit', 'quota exceeded', 'quota has been exceeded', 'insufficient_quota',
  USAGE_LIMIT, 'usage lİmit', 'İnsufficient quota',
  'ProviderModelNotFoundError', 'modelnotfound', 'model not found', 'model is not found', 'model unavailable', 'model is unavailable', 'model does not exist',
  'unknown model', 'invalid model', 'no such model',
  'Managed task timed out at 2000', 'managed task timed out at 2000', 'Error: Managed task timed out at 2000', ' Managed task timed out at 5',
  'timed out in queue', 'Request abc timed out in queue, abort.', 'service temporarily unavailable', 'service is temporarily unavailable', 'the model did not respond',
  'model is overloaded', 'server is overloaded', 'capacity exceeded', 'no capacity available',
  'und_err_headers_timeout', 'headers timeout', 'header timeout error', 'response headers timed out', 'response header timeout', 'timed out waiting for response headers',
  'timed out while waiting for the response header',
  'und_err_body_timeout', 'chunk timeout', 'chunk timeout error', 'stream idle timeout', 'upstream idle timeout exceeded', 'sse timed out', 'sse read timed out',
  'timed out waiting for next chunk', 'timed out while waiting for the stream', 'timed out waiting for response data', 'no data received', 'no stream data was received',
  'upstream_timeout: Upstream stalled: no data for 300000ms', 'Upstream stalled: no data for 300000ms', 'upstream_timeout: Upstream stalled: no data for 0ms',
  'upstream_timeout: Upstream stalled: no data for 12345678901234ms',
  '{"type":"upstream_timeout","message":"Upstream stalled: no data for 5000ms"}', '{"type":"upstream_timeout","message":"Upstream stalled: no data for 5000ms","type":"x"}',
  '{"message":"Upstream stalled: no data for 5000ms","type":"upstream_timeout"}', '{"type":"upstream_timeout","message":"Upstream stalled: no data"}',
  '["upstream_timeout"]', '{"type":"upstream_timeout","message":7}',
  'The operation timed out', 'operation has timed out', 'request timed out.', 'Request timeout', 'RequestTimeoutError', 'TimeoutError', 'timeout',
  'Unknown error: timeout', 'UnknownError: The request has timed out', 'unknown   error  :  timeout.', 'timeout!', 'timeouterror.', 'unknown error timeout',
  'terminated', 'Terminated', 'terminated.', 'econnreset', 'ECONNREFUSED', 'econnaborted', 'ehostunreach', 'enetdown', 'enetunreach', 'enotfound', 'epipe', 'etimedout',
  'und_err_connect_timeout', 'und_err_socket', 'streaming response failed', 'upstream request failed', 'premature close', 'prematurely closed', 'socket hang up',
  'connection reset', 'connection lost', 'connection terminated', 'network error', 'network connection failure', 'fetch failed',
  'aborted', 'The operation was aborted', 'cancelled', 'canceled', 'cancel', 'certificate has expired', 'self signed certificate', 'unable to verify the first certificate',
  'x509', 'credential missing', 'oauth', 'Provider internal failure: unauthorized', 'Runtime capability unavailable: unauthorized', 'Aborted: timeout',
  '', ' ', 'plain failure', 'Error', '\ud800 rate limit', 'rate\ud800limit', 'timeout\udc00',
  // Texts two classifiers accept, where their order decides; digits beside a phrase.
  'Runtime capability unavailable: model requires global region', 'Managed task timed out at 5: model not found', 'unauthorized: model not found',
  'model requires global regions: rate limit', 'rate limit: model not found', 'Managed task timed out at 5: socket hang up', 'rate2limit', 'usage9limit',
  'quota0exceeded', '429rate limit', 'socket hang up: model not found', 'The request has has timed out', 'timed out waiting for the the response headers',
  'no stream stream data received',
];

const variants = (phrase, rng) => {
  const all = [
    phrase.toUpperCase(),
    phrase.replace(/\b[a-z]/g, letter => letter.toUpperCase()),
    `Error: ${phrase}`,
    `${phrase}.`,
    `x${phrase}`,
    `${phrase}x`,
    `_${phrase}_`,
    JSON.stringify(phrase),
    `  \t${phrase}\n `,
    ` ${phrase}　`,
    phrase.replace(/ /g, '_'),
    phrase.replace(/ /g, '  '),
    phrase.replace(/ /g, ' '),
    phrase.replace(/k/g, 'K'),
    phrase.replace(/i/, 'İ'),
    `${phrase}: ${rng.pick(PHRASES)}`,
    `"${phrase}`,
    `"  ${phrase}  "`,
  ];
  const chosen = [phrase];
  for (let index = 0; index < 2; index += 1) chosen.push(all[rng.int(all.length)]);
  return chosen;
};

function retryVectors() {
  const file = new VectorFile('retry.jsonl');
  const rng = prng(0x5eed0001);
  const seen = new Set();
  const text = (value) => {
    if (typeof value === 'string') {
      if (seen.has(value)) return;
      seen.add(value);
    }
    file.call('failureText', [value]);
  };
  for (const phrase of PHRASES) for (const value of variants(phrase, rng)) text(value);
  for (let index = 0; index < 120; index += 1) {
    const parts = Array.from({ length: 2 + rng.int(2) }, () => rng.pick(PHRASES));
    text(parts.join(rng.pick([' ', ': ', ', ', '\n', ' - ', '', '_'])));
  }
  const configuration = "select global in your workspace's privacy settings";
  text(configuration + ' '.repeat(16 * 1024 - configuration.length));
  text(configuration + ' '.repeat(16 * 1024 - configuration.length + 1));
  for (const value of [null, undefined, 5, true, {}, ['rate limit'], { message: 'rate limit' }]) file.call('failureText', [value]);
  // A JSON text nested past the JSON layer's bound reaches JSON.parse in the
  // stall-envelope check: the Rust refuses it (the JavaScript answers null).
  file.call('failureText', [`${'['.repeat(600)}${']'.repeat(600)}`], { refuse: true });

  const pool = [undefined, null, '', '  ', 'x', 5, 0, 401, 403, true, false, [], ['a', 'b'], {}, { a: 1 }];
  const strings = ['Managed child session failed', '  boom  ', 'unauthorized', 'request aborted', 'native_web_denied', 'quota exceeded', 'socket hang up', ''];
  const types = [undefined, null, '', 'aborted', 'provider.auth', 'provider.internal', 'other'];
  const names = [undefined, null, '', 'AbortError', 'MessageAbortedError', 'ProviderAuthError', 'Error', 'TypeError', 7, ['AbortError'], {}];
  const codes = [undefined, null, 'capability_unavailable', 'native_permit_denied', 'E_OTHER', 12, ['native_web_x']];
  const statuses = [undefined, null, 401, 403, 500, '401', -0];
  const maybe = (list, p = 0.5) => (rng.chance(p) ? rng.pick(list) : undefined);
  for (let index = 0; index < 260; index += 1) {
    const error = {};
    const set = (key, value) => { if (value !== undefined || rng.chance(0.1)) error[key] = value; };
    if (rng.chance(0.5)) {
      const data = {};
      for (const [key, list] of [['message', strings], ['v2Type', types], ['code', codes], ['statusCode', statuses]]) if (rng.chance(0.5)) data[key] = rng.pick(list);
      error.data = rng.chance(0.9) ? data : rng.pick(pool);
    }
    set('message', maybe(strings, 0.6));
    set('name', maybe(names, 0.5));
    set('v2Type', maybe(types, 0.3));
    set('errorName', maybe(names, 0.3));
    set('code', maybe(codes, 0.3));
    set('statusCode', maybe(statuses, 0.3));
    file.call('formatManagedTaskFailureReason', [error]);
  }
  for (const value of [...PHRASES.slice(0, 40).map(phrase => `\u3000 ${phrase}\t`), undefined, null, 0, -0, NaN, 12, 1.5, true, false, '', '  trimmed  ', '\ufeff', [], ['x', 'y'], { message: 'only' }, { toString: 'not callable' }]) {
    file.call('formatManagedTaskFailureReason', [value]);
  }
  // ToString of an object with its own (non-callable) toString: the JavaScript
  // throws; the Rust refuses.
  file.call('formatManagedTaskFailureReason', [{ message: 'm', name: { toString: 'x' } }], { refuse: true });
  file.call('formatManagedTaskFailureReason', [{ message: 'm', code: [{ valueOf: 1 }] }], { refuse: true });

  const transportNames = [null, undefined, '', 'TimeoutError', 'AbortError', 'ProviderAuthError', 'APIError', 'UnknownError', 'Cancelled', 'CertificateError',
    'oauth_failure', '"TimeoutError"', 'SSE', 'unauthorized', 5, 'model not found', 'request timeout', 'Model_Not_Found', 'ab_ort', 'o_auth', 'can-cel'];
  for (let index = 0; index < 220; index += 1) file.call('classifyProviderTransportFailure', [rng.pick(transportNames), rng.chance(0.85) ? rng.pick(PHRASES) : rng.pick(transportNames)]);

  const reasons = ['free_tier_limit', ' FREE_TIER_LIMIT ', 'free_tier_limit.', 'free tier limit', 'Free_Tier_Limit', ' free_tier_limit﻿', 5, null, undefined, 'free_tier_limİt'];
  const messages = ['rate limit', 'plain', undefined, null, 'unauthorized: rate limit', 'invalid prompt flagged usage policy'];
  for (const reason of reasons) for (const message of messages.slice(0, 3)) file.call('classifyProviderRetryStatus', [{ action: { reason }, message }]);
  for (const value of [null, undefined, 'rate limit', 5, {}, { action: 'free_tier_limit' }, { action: null, message: 'quota exceeded' }, { message: messages[4] }, { message: messages[5] }, [], { action: { reason: ['free_tier_limit'] } }]) {
    file.call('classifyProviderRetryStatus', [value]);
  }

  const providers = ['cursor-acp', ' CURSOR-ACP ', 'cursor', '', ' ', null, undefined, 5, 'openai', 'cursor‐acp', ' cursor-acp ', 'Cursor-ACP'];
  const options = [undefined, {}, { cursorReadOnly: true }, { cursorReadOnly: 'true' }, { cursorReadOnly: 1 }, { cursorReadOnly: false }];
  for (const provider of providers) for (const option of options) file.call('supportsManagedReadOnlyProvider', [provider, option]);
  return file;
}

// ---------------------------------------------------------------------------
// primitives.jsonl: text truncation, identifiers, queue order, shards, constants.

const COLLATION = '_0123456789abcdefghijklmnopqrstuvwxyz';
const collationSign = (left, right) => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = COLLATION.indexOf(left[index]) - COLLATION.indexOf(right[index]);
    if (difference) return Math.sign(difference);
  }
  return Math.sign(left.length - right.length);
};

/** Fails the generation if localeCompare is not the order the Rust implements over [_0-9a-z]. */
function checkCollation(rng) {
  const short = [''];
  for (let length = 1; length <= 3; length += 1) {
    for (const prefix of short.filter(item => item.length === length - 1)) for (const unit of '_09az') short.push(prefix + unit);
  }
  const pairs = short.flatMap(left => short.map(right => [left, right]));
  for (let index = 0; index < 3_000; index += 1) {
    const word = () => Array.from({ length: 1 + rng.int(10) }, () => COLLATION[rng.int(COLLATION.length)]).join('');
    pairs.push([word(), word()]);
  }
  for (const [left, right] of pairs) {
    if (Math.sign(left.localeCompare(right)) !== collationSign(left, right)) {
      throw new Error(`localeCompare(${JSON.stringify(left)}, ${JSON.stringify(right)}) is not the [_0-9a-z] collation the crate implements`);
    }
  }
}

/** Fails the generation if toLowerCase gives ASCII for a code point the crate does not map. */
function checkLowerCase() {
  const mapped = [];
  for (let point = 0x80; point <= 0x10ffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (/[\x00-\x7f]/.test(String.fromCodePoint(point).toLowerCase())) mapped.push(point);
  }
  if (mapped.join() !== [0x130, 0x212a].join()) throw new Error(`toLowerCase maps ${mapped.map(point => point.toString(16)).join(', ')} to ASCII; the crate maps U+0130 and U+212A only`);
}

function primitiveVectors() {
  const file = new VectorFile('primitives.jsonl');
  const rng = prng(0x5eed0002);
  checkCollation(rng);
  checkLowerCase();
  file.call('constants', []);
  file.call('schedulerRandomIdSource', []);

  const units = ['a', 'b', 'é', '€', '😀', '\ud800', '\udc00', '﻿', '�', ' ', '\u0000'];
  const bytes = (text) => Buffer.byteLength(text, 'utf8');
  for (let index = 0; index < 320; index += 1) {
    let text = Array.from({ length: rng.int(10) }, () => rng.pick(units)).join('');
    if (rng.chance(0.15)) text = `﻿${text}`;
    file.call('truncateManagedText', [text, rng.int(bytes(text) + 2)]);
  }
  for (const max of [-1, 1.5, NaN, Infinity, '3', null, undefined, -0, 2 ** 53, 2 ** 53 - 1, true]) file.call('truncateManagedText', ['€abc', max]);
  for (const value of [5, null, undefined, {}, ['a']]) for (const max of [2, -1, null, NaN]) file.call('truncateManagedText', [value, max]);
  file.call('truncateManagedText', ['€'.repeat(300), 512]);
  file.call('truncateManagedText', [`x${'😀'.repeat(200)}`, 513]);

  for (const value of ['dvr_task_a', 'dvr_task_', 'dvr_task_A-b_9', 'dvr_task_a b', 'dvr_task_é', 'DVR_task_a', 'xdvr_task_a', 'dvr_task_a\n', 'dvr_task_a ', 5, null, undefined, ['dvr_task_a']]) {
    file.call('isManagedTaskId', [value]);
  }

  const word = (alphabet = COLLATION) => Array.from({ length: 1 + rng.int(6) }, () => alphabet[rng.int(alphabet.length)]).join('');
  const taskIdChoice = () => (rng.chance(0.6) ? `dvr_task_${word('0123456789abcdef')}` : word());
  const numbers = [1, 2, 3, 0, -0, 1.5, 10, NaN];
  for (let index = 0; index < 220; index += 1) {
    const left = { sequence: rng.pick(numbers), createdAt: rng.pick([100, 200, 0, -0, NaN]), taskId: taskIdChoice() };
    const right = rng.chance(0.4) ? { ...left, taskId: taskIdChoice() } : { sequence: rng.pick(numbers), createdAt: rng.pick([100, 200, 0, -0]), taskId: taskIdChoice() };
    file.call('compareManagedTaskQueueOrder', [left, right]);
  }
  for (const [a, b] of [['dvr_task_1', 'dvr_task01'], ['a_', 'a0'], ['dvr_task_ab', 'dvr_taskab'], ['dvr_task_', 'dvr_task'], ['dvr_task_9', 'dvr_task_a']]) {
    file.call('compareManagedTaskQueueOrder', [{ sequence: 1, createdAt: 5, taskId: a }, { sequence: 1, createdAt: 5, taskId: b }]);
  }
  for (const [left, right] of [
    [{ sequence: 1, createdAt: 5, taskId: 'dvr_task_A' }, { sequence: 1, createdAt: 5, taskId: 'dvr_task_a' }],
    [{ sequence: 1, createdAt: 5, taskId: 'dvr_task_é' }, { sequence: 1, createdAt: 5, taskId: 'dvr_task_e' }],
    [{ sequence: 1, createdAt: 5, taskId: 7 }, { sequence: 1, createdAt: 5, taskId: 'dvr_task_e' }],
    [{ sequence: '1', createdAt: 5, taskId: 'a' }, { sequence: 1, createdAt: 5, taskId: 'b' }],
  ]) file.call('compareManagedTaskQueueOrder', [left, right], { refuse: true });
  file.call('compareManagedTaskQueueOrder', [{ sequence: null, createdAt: undefined, taskId: 'a' }, { sequence: true, createdAt: false, taskId: 'b' }]);
  file.call('compareManagedTaskQueueOrder', [null, { sequence: 1, createdAt: 1, taskId: 'a' }]);

  const shardIds = ['', null, undefined, 5, ['dvr_task_a'], 'dvr_task_\ud800', 'dvr_task_é€😀'];
  for (let index = 0; index < 120; index += 1) shardIds.push(rng.chance(0.7) ? TASK_ID(rng.int(1 << 30)) : `dvr_task_${word()}${rng.pick(units)}`);
  for (const value of shardIds) file.call('managedNativeJobProofShard', [value]);
  for (const value of ['00', '3f', '40', '0', '3F', '1a', ' 00', 5, null, undefined, 'ff']) {
    file.call('managedNativeJobProofShardFile', [value]);
    file.call('isManagedNativeJobProofShard', [value]);
  }
  for (const value of ['dvr_task_abc', 'dvr_task_', 'task_x', 'DVR_TASK_x', 5, null, undefined]) file.call('createLineageId', [value]);
  for (const value of ['planning', 'scheduled', 'attempting', 'exhausted', 'PLANNING', '', null, undefined, 5]) file.call('isAutoResumeActiveState', [value]);

  const task = file.base('task', settledTask(3));
  const envelope = file.base('envelope', envelopeOf(settledTask(3)));
  const payload = codec.MANAGED_RESULT_PAYLOAD_FIELDS;
  file.call('findManagedResultPayloadMismatch', [task, envelope, undefined]);
  for (const field of [...payload, 'canonicalRefs']) {
    for (const value of ['other', null, 0, -0, NaN, undefined, [], [{ id: 'msg_3', type: 'message' }], true]) {
      const changed = file.ref('envelope', [['set', [field], value]]);
      file.call('findManagedResultPayloadMismatch', [task, changed, undefined]);
    }
    file.call('findManagedResultPayloadMismatch', [task, file.ref('envelope', [['delete', [field]]]), { requireOwnFields: true }]);
    file.call('findManagedResultPayloadMismatch', [file.ref('task', [['delete', [field]]]), envelope, { requireOwnFields: true }]);
    file.call('findManagedResultPayloadMismatch', [file.ref('task', [['delete', [field]]]), envelope, { requireOwnFields: false }]);
  }
  file.call('findManagedResultPayloadMismatch', [file.ref('task', [['set', ['attempt'], -0]]), file.ref('envelope', [['set', ['attempt'], 0]]), undefined]);
  file.call('findManagedResultPayloadMismatch', [file.ref('task', [['set', ['failureReason'], NaN]]), file.ref('envelope', [['set', ['failureReason'], NaN]]), undefined]);
  file.call('findManagedResultPayloadMismatch', [task, file.ref('envelope', [['set', ['canonicalRefs'], 'x']]), { requireOwnFields: true }]);
  file.call('findManagedResultPayloadMismatch', [file.ref('task', [['set', ['canonicalRefs'], 'x']]), file.ref('envelope', [['set', ['canonicalRefs'], 'x']]), { requireOwnFields: true }]);
  file.call('findManagedResultPayloadMismatch', [file.ref('task', [['set', ['canonicalRefs'], 'x']]), file.ref('envelope', [['set', ['canonicalRefs'], 'x']]), undefined]);
  file.call('findManagedResultPayloadMismatch', [null, envelope, undefined]);
  file.call('findManagedResultPayloadMismatch', [task, undefined, { requireOwnFields: true }]);
  file.call('findManagedResultPayloadMismatch', ['task', 'envelope', undefined]);
  file.call('findManagedResultPayloadMismatch', [file.ref('task', [['set', ['status'], { a: 1 }]]), file.ref('envelope', [['set', ['status'], { a: 1 }]]), undefined], { refuse: true });
  return file;
}

// ---------------------------------------------------------------------------
// records.jsonl: the record and envelope validators, their leaves, the
// constructors and the predicates and events of contract.js.

const GENERIC = [null, '', '  ', 'x', 0, -1, 1, 1.5, -0, NaN, Infinity, true, false, [], {}];

const TASK_FIELD_VALUES = {
  owner: ['devryan', 'DevRyan', 'openchamber'],
  taskId: ['dvr_task_x', 'dvr_task_', 'dvr_wave_x', ' dvr_task_x'],
  idempotencyKey: ['a'.repeat(1024), 'a'.repeat(1025), 'é'.repeat(512), 'é'.repeat(513), '\ud800'.repeat(342), '\ud800'.repeat(341)],
  rootSessionId: ['ses_x', '　'],
  dispatchGroupId: ['msg_group', 'a'.repeat(1025), '€'.repeat(342)],
  dispatchCallId: ['call_1', 'a'.repeat(1024), 'a'.repeat(1025)],
  dispatchWaveId: ['dvr_wave_a', 'dvr_wave_', 'wave_a', `dvr_wave_${'a'.repeat(1016)}`],
  parentTaskId: [TASK_ID(9), 'dvr_lease_x'],
  childSessionId: ['ses_child', '\t'],
  directory: ['/workspace', '﻿'],
  sequence: [2, 2 ** 53, 2 ** 53 - 1, 1e300],
  mode: ['builder', 'orchestrator', 'Builder'],
  readOnly: [true],
  providerId: ['openai'], modelId: ['gpt-5'], agent: ['fixer'], variant: ['high', ' '],
  label: ['a'.repeat(512), 'a'.repeat(513), '€'.repeat(171)],
  prompt: ['p'],
  attempt: [2, 2 ** 53],
  priorTaskId: [TASK_ID(1), 'task_1'],
  executionKind: ['retry', 'resume', 'recover_in_place', 'retry_in_place', 'restart'],
  status: ['queued', 'starting', 'running', 'completed', 'failed', 'aborted', 'interrupted', 'done'],
  leaseToken: ['dvr_lease_1', 'lease_1'],
  terminationIntent: ['user_stopped', 'system_stopped'],
  operatorStop: [
    { requestedAt: 1, requestId: 'r', leaseToken: null },
    { requestedAt: 1, requestId: 'r', leaseToken: null, state: 'pending' },
    { requestedAt: 1, requestId: 'r', leaseToken: null, state: 'done' },
    { requestedAt: -1, requestId: 'r', leaseToken: null },
    { requestedAt: NaN, requestId: 'r', leaseToken: null },
    { requestedAt: 1, requestId: 5, leaseToken: null },
    { requestedAt: 1, requestId: 'r', leaseToken: 'dvr_lease_other' },
    { requestedAt: 1, requestId: 'r' },
  ],
  failureReason: ['boom', 'é'.repeat(8192), 'é'.repeat(8193)],
  partial: [true],
  recoverablePreview: ['', '  ', '€'.repeat(21845), '€'.repeat(21846)],
  canonicalRefs: [[{ type: 'message', id: 'msg' }], ['loose'], [undefined], [NaN], [{ a: undefined }], 'refs'],
  createdAt: [0, 5],
  startedAt: [0, 5], finishedAt: [5], timeoutAt: [9_000_000],
  recoveryLineageId: ['dvr_lineage_a', 'lineage_a', 'dvr_lineage_'],
  childPromptedAt: [5], firstAssistantPartAt: [5],
  waitingReason: [
    { kind: 'capacity', activeCount: 2, limit: 4, since: 10 },
    { kind: 'capacity', activeCount: 2, limit: null, since: 10 },
    { kind: 'capacity', activeCount: 2, limit: 0, since: 10 },
    { kind: 'capacity', activeCount: -1, limit: 4, since: 10 },
    { kind: 'capacity', activeCount: 1.5, limit: 4, since: 10 },
    { kind: 'system_pressure', activeCount: 2, limit: null, since: 10 },
    { kind: 'system_pressure', activeCount: 2, limit: 3, since: 10 },
    { kind: 'prerequisites', activeCount: 0, limit: 1, since: 10 },
    { kind: 'prerequisites', activeCount: 0, limit: null, since: -1 },
    { kind: 'memory', activeCount: 0, limit: null, since: 1 },
    { kind: 'capacity', activeCount: 2, limit: 4, since: 10, extra: 1 },
    { '0': 1, kind: 'capacity' },
  ],
  transportRecovery: [TRANSPORT, { ...TRANSPORT, revision: 0 }, { ...TRANSPORT, extra: 1 }, { ...TRANSPORT, backupAttempts: 2 }, { ...TRANSPORT, backupAttempts: -0 },
    { ...TRANSPORT, phase: 'nope' }, { ...TRANSPORT, kind: 'nope' }, { ...TRANSPORT, sameModelAttempts: 0 }, { ...TRANSPORT, failedMessageId: null },
    { ...TRANSPORT, eventId: 'e'.repeat(257) }, { ...TRANSPORT, recoveryMessageId: ' ' }, { ...TRANSPORT, failedUserMessageId: 5 }, { ...TRANSPORT, reservedAt: -1 },
    { ...TRANSPORT, submittedAt: 4_000 }, { ...TRANSPORT, submittedAt: null }, { ...TRANSPORT, submittedAt: Infinity }, ['x']],
  executionBackend: ['legacy-session', 'native-job', 'cursor', 'other'],
  nativeJobSegments: [[SEGMENT], [{ ...SEGMENT, completion: 'done' }], [{ ...SEGMENT, state: 'nope' }], [{ ...SEGMENT, messageID: SEGMENT.notificationID }],
    [{ ...SEGMENT, extra: 1 }], [{ ...SEGMENT, jobID: 'bad id' }], [SEGMENT, { ...SEGMENT, notificationID: 'msg_n2', messageID: 'msg_m2' }],
    [{ ...SEGMENT, completion: 'later' }], [null], [{ ...SEGMENT, jobID: 'j'.repeat(257) }], [{ ...SEGMENT, jobID: SEGMENT.notificationID }]],
  approvedPlanRef: [PLAN_REF, { ...PLAN_REF, rootSessionId: 'ses_other' }, { ...PLAN_REF, extra: 1 }, { ...PLAN_REF, version: 'v1' }, { ...PLAN_REF, paths: ['/abs'] },
    { ...PLAN_REF, paths: ['a/../b'] }, { ...PLAN_REF, paths: ['C:x'] }, { ...PLAN_REF, paths: ['\\abs'] }, { ...PLAN_REF, phase: '€'.repeat(171) }, { ...PLAN_REF, content: ' ' }, { ...PLAN_REF, paths: 'x' }],
  taskPrerequisites: [[PREREQUISITE], [PREREQUISITE, PREREQUISITE], [{ ...PREREQUISITE, extra: 1 }], [{ ...PREREQUISITE, taskId: 'dvr_task_' }],
    [{ ...PREREQUISITE, checkName: 'c'.repeat(129) }], [{ ...PREREQUISITE, contentHash: 'A'.repeat(64) }], [{ ...PREREQUISITE, paths: [] }],
    [{ 'checkName,contentHash': 1, 'paths,taskId': 2 }], [{ taskId: PREREQUISITE.taskId, checkName: 'c', contentHash: HASH('a'), path: ['x'] }], Array(9).fill(PREREQUISITE)],
  requiredChecks: [[COMMAND_CHECK], [VISUAL_CHECK], [COMMAND_CHECK, COMMAND_CHECK], Array(9).fill(COMMAND_CHECK)],
  requiredCheckReceipts: [[PASSED_RECEIPT], [{ ...PASSED_RECEIPT, name: 'other' }]],
  requiredCheckCorrections: [[], [{}], 'x'],
  primaryStepBudget: [STEP_BUDGET, { ...STEP_BUDGET, userMessageID: 'msg_missing' }, { ...STEP_BUDGET, extra: 1 }],
  dispatchObjectiveId: ['obj', ' '],
  extraField: ['kept'],
  '7': ['index-like'],
};

function taskValidationRows(file, rng) {
  file.base('queued', queuedTask(1));
  file.base('settled', settledTask(2));
  file.base('native', nativeTask(7));
  file.base('corrected', correctedTask(8));
  const targets = { queued: 'queued', settled: 'settled' };
  for (const name of ['queued', 'settled', 'native', 'corrected']) file.call('validateManagedTaskRecord', [file.ref(name)]);
  for (const [field, specific] of Object.entries(TASK_FIELD_VALUES)) {
    const base = targets[rng.pick(['queued', 'settled'])];
    file.call('validateManagedTaskRecord', [file.ref(base, [['delete', [field]]])]);
    for (const value of [...specific, ...GENERIC.filter(() => rng.chance(0.35))]) {
      file.call('validateManagedTaskRecord', [file.ref(rng.chance(0.3) ? 'native' : base, [['set', [field], value]])]);
    }
  }
  for (const value of [null, undefined, 'task', 5, [], [{}]]) file.call('validateManagedTaskRecord', [value]);
  // Every pair of neighbours in the validator's order, both invalid: the first one's error.
  const order = ['owner', 'taskId', 'idempotencyKey', 'rootSessionId', 'dispatchGroupId', 'dispatchCallId', 'dispatchWaveId', 'parentTaskId', 'childSessionId',
    'directory', 'sequence', 'mode', 'readOnly', 'providerId', 'modelId', 'agent', 'variant', 'label', 'prompt', 'attempt', 'priorTaskId', 'executionKind', 'status',
    'leaseToken', 'terminationIntent', 'operatorStop', 'failureReason', 'partial', 'recoverablePreview', 'canonicalRefs', 'createdAt', 'startedAt', 'finishedAt',
    'timeoutAt', 'recoveryLineageId', 'childPromptedAt', 'firstAssistantPartAt', 'waitingReason', 'transportRecovery', 'executionBackend', 'nativeJobSegments',
    'approvedPlanRef', 'taskPrerequisites', 'requiredChecks', 'requiredCheckReceipts', 'requiredCheckCorrections', 'primaryStepBudget', 'dispatchObjectiveId'];
  for (let index = 1; index < order.length; index += 1) {
    file.call('validateManagedTaskRecord', [file.ref('native', [['set', [order[index]], { bad: 1 }], ['set', [order[index - 1]], { bad: 1 }]])]);
  }
  const fields = Object.keys(TASK_FIELD_VALUES);
  for (let index = 0; index < 60; index += 1) {
    const ops = Array.from({ length: 2 + rng.int(3) }, () => {
      const field = rng.pick(fields);
      return rng.chance(0.25) ? ['delete', [field]] : ['set', [field], rng.chance(0.5) ? rng.pick(TASK_FIELD_VALUES[field]) : rng.pick(GENERIC)];
    });
    file.call('validateManagedTaskRecord', [file.ref(rng.pick(['queued', 'settled', 'native']), ops)]);
  }
  file.call('validateManagedTaskRecord', [file.ref('queued', [['set', ['status'], 'running'], ['set', ['waitingReason'], { kind: 'capacity', activeCount: 0, limit: null, since: 0 }]])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['operatorStop', 'leaseToken'], null]])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['executionBackend'], 'cursor']])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['delete', ['executionBackend']]])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['requiredCheckReceipts', 1, 'visual', 'servedFreshness'], 'stale']])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['requiredCheckReceipts', 1, 'visual', 'assertions', 1, 'status'], 'failed']])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['primaryStepBudget', 'warningClaimedAt'], 5]])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['nested'], { deep: [1, { x: Infinity }] }]])]);
  file.call('validateManagedTaskRecord', [file.ref('native', [['set', ['nested'], [1, [undefined]]]])]);
  file.call('validateManagedTaskRecord', [file.ref('queued', [['set', ['prompt'], 'p'.repeat(1000)], ['set', ['label'], '€'.repeat(170)]])]);
}

function leafRows(file, rng) {
  const checks = [COMMAND_CHECK, VISUAL_CHECK];
  file.base('checks', checks);
  for (const value of [undefined, [], null, 'x', {}, Array(8).fill(null).map((_, index) => ({ ...COMMAND_CHECK, name: `c${index}` })), Array(9).fill(COMMAND_CHECK)]) {
    file.call('validateRequiredChecks', [value]);
  }
  const checkMutations = [
    ['name', [' ', 'n'.repeat(128), 'n'.repeat(129), 5]], ['command', ['', 'c'.repeat(2048), 'c'.repeat(2049)]],
    ['paths', [[], ['a'], Array(32).fill(0).map((_, index) => `p${index}`), Array(33).fill(0).map((_, index) => `p${index}`), ['a', 'a'], ['/abs'], ['\\abs'], ['C:abs'],
      ['a/../b'], ['a\\..\\b'], ['..'], ['a\u0000b'], [' '], ['p'.repeat(512)], ['p'.repeat(513)], 'a', [5]]],
    ['cwd', ['.', 'packages/a', '/abs', '..', ' ', '', 5, null]],
    ['environment', ['native', 'a.b:c-d_e', '-x', 'e'.repeat(128), 'e'.repeat(129), 5, null, true, ['ok'], {}, '']],
    ['purpose', ['implementation', 'integration', 'deployment', 'other', null]],
    ['prerequisites', [[], ['b'], ['b', 'b'], [' '], Array(17).fill(0).map((_, index) => `b${index}`), 'b', null]],
    ['kind', ['command', 'visual', 'other', null]],
    ['visual', [VISUAL_CHECK.visual, null]],
  ];
  for (const [field, values] of checkMutations) {
    for (const value of values) {
      file.call('validateRequiredChecks', [file.ref('checks', [['set', [0, field], value]])]);
      if (rng.chance(0.3)) file.call('validateRequiredChecks', [file.ref('checks', [['delete', [0, field]]])]);
    }
  }
  const visualMutations = [['state', ['empty']], ['dataSource', ['live', 'mock']], ['reportPath', ['/abs', 'r/../x', ' ']], ['assertions', [[], ['a', 'a'], [' '], 'x', Array(33).fill(0).map((_, index) => `a${index}`)]]];
  for (const [field, values] of visualMutations) for (const value of values) file.call('validateRequiredChecks', [file.ref('checks', [['set', [1, 'visual', field], value]])]);
  file.call('validateRequiredChecks', [file.ref('checks', [['set', [1, 'visual'], 'x']])]);
  file.call('validateRequiredChecks', [[{ ...COMMAND_CHECK, paths: Array(32).fill(0).map((_, index) => `${'€'.repeat(500)}${index}`) }]]);
  file.call('validateRequiredChecks', [[{ ...COMMAND_CHECK, name: 'a' }, { ...COMMAND_CHECK, name: 'b', paths: Array(32).fill(0).map((_, index) => `${'x'.repeat(505)}${index}`) }, { ...COMMAND_CHECK, name: 'c', paths: Array(32).fill(0).map((_, index) => `${'y'.repeat(505)}${index}`) }]]);

  const receipts = [PASSED_RECEIPT, VISUAL_RECEIPT];
  file.base('receipts', receipts);
  file.call('validateRequiredCheckReceipts', [file.ref('receipts'), file.ref('checks')]);
  for (const [receiptsValue, checksValue] of [[undefined, undefined], [[], undefined], [undefined, checks], [null, checks], [[PASSED_RECEIPT], undefined], [[PASSED_RECEIPT, PASSED_RECEIPT], checks],
    [[null], checks], ['x', checks], [[PASSED_RECEIPT, VISUAL_RECEIPT, PASSED_RECEIPT], checks], [[PASSED_RECEIPT], null]]) {
    file.call('validateRequiredCheckReceipts', [receiptsValue, checksValue]);
  }
  const unavailable = { reason: 'docker_daemon_unavailable', hint: 'start docker' };
  const receiptMutations = [
    ['name', ['screens', 'none', 5]], ['callId', ['', 'c'.repeat(257)]], ['messageId', [null, '', 5]], ['exitCode', [null, 1, 1.5, -0, '0']],
    ['observedAt', [-1, NaN, '1', 0]], ['status', ['failed', 'not-observed', 'pending', 'blocked', 'skipped', 'waived', 'other']],
    ['contentHash', [null, 'A'.repeat(64), 'a'.repeat(63)]], ['identityConflict', [true, false]], ['environmentUnavailable', [unavailable]],
    ['waiver', [{ source: 'authenticated-user', userId: 'u', reason: 'r' }]], ['visual', [null]],
  ];
  for (const [field, values] of receiptMutations) {
    for (const value of values) {
      file.call('validateRequiredCheckReceipts', [file.ref('receipts', [['set', [rng.int(2), field], value]]), file.ref('checks')]);
    }
  }
  const special = [
    { ...PASSED_RECEIPT, messageId: null, status: 'waived', exitCode: null, waiver: { source: 'authenticated-user', userId: 'user', reason: 'approved' } },
    { ...PASSED_RECEIPT, messageId: null, status: 'waived', exitCode: null, waiver: { source: 'someone', userId: 'user', reason: 'approved' } },
    { ...PASSED_RECEIPT, messageId: null, status: 'waived', exitCode: null, contentHash: null, waiver: { source: 'authenticated-user', userId: 'user', reason: 'approved' } },
    { ...PASSED_RECEIPT, messageId: null, status: 'pending', exitCode: null, contentHash: null },
    { ...PASSED_RECEIPT, messageId: null, status: 'pending', exitCode: 0, contentHash: null },
    { ...PASSED_RECEIPT, status: 'skipped', exitCode: 125, environmentUnavailable: unavailable },
    { ...PASSED_RECEIPT, status: 'skipped', exitCode: 0, environmentUnavailable: unavailable },
    { ...PASSED_RECEIPT, status: 'skipped', exitCode: 125, environmentUnavailable: { ...unavailable, extra: 1 } },
    { ...PASSED_RECEIPT, status: 'skipped', exitCode: 125, environmentUnavailable: { ...unavailable, reason: 'other' } },
    { ...PASSED_RECEIPT, status: 'skipped', exitCode: 125 },
    { ...PASSED_RECEIPT, status: 'failed', exitCode: 2, waiver: {} },
    { ...PASSED_RECEIPT, identityConflict: true, messageId: null, status: 'pending', exitCode: null, contentHash: null },
  ];
  for (const receipt of special) file.call('validateRequiredCheckReceipts', [[receipt], file.ref('checks')]);
  for (const visual of [VISUAL_OBSERVATION, { ...VISUAL_OBSERVATION, servedFreshness: 'unknown' }, { ...VISUAL_OBSERVATION, servedFreshness: undefined }, { ...VISUAL_OBSERVATION, dataSource: 'live' },
    { ...VISUAL_OBSERVATION, assertions: VISUAL_OBSERVATION.assertions.slice(0, 1) }, { ...VISUAL_OBSERVATION, evidence: [] }, { ...VISUAL_OBSERVATION, evidence: [{ path: '/x', sha256: HASH('c') }] },
    { ...VISUAL_OBSERVATION, assertions: [VISUAL_OBSERVATION.assertions[0], VISUAL_OBSERVATION.assertions[0]] }, { ...VISUAL_OBSERVATION, reportHash: 'x' }, null,
    { ...VISUAL_OBSERVATION, assertions: [{ name: 'header shown', status: 'passed' }, { name: 'table populated', status: 'skipped' }] },
    { ...VISUAL_OBSERVATION, assertions: [...VISUAL_OBSERVATION.assertions, { name: 'extra', status: 'passed' }] }]) {
    file.call('visualCheckPassed', [VISUAL_CHECK, visual]);
  }

  file.base('edgeCheck', EDGE_CHECK);
  file.base('edgeCorrection', EDGE_CORRECTION);
  file.call('validateCheckCorrection', [file.ref('edgeCorrection'), file.ref('edgeCheck')]);
  const correctionMutations = [
    ['name', ['other']], ['previousCommand', ['npm test']], ['command', ['npm run test:edge -- --function other']], ['reason', ['other']], ['observedAt', [-1, NaN]],
    ['previousReceipt', [EDGE_RECEIPT, { ...EDGE_RECEIPT, name: 'other' }, null]], ['extra', [1]],
    ['runnerIdentity', [null, { ...EDGE_IDENTITY, extra: 1 }, { ...EDGE_IDENTITY, kind: 'v2' }, { ...EDGE_IDENTITY, functionName: 'other' }, { ...EDGE_IDENTITY, packageSha256: 'x' },
      { ...EDGE_IDENTITY, testPath: 'x' }, { ...EDGE_IDENTITY, verifiedBy: 'user' }, { ...EDGE_IDENTITY, selector: '--name' }, { ...EDGE_IDENTITY, scriptPath: 'x' }]],
  ];
  for (const [field, values] of correctionMutations) for (const value of values) file.call('validateCheckCorrection', [file.ref('edgeCorrection', [['set', [field], value]]), file.ref('edgeCheck')]);
  file.call('validateCheckCorrection', [file.ref('edgeCorrection', [['delete', ['runnerIdentity', 'coverageHash']]]), file.ref('edgeCheck')]);
  for (const check of [{ ...EDGE_CHECK, command: 'npx vitest run supabase/functions/send-mail/__tests__ --maxWorkers=4' }, { ...EDGE_CHECK, command: 'npx vitest run supabase/functions/send-mail/__tests__ --maxWorkers=0' },
    { ...EDGE_CHECK, kind: 'visual', visual: VISUAL_CHECK.visual }, { ...EDGE_CHECK, paths: ['supabase/functions/send-mail-2/x.ts'] }, { ...EDGE_CHECK, command: 'npm test' }, undefined, { ...EDGE_CHECK, paths: [] }]) {
    file.call('validateCheckCorrection', [EDGE_CORRECTION, check]);
  }
  file.call('validateCheckCorrection', [{ ...EDGE_CORRECTION, previousCommand: 'npx vitest run supabase/functions/send-mail/__tests__ --maxWorkers=4' }, { ...EDGE_CHECK, command: 'npx vitest run supabase/functions/send-mail/__tests__ --maxWorkers=4' }]);
  file.call('validateCheckCorrection', ['x', EDGE_CHECK]);
  file.call('validateCheckCorrection', [{ ...EDGE_CORRECTION, previousCommand: `${EDGE_CHECK.command} --maxWorkers=0` }, { ...EDGE_CHECK, command: `${EDGE_CHECK.command} --maxWorkers=0` }]);
  file.call('validateCheckCorrection', [{ ...EDGE_CORRECTION, previousCommand: `${EDGE_CHECK.command} --maxWorkers=999` }, { ...EDGE_CHECK, command: `${EDGE_CHECK.command} --maxWorkers=999` }]);
  const history = correctedTask().requiredCheckCorrections;
  file.base('history', history);
  file.call('validateCheckCorrectionHistory', [file.ref('history')]);
  for (const value of [undefined, [], null, 'x', [null], [5], Array(129).fill({}), [{ ...history[0], previousCheck: undefined }], [{ ...history[0], previousCheck: { ...EDGE_CHECK, command: 'x' } }]]) {
    file.call('validateCheckCorrectionHistory', [value]);
  }
  file.call('validateCheckCorrectionHistory', [Array(3).fill({ ...history[0], filler: undefined })]);
  file.call('applyCheckCorrection', [{ checks: [EDGE_CHECK], receipts: [EDGE_RECEIPT], history: [] }, { ...EDGE_CORRECTION, previousReceipt: EDGE_RECEIPT }]);
  file.call('applyCheckCorrection', [{ checks: [EDGE_CHECK, COMMAND_CHECK], receipts: [EDGE_RECEIPT, PASSED_RECEIPT], history: [] }, { ...EDGE_CORRECTION, previousReceipt: EDGE_RECEIPT }]);
  for (const [state, correction] of [[{ checks: [EDGE_CHECK] }, EDGE_CORRECTION], [{ checks: [EDGE_CHECK], receipts: [EDGE_RECEIPT] }, EDGE_CORRECTION], [{}, EDGE_CORRECTION],
    [{ checks: [EDGE_CHECK] }, { ...EDGE_CORRECTION, previousCommand: 'x' }], [{ checks: [EDGE_CHECK] }, null], [{ checks: [EDGE_CHECK], history }, EDGE_CORRECTION],
    [{ checks: [EDGE_CHECK], history: repeated(history[0], 128) }, EDGE_CORRECTION]]) {
    file.call('applyCheckCorrection', [state, correction]);
  }

  file.call('validateTaskPrerequisites', [[PREREQUISITE, { ...PREREQUISITE, checkName: 'other' }]]);
  for (const value of TASK_FIELD_VALUES.taskPrerequisites.concat([undefined, null, 'x', {}, [null], [{ ...PREREQUISITE, paths: ['/abs'] }],
    [{ ...PREREQUISITE, paths: Array(32).fill(0).map((_, index) => `${'€'.repeat(500)}${index}`) }], [{ ...PREREQUISITE, checkName: ' ' }], [{ ...PREREQUISITE, taskId: 5 }],
    Array(8).fill(0).map((_, index) => ({ ...PREREQUISITE, checkName: `c${index}`, paths: Array(9).fill(0).map((_, item) => `${'x'.repeat(500)}${item}`) }))])) {
    file.call('validateTaskPrerequisites', [value]);
  }
  for (const value of TASK_FIELD_VALUES.approvedPlanRef.concat([undefined, null, 0, '', 'x', [], { ...PLAN_REF, objectiveId: 'o'.repeat(257) }, { ...PLAN_REF, sourceMessageId: '€'.repeat(86) },
    { ...PLAN_REF, sourceMessageId: '€'.repeat(85) }, { ...PLAN_REF, contentHash: HASH('g') }, { ...PLAN_REF, paths: Array(33).fill('a') }, { ...PLAN_REF, paths: ['a\\..'] },
    { ...PLAN_REF, content: 'c'.repeat(32 * 1024) }, { ...PLAN_REF, content: 'c'.repeat(32 * 1024 + 1) }])) {
    file.call('validateApprovedPlanRef', [value]);
  }
  file.base('budget', STEP_BUDGET);
  file.call('validatePrimaryStepBudget', [file.ref('budget')]);
  for (const value of [undefined, null, 'x', [], {}, 5]) file.call('validatePrimaryStepBudget', [value]);
  const budgetMutations = [
    ['acceptedPrompts', [[], 'x', Array(33).fill(0).map((_, index) => ({ userMessageID: `m${index}`, createdAt: 1 })), [{ userMessageID: 'msg_u2', createdAt: 1 }, { userMessageID: 'msg_u2', createdAt: 2 }],
      ['msg_u2'], [null], [{ userMessageID: 'msg_u2', createdAt: -1 }], [{ userMessageID: 'msg u2', createdAt: 1 }], [{ userMessageID: 'msg_u2', createdAt: 1, extra: 1 }], [5]]],
    ['userMessageID', [null, 'msg_u1', 'msg_zz', 5]],
    ['assistantMessageIDs', [[], ['a', 'a'], ['bad id'], 'x', Array(260).fill(0).map((_, index) => `a${index}`), Array(261).fill(0).map((_, index) => `a${index}`)]],
    ['warningClaimedAt', [5, -1, NaN, undefined]],
    ['maintenanceParents', [[], [{ parentID: 'p', userMessageID: 'msg_zz' }], [{ parentID: 'p', userMessageID: 'msg_u1' }, { parentID: 'p', userMessageID: 'msg_u2' }], [null], 'x', [{ parentID: 'bad id', userMessageID: 'msg_u1' }], undefined]],
    ['retiredPromptThrough', [-1, NaN, 0, undefined, '1']],
    ['extra', [1]],
  ];
  for (const [field, values] of budgetMutations) {
    for (const value of values) file.call('validatePrimaryStepBudget', [file.ref('budget', value === undefined ? [['delete', [field]]] : [['set', [field], value]])]);
  }
  file.call('validatePrimaryStepBudget', [{ ...STEP_BUDGET, userMessageID: null, assistantMessageIDs: [], warningClaimedAt: null }]);
  file.call('validatePrimaryStepBudget', [{ ...STEP_BUDGET, userMessageID: null, assistantMessageIDs: ['a'] }]);
  file.call('validatePrimaryStepBudget', [{ ...STEP_BUDGET, assistantMessageIDs: Array(180).fill(0).map((_, index) => `a${index}`), warningClaimedAt: 7 }]);
  file.call('validatePrimaryStepBudget', [{ ...STEP_BUDGET, assistantMessageIDs: Array(179).fill(0).map((_, index) => `a${index}`), warningClaimedAt: 7 }]);

  for (const value of ['legacy-session', 'native-job', 'cursor', undefined, null, 'x', 5]) file.call('validateManagedExecutionBackend', [value]);
  for (const segmentsValue of TASK_FIELD_VALUES.nativeJobSegments.concat([undefined, [], 'x', null])) {
    for (const backend of ['native-job', 'cursor', undefined]) file.call('validateManagedNativeJobSegments', [segmentsValue, backend]);
  }
  for (const value of TASK_FIELD_VALUES.transportRecovery.concat([undefined, null, 'x', 5, { ...TRANSPORT, failedUserMessageId: 'msg_user', eventId: 'evt' }, { ...TRANSPORT, revision: 1.5 }])) {
    file.call('validateManagedTransportRecovery', [value]);
  }
  file.call('validateManagedTransportRecovery', [{ ...TRANSPORT, submittedAt: TRANSPORT.reservedAt }]);
}

function envelopeRows(file, rng) {
  const task = settledTask(2);
  const envelope = envelopeOf(task, 9);
  file.base('envelope', envelope);
  file.base('full', {
    ...envelope, action: 'retry_in_place', acknowledgedAt: 2_600, followUpTaskId: TASK_ID(12), acknowledgementIdentity: HASH('9'), providerResetAt: 9_000,
    promptObserved: { attempt: 1, sequence: 4, observedAt: 1_500 }, autoResume: AUTO_RESUME,
    runCleanup: { state: 'failed', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: task.leaseToken, attempts: 2, stopped: 1, code: 'stop_failed' },
  });
  file.call('validateManagedTaskResultEnvelope', [file.ref('envelope')]);
  file.call('validateManagedTaskResultEnvelope', [file.ref('full')]);
  const mutations = {
    owner: ['other'], envelopeId: ['dvr_task_x', 'dvr_result_'], taskId: ['dvr_result_x'], rootSessionId: [' '], parentTaskId: [TASK_ID(1), 'x'], childSessionId: [null, ' '],
    directory: [' '], sequence: [0, 1.5, 2 ** 53], status: ['queued', 'running', 'completed', 'aborted', 'interrupted'], partial: ['yes'],
    failureReason: [null, 'é'.repeat(8193)], attempt: [0, 3], priorTaskId: [TASK_ID(1), 'p'], executionKind: ['retry_in_place', 'x'],
    recoverablePreview: ['', '€'.repeat(21846)], canonicalRefs: [[], 'x'], resumable: [false, 'yes'], createdAt: [-1, NaN], acknowledgedAt: [null, -1, 5],
    action: [null, 'collect', 'continue', 'resume', 'retry', 'recover_in_place', 'abandon', 'other'], acknowledgementIdentity: [HASH('a'), 'A'.repeat(64), 5],
    followUpTaskId: [null, 'f'], providerResetAt: [null, -1, 5, undefined], promptObserved: [{ attempt: 1, sequence: 9, observedAt: 0 }, { attempt: 1, sequence: 10, observedAt: 0 },
      { attempt: 2, sequence: 4, observedAt: 0 }, { attempt: 1, sequence: 0, observedAt: 0 }, { attempt: 1, sequence: 4, observedAt: -1 }, 'x', { attempt: 1.5, sequence: 4, observedAt: 0 }],
    autoResume: [null, 'x', { ...AUTO_RESUME, revision: 0 }],
    runCleanup: ['x', { state: 'done', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 0 },
      { state: 'done', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 0, code: 'x' },
      { state: 'failed', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 1 },
      { state: 'other', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 1 },
      { state: 'done', taskId: TASK_ID(99), childSessionId: task.childSessionId, leaseToken: 'l', attempts: 1 },
      { state: 'done', taskId: task.taskId, childSessionId: null, leaseToken: 'l', attempts: 1 },
      { state: 'done', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: ' ', attempts: 1 },
      { state: 'done', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: -1 },
      { state: 'done', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 1, stopped: 1.5 },
      { state: 'failed', taskId: task.taskId, childSessionId: task.childSessionId, leaseToken: 'l', attempts: 1, code: ' ' }],
    extra: [{ deep: [undefined] }],
  };
  for (const [field, values] of Object.entries(mutations)) {
    file.call('validateManagedTaskResultEnvelope', [file.ref('envelope', [['delete', [field]]])]);
    for (const value of values) file.call('validateManagedTaskResultEnvelope', [file.ref(rng.chance(0.5) ? 'full' : 'envelope', value === undefined ? [['delete', [field]]] : [['set', [field], value]])]);
  }
  for (const value of [null, undefined, 5, 'x', []]) file.call('validateManagedTaskResultEnvelope', [value]);
  const order = ['owner', 'envelopeId', 'taskId', 'rootSessionId', 'parentTaskId', 'childSessionId', 'directory', 'sequence', 'status', 'partial', 'failureReason',
    'attempt', 'priorTaskId', 'executionKind', 'recoverablePreview', 'canonicalRefs', 'resumable', 'createdAt', 'acknowledgedAt', 'action', 'acknowledgementIdentity',
    'followUpTaskId', 'providerResetAt', 'promptObserved', 'autoResume', 'runCleanup'];
  for (let index = 1; index < order.length; index += 1) {
    file.call('validateManagedTaskResultEnvelope', [file.ref('full', [['set', [order[index]], { bad: 1 }], ['set', [order[index - 1]], { bad: 1 }]])]);
  }
  file.call('validateManagedTaskResultEnvelope', [file.ref('full', [['set', ['action'], null]])]);

  file.base('autoResume', AUTO_RESUME);
  file.call('validateManagedTaskAutoResume', [file.ref('autoResume')]);
  for (const value of [null, undefined, 'x', [], 5]) file.call('validateManagedTaskAutoResume', [value]);
  const minimal = { revision: 1, enabled: false, state: 'planning', cancelGeneration: 0, lineageStartedAt: 0, expiresAt: 0 };
  file.call('validateManagedTaskAutoResume', [minimal]);
  file.call('validateManagedTaskAutoResume', [{ ...minimal, attemptCount: null, resetSource: null, target: undefined, lastError: null, '1': 'index' }]);
  const autoResumeMutations = {
    revision: [0, 1.5, '1'], enabled: [1, null], state: AUTO_RESUME_STATE_LIST.concat(['other']), trigger: ['provider_transport', 'other', undefined, null],
    cancelGeneration: [-1, 0.5], lineageStartedAt: [-1, NaN], expiresAt: [Infinity], attemptCount: [-1, null], noSignalProbes: [1.5, undefined], rejectionsInWindow: ['1'],
    hostFailures: [-0], windowResetAt: [-1, undefined], nextAttemptAt: [NaN], resetAt: [null, -0], lastAttemptAt: ['x'], resetSource: ['backoff', 'meridian_quota', 'other', undefined],
    reason: AUTO_RESUME_REASON_LIST.concat(['other']), lastAttemptTaskId: ['task', null, undefined], recoveryCycleTaskId: ['task', undefined], backupAttemptTaskId: [TASK_ID(4), 'x'],
    target: [null, 'x', { kind: 'backup', providerId: 'p', modelId: 'm' }, { kind: 'backup', providerId: 'p', modelId: 'm', variant: 'v' }, { kind: 'other', providerId: 'p', modelId: 'm' },
      { kind: 'original', providerId: ' ', modelId: 'm' }, { kind: 'original', providerId: 'p', modelId: 5 }, { kind: 'original', providerId: 'p', modelId: 'm', variant: ' ' }],
    lastError: [null, 'x', { code: 'c', message: '', at: 0 }, { code: ' ', message: 'm', at: 0 }, { code: 'c', message: 5, at: 0 }, { code: 'c', message: 'm', at: -1 }, { code: 'c', message: 'm', at: 0, extra: 1 }],
    extra: ['x'],
  };
  const resumeOrder = ['revision', 'enabled', 'state', 'trigger', 'cancelGeneration', 'lineageStartedAt', 'expiresAt', 'attemptCount', 'noSignalProbes',
    'rejectionsInWindow', 'hostFailures', 'windowResetAt', 'nextAttemptAt', 'resetAt', 'lastAttemptAt', 'resetSource', 'reason', 'lastAttemptTaskId',
    'recoveryCycleTaskId', 'backupAttemptTaskId', 'target', 'lastError'];
  for (let index = 1; index < resumeOrder.length; index += 1) {
    file.call('validateManagedTaskAutoResume', [file.ref('autoResume', [['set', [resumeOrder[index]], { bad: 1 }], ['set', [resumeOrder[index - 1]], { bad: 1 }]])]);
  }
  for (const [field, values] of Object.entries(autoResumeMutations)) {
    for (const value of values) file.call('validateManagedTaskAutoResume', [file.ref('autoResume', value === undefined ? [['delete', [field]]] : [['set', [field], value]])]);
  }

  file.base('envelopeTask', task);
  file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask'), { sequence: 3, createdAt: 2_002, resumable: true, providerResetAt: 7_000 }]);
  for (const options of [undefined, null, {}, { sequence: 3 }, { sequence: 3, createdAt: 5 }, { sequence: 0, createdAt: 5 }, { sequence: 3, createdAt: 5, resumable: 'yes', providerResetAt: -1 },
    { sequence: 3, createdAt: 5, providerResetAt: Infinity }, { sequence: [4], createdAt: 5 }, { sequence: 1.5, createdAt: 5 }, 'x', { sequence: 3, createdAt: 5, providerResetAt: -0 }]) {
    file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask'), options]);
  }
  file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask', [['set', ['childSessionId'], null]]), { sequence: 3, createdAt: 5, resumable: true }]);
  file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask', [['set', ['canonicalRefs'], [{ type: 'm', id: 'x', extra: [1] }, 'str', null, 5, ['a']]]]), { sequence: 3, createdAt: 5 }]);
  file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask', [['set', ['status'], 'running']]), { sequence: 3, createdAt: 5 }]);
  file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask', [['set', ['taskId'], 'bad']]), { sequence: 3, createdAt: 5 }]);
  for (const status of ['completed', 'aborted', 'interrupted']) file.call('createManagedTaskResultEnvelope', [file.ref('envelopeTask', [['set', ['status'], status]]), { sequence: 3, createdAt: 5 }]);

  file.call('assertManagedTaskResultEnvelopeMatchesTask', [file.ref('envelopeTask'), file.ref('envelope')]);
  for (const field of [...codec.MANAGED_RESULT_PAYLOAD_FIELDS, 'canonicalRefs']) {
    const value = { taskId: TASK_ID(77), rootSessionId: 'ses_other', parentTaskId: TASK_ID(1), childSessionId: 'ses_other', directory: '/other', status: 'completed', partial: false,
      failureReason: null, attempt: 2, priorTaskId: TASK_ID(1), executionKind: 'retry', recoverablePreview: 'other', canonicalRefs: [] }[field];
    file.call('assertManagedTaskResultEnvelopeMatchesTask', [file.ref('envelopeTask'), file.ref('envelope', [['set', [field], value]])]);
  }
  file.call('assertManagedTaskResultEnvelopeMatchesTask', [file.ref('envelopeTask', [['set', ['status'], 'queued']]), file.ref('envelope')]);
  file.call('assertManagedTaskResultEnvelopeMatchesTask', [file.ref('envelopeTask', [['set', ['label'], 5]]), file.ref('envelope')]);
  file.call('assertManagedTaskResultEnvelopeMatchesTask', [file.ref('envelopeTask'), file.ref('envelope', [['set', ['owner'], 'x']])]);
}

const AUTO_RESUME_STATE_LIST = codec.AUTO_RESUME_STATES;
const AUTO_RESUME_REASON_LIST = codec.AUTO_RESUME_REASONS;

const FAILURES = [USAGE_LIMIT, 'model not found', 'unauthorized', "select global in your workspace's privacy settings", 'Runtime capability unavailable: x',
  'invalid prompt flagged for usage policy', 'Managed task timed out at 2000', 'socket hang up', 'stream idle timeout', 'plain failure', null];

function predicateRows(file, _rng) {
  file.base('predicateTask', settledTask(5));
  const envelope = envelopeOf(settledTask(5), 11);
  file.base('predicateEnvelope', envelope);
  // One factor at a time around configurations where each predicate holds.
  const lease = `dvr_lease_${hex32(5)}`;
  const stop = (state) => ({ requestedAt: 1, requestId: 'r', leaseToken: lease, ...(state === undefined ? {} : { state }) });
  const configurations = {
    attemptManual: { status: 'failed', failureReason: 'plain failure', attempt: 2 },
    abortedStop: { status: 'aborted', failureReason: null, partial: false },
    acceptedStop: { status: 'interrupted', failureReason: 'plain failure', mode: 'builder', dispatchGroupId: null, operatorStop: stop('accepted') },
    usageLimit: { status: 'failed', failureReason: USAGE_LIMIT },
    transportBackup: { status: 'failed', failureReason: 'stream idle timeout', mode: 'builder', dispatchGroupId: null, transportRecovery: TRANSPORT },
    uncertainStop: { status: 'failed', failureReason: 'plain failure', operatorStop: stop('uncertain') },
    agentRetry: { status: 'failed', failureReason: 'plain failure' },
  };
  const factors = {
    status: ['failed', 'interrupted', 'aborted', 'completed', 'running'],
    failureReason: FAILURES,
    attempt: [1, 2, 3],
    mode: ['orchestrator', 'builder'],
    dispatchGroupId: [null, 'msg_group'],
    childSessionId: [null, ''],
    operatorStop: [null, stop(undefined), stop('pending'), stop('accepted'), stop('uncertain')],
    terminationIntent: ['user_stopped', null],
    transportRecovery: [null, TRANSPORT, { ...TRANSPORT, backupAttempts: 1 }, { ...TRANSPORT, phase: 'submitted' }],
  };
  const envelopes = {
    resumable: [],
    collected: [['set', ['action'], 'collect'], ['set', ['acknowledgedAt'], 2_600]],
    final: [['set', ['resumable'], false]],
  };
  const envelopeChoices = [null, undefined, ...Object.keys(envelopes)];
  for (const [name, fields] of Object.entries(configurations)) {
    file.base(name, { ...settledTask(5), ...fields });
    const envelopeRef = (choice) => (choice === null || choice === undefined ? choice : file.ref('predicateEnvelope', envelopes[choice]));
    for (const choice of envelopeChoices) {
      file.call('taskPredicates', [file.ref(name), envelopeRef(choice)]);
      file.call('toManagedTaskEvent', [file.ref(name), envelopeRef(choice)]);
    }
    for (const [field, values] of Object.entries(factors)) {
      for (const value of values) {
        if (Object.is(value, fields[field] ?? settledTask(5)[field])) continue;
        file.call('taskPredicates', [file.ref(name, [['set', [field], value]]), envelopeRef('resumable')]);
      }
    }
  }
  file.call('toManagedTaskEvent', [file.ref('acceptedStop', [['set', ['operatorStop'], stop('pending')]]), file.ref('predicateEnvelope')]);
  file.call('toManagedTaskEvent', [file.ref('attemptManual', [['set', ['operatorStop'], stop('pending')]]), file.ref('predicateEnvelope')]);
  file.call('toManagedTaskEvent', [file.ref('attemptManual', [['set', ['requiredChecks'], []], ['set', ['taskPrerequisites'], []]]), null]);
  file.call('toManagedTaskEvent', [file.ref('attemptManual'), file.ref('predicateEnvelope', [['set', ['owner'], 'someone']])]);
  file.call('toManagedTaskEvent', [file.ref('attemptManual'), file.ref('predicateEnvelope', [['set', ['extra'], [NaN]]])]);
  file.call('taskPredicates', [file.ref('agentRetry', [['set', ['label'], 5]]), null]);
  file.call('taskPredicates', [file.ref('agentRetry', [['set', ['executionBackend'], 'native-job'], ['set', ['nativeJobSegments'], [SEGMENT]]]), null]);
  file.call('taskPredicates', [file.ref('agentRetry', [['set', ['executionBackend'], 'native-job'], ['set', ['nativeJobSegments'], []]]), null]);
  for (const backend of [undefined, 'legacy-session', 'cursor', 'native-job']) {
    for (const nativeJobSegments of [[SEGMENT], [], 'x', undefined]) file.call('requiresManagedNativeInputDisposition', [{ executionBackend: backend, status: 'failed', nativeJobSegments }]);
  }
  file.call('requiresManagedNativeInputDisposition', [null]);
  for (const status of ['aborted', 'interrupted', 'completed']) file.call('taskPredicates', [file.ref('abortedStop', [['set', ['status'], status], ['set', ['executionBackend'], 'native-job'], ['set', ['nativeJobSegments'], [SEGMENT]]]), null]);
  for (const value of [null, undefined, 'x', {}]) {
    file.call('isStoppedRecoveryAvailable', [value, envelope]);
    file.call('requiresManualModelRecovery', [value, envelope]);
    file.call('isAutoResumeEligible', [value, envelope]);
  }
  file.call('isStoppedRecoveryAvailable', [{ status: 'aborted', childSessionId: 'c', operatorStop: 'x' }, envelope]);
  file.call('isStoppedRecoveryAvailable', [{ status: 'aborted', childSessionId: 'c', operatorStop: { state: 'accepted' } }, { resumable: 1, action: null }]);
  file.call('requiresManualModelRecovery', [{ childSessionId: '' }, envelope]);
  file.call('toManagedTaskEvent', [file.ref('predicateTask'), { owner: 'devryan', taskId: TASK_ID(6) }]);
  file.call('toManagedTaskEvent', [file.ref('predicateTask'), { owner: 'devryan', taskId: TASK_ID(5), extra: undefined }]);
  file.call('toManagedTaskEvent', [file.ref('predicateTask'), 'x']);
  file.call('toManagedTaskEvent', [file.ref('predicateTask', [['set', ['requiredChecks'], [COMMAND_CHECK]], ['set', ['taskPrerequisites'], [PREREQUISITE]], ['set', ['waitingReason'], null]]), undefined]);
  file.call('toManagedTaskEvent', [file.ref('predicateTask', [['set', ['owner'], 'x']]), undefined]);
  file.call('toManagedTaskRemovalEvent', [file.ref('predicateTask')]);
  file.call('toManagedTaskRemovalEvent', [file.ref('predicateTask', [['set', ['sequence'], 0]])]);

  file.call('createManagedTaskRecord', [baseTaskInput(1)]);
  for (const ops of [[], [['set', ['readOnly'], null]], [['set', ['dispatchGroupId'], 'g']], [['set', ['owner'], 'someone'], ['set', ['status'], 'running']],
    [['set', ['transportRecovery'], TRANSPORT]], [['set', ['childSessionId'], 'ses_x']], [['set', ['recoveryLineageId'], 'dvr_lineage_x']], [['delete', ['label']]],
    [['set', ['leaseToken'], 'dvr_lease_x'], ['set', ['extra'], [1]]], [['set', ['canonicalRefs'], ['x']]], [['set', ['1'], 'index']], [['set', ['dispatchWaveId'], 'wave']]]) {
    file.call('createManagedTaskRecord', [applyOps(baseTaskInput(2), ops)]);
  }
  for (const value of [null, undefined, 'x', [], 5]) file.call('createManagedTaskRecord', [value]);
}

function recordVectors() {
  const file = new VectorFile('records.jsonl');
  const rng = prng(0x5eed0003);
  taskValidationRows(file, rng);
  leafRows(file, rng);
  envelopeRows(file, rng);
  predicateRows(file, rng);
  return file;
}

// ---------------------------------------------------------------------------
// Ledgers the real scheduler saves, driven under Node with a scripted
// executor, a virtual clock and the harness's identifiers.

async function driveScheduler() {
  let clock = 1_000_000;
  let taskCount = 0;
  let leaseCount = 0;
  let waveCount = 0;
  const saves = [];
  const outcome = (task) => ({
    alpha: { status: 'completed', recoverablePreview: 'alpha done', canonicalRefs: [{ type: 'message', id: 'msg_alpha' }] },
    beta: { status: 'failed', failureReason: USAGE_LIMIT, partial: true, recoverablePreview: 'beta partial', canonicalRefs: [], resumable: true },
    gamma: { status: 'failed', failureReason: 'socket hang up', partial: true, recoverablePreview: '', canonicalRefs: [{ type: 'file', id: 'src/a.js' }], resumable: true },
    delta: { status: 'completed', recoverablePreview: 'delta €😀', canonicalRefs: [] },
    epsilon: { status: 'failed', failureReason: 'model not found', partial: false, recoverablePreview: '', canonicalRefs: [], resumable: false },
  })[task.label] ?? { status: 'completed', recoverablePreview: `${task.label} done`, canonicalRefs: [] };
  const instance = scheduler.createManagedTaskScheduler({
    executor: {
      async start(task, control) {
        await control.setChildSessionId(`ses_child_${task.label}`);
        clock += 100;
        await control.markAccepted();
        clock += 1_000;
        return outcome(task);
      },
      async resume(task, control) { await control.markAccepted(); clock += 500; return { status: 'completed', recoverablePreview: 'resumed' }; },
      async retryInPlace(task, control) { await control.markAccepted(); clock += 500; return { status: 'completed', recoverablePreview: 'retried in place' }; },
      async abort() { return { aborted: true }; },
      async reconcile() { return { state: 'unavailable' }; },
      async readRecoverableResult() { return {}; },
    },
    persistence: { async load() { return null; }, async save(snapshot) { saves.push(structuredClone(snapshot)); } },
    now: () => clock,
    createTaskId: () => TASK_ID(++taskCount),
    createLeaseToken: () => `dvr_lease_${hex32(++leaseCount)}`,
    createWaveId: () => `dvr_wave_${hex32(++waveCount)}`,
    scheduleTimeout: () => ({ unref() {} }),
    cancelTimeout: () => {},
    logger: { warn() {}, info() {}, error() {}, debug() {}, log() {} },
  });
  await instance.initialize();
  const input = (label, overrides = {}) => ({
    idempotencyKey: `key-${label}`, rootSessionId: 'ses_root', parentTaskId: null, directory: '/workspace', mode: 'orchestrator', providerId: 'github-copilot',
    modelId: 'gpt-4.1', agent: 'explorer', variant: null, label, prompt: `Perform ${label}.`, timeoutAt: null, ...overrides,
  });
  const settle = async (label, overrides) => {
    const task = await instance.submit(input(label, overrides));
    clock += 10;
    return instance.waitForTask(task.taskId);
  };
  const alpha = await settle('alpha', { dispatchGroupId: 'msg_group', dispatchCallId: 'call_alpha' });
  const beta = await settle('beta', { dispatchGroupId: 'msg_group', dispatchCallId: 'call_beta' });
  await settle('gamma', { rootSessionId: 'ses_other' });
  const delta = await settle('delta', { requiredChecks: [COMMAND_CHECK] });
  await settle('epsilon', { variant: 'high', timeoutAt: clock + 3_600_000 });
  await instance.acknowledgeResult(alpha.taskId, { action: 'collect', idempotencyKey: 'collect-alpha' });
  await instance.acknowledgeResult(delta.taskId, { action: 'collect', idempotencyKey: 'collect-delta' });
  clock += 60_000;
  const retried = await instance.acknowledgeResult(beta.taskId, { action: 'retry_in_place', idempotencyKey: 'retry-beta', providerId: 'openai', modelId: 'gpt-5', variant: 'high' });
  const followUp = retried?.followUpTask?.taskId ?? retried?.task?.taskId ?? null;
  if (followUp) await instance.waitForTask(followUp);
  await settle('zeta', { parentTaskId: null });
  return saves;
}

// ---------------------------------------------------------------------------
// codec.jsonl: the ledger decoder and the persisted bytes.

async function codecVectors() {
  const file = new VectorFile('codec.jsonl');
  const rng = prng(0x5eed0004);
  const saves = await driveScheduler();
  if (saves.length < 10) throw new Error(`the scheduler drive saved ${saves.length} ledgers`);
  const picked = [saves[1], saves[Math.floor(saves.length / 2)], saves.at(-1)];
  picked.forEach((save, index) => file.base(`saved${index}`, save));
  for (let index = 0; index < picked.length; index += 1) file.call('encodeLedgerSnapshot', [file.ref(`saved${index}`)]);
  file.call('decodeLedgerSnapshot', [file.ref('saved2'), undefined]);
  const last = picked.at(-1);
  // Records with older fields missing, unknown and index-like keys, and objective checks.
  const legacyOps = [];
  for (const [index] of last.tasks.entries()) {
    for (const field of ['dispatchGroupId', 'dispatchCallId', 'dispatchWaveId', 'readOnly', 'recoveryLineageId', 'childPromptedAt', 'firstAssistantPartAt', 'waitingReason']) {
      if (rng.chance(0.5)) legacyOps.push(['delete', ['tasks', index, field]]);
    }
  }
  for (const [index] of last.resultEnvelopes.entries()) for (const field of ['providerResetAt', 'autoResume']) if (rng.chance(0.6)) legacyOps.push(['delete', ['resultEnvelopes', index, field]]);
  file.call('encodeLedgerSnapshot', [file.ref('saved2', legacyOps)]);
  file.call('decodeLedgerSnapshot', [file.ref('saved2', legacyOps), undefined]);
  file.call('encodeLedgerSnapshot', [file.ref('saved2', [['set', ['tasks', 0, 'zeta'], 1], ['set', ['tasks', 0, '3'], 'three'], ['set', ['extraTop'], { a: [1] }], ['set', ['0'], 'first']])]);

  // Small ledgers: every structural failure and every envelope mismatch.
  const one = settledTask(1, { childSessionId: 'ses_c1' });
  const two = settledTask(2);
  const small = { version: 1, tasks: [one, queuedTask(3)], resultEnvelopes: [envelopeOf(one, 4)] };
  file.base('small', small);
  file.base('pair', { version: 1, tasks: [one, two], resultEnvelopes: [envelopeOf(one, 4), envelopeOf(two, 5)] });
  const variantsOf = [
    [], [['set', ['version'], 2]], [['set', ['version'], '1']], [['delete', ['version']]], [['set', ['tasks'], 'x']], [['delete', ['tasks']]], [['delete', ['resultEnvelopes']]],
    [['set', ['resultEnvelopes'], null]], [['set', ['resultEnvelopes'], 'x']], [['push', ['tasks'], one]], [['push', ['tasks'], { ...queuedTask(9), idempotencyKey: 'key-3' }]],
    [['push', ['tasks'], { ...queuedTask(9), idempotencyKey: 'key-3', rootSessionId: 'ses_elsewhere' }]], [['push', ['resultEnvelopes'], envelopeOf(one, 6)]],
    [['push', ['resultEnvelopes'], envelopeOf(settledTask(50), 6)]], [['set', ['tasks', 0, 'status'], 'bogus']], [['set', ['resultEnvelopes', 0, 'status'], 'queued']],
    [['push', ['tasks'], null]], [['push', ['tasks'], 'task']], [['push', ['resultEnvelopes'], ['envelope']]], [['set', ['tasks', 0, 'canonicalRefs'], []]],
    [['set', ['objectiveChecks'], []]], [['set', ['objectiveChecks'], 'x']], [['set', ['objectiveChecks'], [null]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', requiredChecks: [COMMAND_CHECK], requiredCheckReceipts: [PASSED_RECEIPT], updatedAt: 5 }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o' }, { rootSessionId: 'r', directory: '/d', objectiveId: 'o' }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', extra: 1 }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: '', directory: '/d', objectiveId: 'o' }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: 'd'.repeat(4097), objectiveId: 'o' }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', updatedAt: -1 }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', requiredChecks: [COMMAND_CHECK], requiredCheckReceipts: [{ ...PASSED_RECEIPT, status: 'x' }] }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', requiredCheckCorrections: 'x' }]]],
    [['set', ['objectiveChecks'], [{ rootSessionId: 'r', directory: '/d', objectiveId: 'o', requiredChecks: 'x' }]]],
    [['set', ['objectiveChecks'], undefined]], [['set', ['tasks', 1, 'prompt'], '']], [['set', ['resultEnvelopes', 0, 'autoResume'], AUTO_RESUME]],
  ];
  for (const ops of variantsOf) {
    for (const options of [undefined, { requireResultEnvelopes: false, createError: 'tagged' }]) file.call('decodeLedgerSnapshot', [file.ref('small', ops), options]);
  }
  for (const ops of variantsOf.slice(0, 14)) file.call('encodeLedgerSnapshot', [file.ref('small', ops)]);
  file.call('decodeLedgerSnapshot', [file.ref('small'), { requireResultEnvelopes: true, createError: 'tagged' }]);
  file.call('decodeLedgerSnapshot', [file.ref('pair'), undefined]);
  for (const field of [...codec.MANAGED_RESULT_PAYLOAD_FIELDS, 'canonicalRefs']) {
    const value = { taskId: TASK_ID(2), rootSessionId: 'ses_other', parentTaskId: TASK_ID(1), childSessionId: 'ses_other', directory: '/other', status: 'completed', partial: false,
      failureReason: null, attempt: 2, priorTaskId: TASK_ID(1), executionKind: 'retry', recoverablePreview: 'other', canonicalRefs: [{ type: 'message', id: 'other' }] }[field];
    file.call('decodeLedgerSnapshot', [file.ref('pair', [['set', ['resultEnvelopes', 0, field], value]]), undefined]);
  }
  for (const value of [null, undefined, 'ledger', [], { version: 1 }]) file.call('decodeLedgerSnapshot', [value, undefined]);
  for (const value of [{}, settledTask(4), 'x']) file.call('decodeManagedTaskRecord', [value]);
  file.call('decodeResultEnvelope', [envelopeOf(one, 4)]);
  return { file, saves };
}

// ---------------------------------------------------------------------------
// persistence.jsonl: retention, lineage, tombstones.

function syntheticLedger(rng, size) {
  const tasks = [];
  const resultEnvelopes = [];
  const roots = ['ses_a', 'ses_b', 'ses_c'];
  for (let index = 0; index < size; index += 1) {
    const n = 100 + index;
    const status = rng.pick(['completed', 'completed', 'failed', 'aborted', 'interrupted', 'queued', 'running']);
    const terminal = contract.isTerminalManagedTaskStatus(status);
    const createdAt = 1_000 + rng.int(40) * 100;
    const prior = index > 0 && rng.chance(0.35) ? tasks[rng.int(index)].taskId : null;
    const task = {
      taskId: TASK_ID(n), rootSessionId: rng.pick(roots), status, createdAt, startedAt: rng.chance(0.8) ? createdAt + 10 : null,
      finishedAt: terminal ? createdAt + rng.int(30) * 100 : null, sequence: index + 1, priorTaskId: prior,
      recoveryLineageId: prior && rng.chance(0.4) ? `dvr_lineage_${hex32(100)}` : null, dispatchGroupId: rng.chance(0.4) ? 'msg_group' : null,
      parentTaskId: index > 0 && rng.chance(0.1) ? tasks[rng.int(index)].taskId : null, prompt: `p${'x'.repeat(rng.int(300))}`, failureReason: rng.chance(0.3) ? 'failed hard' : null,
      recoverablePreview: 'r'.repeat(rng.int(200)), canonicalRefs: rng.chance(0.3) ? [{ type: 'message', id: `msg_${n}` }] : [],
    };
    if (rng.chance(0.2)) {
      task.executionBackend = 'native-job';
      const segment = { jobID: `job_${n}`, notificationID: 'msg_n', messageID: 'msg_m', state: 'accepted' };
      const completion = rng.pick(['pending', 'done', undefined]);
      task.nativeJobSegments = [completion === undefined ? segment : { ...segment, completion }];
      if (rng.chance(0.2)) task.prompt = persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT;
      if (rng.chance(0.3)) { task.requiredChecks = [{ name: 'unit', command: 'npm test', paths: ['src/a.js'] }]; task.approvedPlanRef = { phase: 'Phase 1' }; task.dispatchObjectiveId = 'obj'; }
    }
    if (rng.chance(0.15)) task.requiredChecks = [{ name: 'unit', command: 'npm test', paths: ['src/a.js'] }];
    if (!terminal && rng.chance(0.3) && index > 0) task.taskPrerequisites = [{ ...PREREQUISITE, taskId: tasks[rng.int(index)].taskId }];
    tasks.push(task);
    if (terminal && rng.chance(0.85)) {
      const action = rng.pick([null, null, 'collect', 'retry', 'retry_in_place', 'abandon']);
      resultEnvelopes.push({
        owner: 'devryan', envelopeId: `dvr_result_${hex32(n)}_${index}`, taskId: task.taskId, status, failureReason: task.failureReason, recoverablePreview: task.recoverablePreview,
        canonicalRefs: task.canonicalRefs, createdAt: task.finishedAt, acknowledgedAt: action === null ? null : task.finishedAt + rng.int(10) * 100, action,
        autoResume: rng.chance(0.1) ? { enabled: rng.chance(0.8), state: rng.pick(['scheduled', 'attempting', 'exhausted']) } : null,
      });
    }
  }
  return { version: 1, ...(rng.chance(0.2) ? { objectiveChecks: [{ rootSessionId: 'ses_a', directory: '/d', objectiveId: 'o' }] } : {}), tasks, resultEnvelopes };
}

function persistenceVectors(saves) {
  const file = new VectorFile('persistence.jsonl');
  const rng = prng(0x5eed0005);
  for (let index = 0; index < 12; index += 1) {
    const name = `ledger${index}`;
    file.base(name, syntheticLedger(rng, 3 + rng.int(10)));
    for (let run = 0; run < 2; run += 1) {
      const options = {
        now: 1_000 + rng.int(80) * 100,
        ...(rng.chance(0.7) ? { maxTerminalRecords: rng.pick([0, 1, 2, 3, 5, 8, Infinity, NaN]) } : {}),
        ...(rng.chance(0.7) ? { maxAgeMs: rng.pick([0, 500, 1_500, 3_000, Infinity, null]) } : {}),
        ...(rng.chance(0.6) ? { maxBytes: rng.pick([300, 1_000, 2_500, 5_000, 20_000, Infinity, '1000']) } : {}),
        ...(rng.chance(0.3) ? { expireUnacknowledged: rng.pick([false, true, 0]) } : {}),
        ...(rng.chance(0.3) ? { assumeOwnedInput: true } : {}),
      };
      file.call('compactManagedOrchestrationState', [file.ref(name), options]);
    }
  }
  // A long lineage of acknowledged attempts: the eager bound keeps three.
  const chain = [];
  for (let index = 0; index < 7; index += 1) {
    chain.push({ taskId: TASK_ID(200 + index), rootSessionId: 'ses_a', status: 'failed', createdAt: 1_000 + index, startedAt: null, finishedAt: 1_100 + (index % 3), sequence: 7 - index,
      priorTaskId: index ? TASK_ID(199 + index) : null, recoveryLineageId: null, dispatchGroupId: null, parentTaskId: null, prompt: 'p', canonicalRefs: [] });
  }
  const chainEnvelopes = chain.map((task, index) => ({ taskId: task.taskId, action: index < 6 ? 'retry_in_place' : null, createdAt: task.finishedAt, acknowledgedAt: 1_200 }));
  file.base('chain', { version: 1, tasks: chain, resultEnvelopes: chainEnvelopes });
  for (const now of [1_300, 99_999_999]) file.call('compactManagedOrchestrationState', [file.ref('chain'), { now }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 6, 'status'], 'running']]), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 0, 'taskId'], 'task_root']]), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [3, 4, 5].map(index => ['set', ['tasks', index, 'recoveryLineageId'], 'dvr_lineage_other'])), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [0, 1, 2, 3].map(index => ['set', ['tasks', index, 'recoveryLineageId'], `dvr_lineage_${index % 2}`])), { now: 1_300 }]);
  // Boundaries: an age exactly at the cap, a root active exactly at the cap,
  // and a byte cap that holds only once tombstone bytes are left out.
  const at = (n, finishedAt, overrides = {}) => ({ taskId: TASK_ID(n), rootSessionId: 'ses_edge', status: 'completed', createdAt: finishedAt - 50, startedAt: null,
    finishedAt, sequence: n, priorTaskId: null, recoveryLineageId: null, dispatchGroupId: null, parentTaskId: null, prompt: 'p', canonicalRefs: [], ...overrides });
  const atEnvelope = (task, action) => ({ taskId: task.taskId, action, createdAt: task.finishedAt, acknowledgedAt: action === null ? null : task.finishedAt });
  const edges = [at(401, 1_000), at(402, 2_000, { dispatchGroupId: 'g' }), at(405, 2_000)];
  file.base('edges', { version: 1, tasks: edges, resultEnvelopes: [atEnvelope(edges[0], 'collect'), atEnvelope(edges[1], null), atEnvelope(edges[2], 'collect')] });
  for (const options of [{ now: 3_000, maxAgeMs: 1_000 }, { now: 3_000, maxAgeMs: 1_000, maxTerminalRecords: 0 }, { now: 3_001, maxAgeMs: 1_000, maxTerminalRecords: 0 }]) {
    file.call('compactManagedOrchestrationState', [file.ref('edges'), options]);
  }
  const proof = { ...at(403, 1_000), executionBackend: 'native-job', nativeJobSegments: [{ ...SEGMENT, completion: 'pending' }], prompt: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT };
  const plain = at(404, 1_500, { prompt: 'q'.repeat(10) });
  const tombstoned = { version: 1, tasks: [proof, plain], resultEnvelopes: [atEnvelope(proof, 'collect'), atEnvelope(plain, 'collect')] };
  file.base('tombstoned', tombstoned);
  const total = persistence.compactManagedOrchestrationState(tombstoned, { now: 2_000, maxAgeMs: Infinity }).serializedBytes;
  const proofBytes = Buffer.byteLength(JSON.stringify(proof)) + Buffer.byteLength(JSON.stringify(tombstoned.resultEnvelopes[0]));
  for (const maxBytes of [total - proofBytes, total - proofBytes - 1, total]) file.call('compactManagedOrchestrationState', [file.ref('tombstoned'), { now: 2_000, maxAgeMs: Infinity, maxBytes }]);
  // Retention of the real scheduler's ledger.
  file.base('saved', saves.at(-1));
  for (const options of [{ now: 2_000_000 }, { now: 5_000_000_000, maxAgeMs: 1_000 }, { now: 2_000_000, maxTerminalRecords: 1 }, { now: 2_000_000, maxBytes: 1_000 }]) {
    file.call('compactManagedOrchestrationState', [file.ref('saved'), options]);
  }
  // Inputs the JavaScript treats loosely and the domain edges.
  file.call('compactManagedOrchestrationState', [null, { now: 1 }]);
  file.call('compactManagedOrchestrationState', [5, { now: 1 }]);
  file.call('compactManagedOrchestrationState', [{}, { now: 1 }]);
  file.call('compactManagedOrchestrationState', [{ tasks: 'x', resultEnvelopes: {} }, { now: 1 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain'), null]);
  file.call('compactManagedOrchestrationState', [file.ref('chain'), undefined], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain'), { now: '1300' }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3, 'createdAt'], '5']]), { now: 1_300 }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3, 'finishedAt'], NaN]]), { now: 1_300 }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3, 'taskId'], 'dvr_task_UPPER']]), { now: 1_300 }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3], null]]), { now: 1_300 }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['objectiveChecks'], 'abc']]), { now: 1_300 }], { refuse: true });
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['objectiveChecks'], []]]), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3, 'taskPrerequisites'], [null]], ['set', ['tasks', 3, 'status'], 'queued']]), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['set', ['tasks', 3, 'nativeJobSegments'], [null]], ['set', ['tasks', 3, 'executionBackend'], 'native-job']]), { now: 1_300 }]);
  file.call('compactManagedOrchestrationState', [file.ref('chain', [['push', ['tasks'], { ...chain[2], prompt: 'duplicate id' }]]), { now: 1_300, maxTerminalRecords: 2 }]);
  for (const task of [nativeTask(7), { ...nativeTask(7), prompt: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT },
    { ...nativeTask(7), prompt: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT, status: 'completed', nativeJobSegments: [{ ...SEGMENT, completion: 'done' }] },
    { ...nativeTask(7), prompt: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT, status: 'running' },
    { ...nativeTask(7), prompt: persistence.MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT, status: 'completed', nativeJobSegments: [{ ...SEGMENT, completion: undefined }] }, { status: 'completed', executionBackend: 'native-job', nativeJobSegments: 'x' }, { status: 'failed', executionBackend: 'native-job', nativeJobSegments: 'x' }, null]) {
    file.call('isManagedNativeJobTombstone', [task], { refuse: task?.nativeJobSegments === 'x' && task.status === 'completed' });
  }
  return file;
}

// ---------------------------------------------------------------------------
// transitions.jsonl: allowed status changes and what a transition may change.

function transitionVectors() {
  const file = new VectorFile('transitions.jsonl');
  const rng = prng(0x5eed0006);
  const statuses = codec.MANAGED_TASK_STATUSES;
  for (const from of [...statuses, 'other', 'toString', '__proto__', 'constructor', 'hasOwnProperty', undefined, null, 5, ['queued'], { a: 1 }]) {
    for (const to of [...statuses, 'other', undefined]) {
      file.call('canTransitionManagedTaskStatus', [from, to]);
    }
  }
  file.call('canTransitionManagedTaskStatus', [['queued'], ['queued']], { refuse: true });

  const bases = {
    queued: queuedTask(30, { dispatchGroupId: 'msg_group', requiredChecks: [EDGE_CHECK] }),
    running: { ...queuedTask(31, { agent: 'fixer', timeoutAt: 100_000, transportRecovery: TRANSPORT }), status: 'running', leaseToken: 'dvr_lease_r', startedAt: 2_000, childSessionId: 'ses_r' },
    native: nativeTask(32),
    corrected: { ...correctedTask(33) },
    edge: { ...settledTask(34, { status: 'failed', failureReason: 'boom' }), requiredChecks: [EDGE_CHECK], requiredCheckReceipts: [EDGE_RECEIPT] },
  };
  for (const [name, value] of Object.entries(bases)) file.base(name, value);
  /** next = { ...previous } with top-level changes; `clone` breaks identity of a field. */
  const transition = (name, changes = [], clone = [], options = {}) => {
    const previous = file.ref(name);
    const next = { ...previous.value };
    for (const [op, key, item] of changes) {
      if (op === 'set') next[key] = structuredClone(item);
      else delete next[key];
    }
    for (const key of clone) next[key] = structuredClone(next[key]);
    const isContainer = value => value !== null && typeof value === 'object';
    const keys = [...new Set([...Object.keys(previous.value), ...Object.keys(next)])];
    const same = keys.filter(key => isContainer(previous.value[key]) && isContainer(next[key]) && Object.is(previous.value[key], next[key]));
    const nextRef = { [REF]: true, value: next, encoded: file.ref(name, changes.map(([op, key, item]) => (op === 'set' ? ['set', [key], item] : ['delete', [key]]))).encoded };
    file.call('assertManagedTaskTransition', [previous, nextRef, same], options);
  };
  transition('queued', [['set', 'status', 'starting'], ['set', 'leaseToken', 'dvr_lease_q']]);
  transition('queued', [['set', 'status', 'running']]);
  transition('queued', [['set', 'status', 'aborted'], ['set', 'finishedAt', 5_000]]);
  transition('queued', [['set', 'status', 'starting'], ['set', 'waitingReason', { kind: 'capacity', activeCount: 1, limit: 1, since: 1 }]]);
  transition('queued', [['set', 'waitingReason', { kind: 'capacity', activeCount: 1, limit: 1, since: 1 }]]);
  transition('queued', [['set', 'waitingReason', { kind: 'capacity', activeCount: 1, limit: 0, since: 1 }]]);
  transition('queued', [], ['requiredChecks']);
  transition('queued', [['set', 'requiredChecks', [COMMAND_CHECK]]]);
  transition('queued', [['delete', 'requiredChecks']]);
  transition('queued', [], ['canonicalRefs']);
  transition('running', [['set', 'status', 'completed'], ['set', 'finishedAt', 9_000], ['set', 'recoverablePreview', 'done']]);
  transition('running', [['set', 'status', 'queued']]);
  transition('running', [['set', 'timeoutAt', 100_000 + 15 * 60_000]]);
  transition('running', [['set', 'timeoutAt', 100_000 + 15 * 60_000 + 1]]);
  transition('running', [['set', 'timeoutAt', 99_000]]);
  transition('running', [['set', 'timeoutAt', null]]);
  transition('running', [['set', 'timeoutAt', 100_001], ['set', 'readOnly', true]]);
  transition('running', [['set', 'timeoutAt', 100_001], ['set', 'status', 'completed']]);
  transition('running', [['set', 'agent', 'designer']]);
  transition('running', [['set', 'transportRecovery', { ...TRANSPORT, revision: 3 }]]);
  transition('running', [], ['transportRecovery']);
  transition('running', [['set', 'status', 'failed'], ['set', 'failureReason', 'x'.repeat(20_000)]]);
  for (const field of ['owner', 'taskId', 'idempotencyKey', 'rootSessionId', 'dispatchGroupId', 'dispatchObjectiveId', 'dispatchCallId', 'dispatchWaveId', 'parentTaskId', 'directory',
    'sequence', 'mode', 'readOnly', 'providerId', 'modelId', 'agent', 'variant', 'label', 'prompt', 'approvedPlanRef', 'taskPrerequisites', 'attempt', 'priorTaskId', 'executionKind',
    'executionBackend', 'createdAt', 'recoveryLineageId']) {
    const value = rng.pick(['changed', 2, null, true]);
    transition(rng.chance(0.5) ? 'running' : 'native', [['set', field, value]]);
  }
  transition('native', [], ['approvedPlanRef']);
  transition('native', [], ['taskPrerequisites']);
  transition('native', [], ['nativeJobSegments']);
  transition('native', [['set', 'nativeJobSegments', [{ ...SEGMENT, completion: 'done' }]]]);
  transition('native', [['set', 'nativeJobSegments', [{ ...SEGMENT, completion: undefined }]]]);
  transition('native', [['set', 'nativeJobSegments', [{ ...SEGMENT, state: 'cancelled' }]]]);
  transition('native', [['set', 'nativeJobSegments', [null]]]);
  transition('native', [['set', 'nativeJobSegments', []]]);
  transition('native', [['set', 'operatorStop', { ...nativeTask(32).operatorStop, state: 'uncertain' }]]);
  transition('native', [['set', 'requiredCheckReceipts', [PASSED_RECEIPT]]]);
  transition('native', [['set', 'recoverablePreview', 'changed']]);
  transition('native', [['set', 'extra', 1]]);
  transition('native', [['delete', 'primaryStepBudget']]);
  transition('native', [], ['primaryStepBudget']);
  transition('native', [], ['canonicalRefs', 'requiredCheckReceipts', 'operatorStop']);
  transition('native', [['set', 'status', 'failed']]);
  const corrected = checkCorrection.applyCheckCorrection({ checks: [EDGE_CHECK], receipts: [EDGE_RECEIPT], history: [] }, { ...EDGE_CORRECTION, previousReceipt: EDGE_RECEIPT });
  transition('edge', [['set', 'requiredChecks', corrected.checks], ['set', 'requiredCheckReceipts', corrected.receipts], ['set', 'requiredCheckCorrections', corrected.history]]);
  transition('edge', [['set', 'requiredChecks', corrected.checks], ['set', 'requiredCheckCorrections', corrected.history]]);
  transition('edge', [['set', 'requiredChecks', corrected.checks], ['set', 'requiredCheckReceipts', corrected.receipts], ['set', 'requiredCheckCorrections', [{ ...corrected.history[0], reason: 'x' }]]]);
  transition('edge', [['set', 'requiredCheckCorrections', 'abc']]);
  transition('edge', [['set', 'requiredCheckCorrections', [null]]]);
  transition('edge', [['set', 'requiredCheckCorrections', { length: 1 }]], [], { refuse: true });
  transition('corrected', [], ['requiredChecks', 'requiredCheckCorrections']);
  transition('corrected', [['set', 'requiredCheckCorrections', []]]);
  for (const value of [null, undefined]) file.call('assertManagedTaskTransition', [file.ref('queued'), value, []]);
  file.base('designer', { ...bases.running, agent: 'designer' });
  for (const timeoutAt of [100_001, 100_000 + 15 * 60_000, 100_000 + 15 * 60_000 + 1]) {
    const previous = file.ref('designer');
    const next = { ...previous.value, timeoutAt };
    const same = Object.keys(next).filter(key => next[key] !== null && typeof next[key] === 'object');
    file.call('assertManagedTaskTransition', [previous, { [REF]: true, value: next, encoded: file.ref('designer', [['set', ['timeoutAt'], timeoutAt]]).encoded }, same]);
  }
  file.call('assertManagedTaskTransition', [file.ref('queued'), 'next', []], { refuse: true });
  file.call('assertManagedTaskTransition', [file.ref('queued', [['set', ['owner'], 'x']]), file.ref('queued'), []]);

  file.call('isCheckCorrectionTransition', [file.ref('edge'), { ...bases.edge, requiredChecks: corrected.checks, requiredCheckReceipts: corrected.receipts, requiredCheckCorrections: corrected.history }]);
  file.call('isCheckCorrectionTransition', [file.ref('edge'), { requiredCheckCorrections: [{ ...corrected.history[0], previousCheck: undefined }] }]);
  file.call('isCheckCorrectionTransition', [file.ref('edge'), { requiredCheckCorrections: ['abc'] }]);
  file.call('isCheckCorrectionTransition', [file.ref('edge'), { requiredCheckCorrections: [] }]);
  file.call('isCheckCorrectionTransition', [file.ref('edge'), { ...bases.edge, requiredCheckReceipts: corrected.receipts, requiredCheckCorrections: corrected.history }]);
  file.call('isManagedNativeJobReceiptTransition', [file.ref('native'), { nativeJobSegments: [{ ...SEGMENT, completion: 'done' }] }]);
  file.call('isManagedNativeJobReceiptTransition', [file.ref('native'), { nativeJobSegments: [{ ...SEGMENT, jobID: 'other' }] }]);
  file.call('isManagedNativeJobReceiptTransition', [file.ref('native'), { nativeJobSegments: [null] }]);
  file.call('isManagedNativeJobReceiptTransition', [file.ref('native'), {}]);
  file.call('isManagedNativeJobReceiptTransition', [file.ref('native'), { nativeJobSegments: [SEGMENT, { ...SEGMENT, jobID: 'dvr_job_two' }] }]);
  return file;
}

// ---------------------------------------------------------------------------
// auto-resume.jsonl: auto-resume-policy.js.

function autoResumeVectors() {
  const file = new VectorFile('auto-resume.jsonl');
  const rng = prng(0x5eed0007);
  const timestamps = [null, undefined, 0, 500, 1_000, 1_010, 5_000, 20_000, 25_000, 40_000, NaN, Infinity, -5, '9000'];
  const attempting = { ...AUTO_RESUME, state: 'attempting', resetAt: 30_000, resetSource: 'meridian_quota' };
  for (let index = 0; index < 45; index += 1) {
    const prior = rng.pick([null, undefined, attempting, { ...attempting, state: 'scheduled' }, { ...attempting, resetSource: undefined }, { ...attempting, recoveryCycleTaskId: undefined }, 'x']);
    file.call('initialAutoResumeState', [{ now: rng.pick([1_000, 10_000, 30_000]), enabled: rng.pick([true, false, 1, '', undefined]), providerResetAt: rng.pick(timestamps),
      prior, taskId: rng.pick([undefined, null, TASK_ID(3), TASK_ID(4)]) }], { refuse: false });
  }
  file.call('initialAutoResumeState', [{ now: undefined, enabled: true, providerResetAt: null }], { refuse: true });
  file.call('initialAutoResumeState', [{ now: 5, enabled: true, providerResetAt: null, prior: attempting, taskId: { id: 1 } }]);
  file.call('initialAutoResumeState', [{ now: 5, enabled: true, providerResetAt: null, prior: { ...attempting, lastAttemptTaskId: { id: 1 } }, taskId: { id: 1 } }], { refuse: true });
  file.base('state', AUTO_RESUME);
  const fieldOps = (fields) => Object.entries(fields).map(([key, item]) => (item === undefined && rng.chance(0.5) ? ['delete', [key]] : ['set', [key], item]));
  for (let index = 0; index < 50; index += 1) {
    const state = file.ref('state', fieldOps({ windowResetAt: rng.pick([null, 5_000, 20_000, 40_000, undefined]), resetAt: rng.pick([null, 6_000, 30_000]),
      resetSource: rng.pick(['meridian_quota', undefined, null]), rejectionsInWindow: rng.pick([0, 1, 2, null, undefined]), noSignalProbes: rng.pick([0, 3, null, true]) }));
    file.call('recordProviderRejection', [state, { now: rng.pick([1_000, 10_000, 25_000]), providerResetAt: rng.pick(timestamps) }]);
  }
  file.call('recordProviderRejection', [null, { now: 1, providerResetAt: null }]);
  for (const providerResetAt of [9_000, 9_500, 21_000, 30_000]) file.call('recordProviderRejection', [{ ...AUTO_RESUME, windowResetAt: 5_000 }, { now: 10_000, providerResetAt }]);
  file.call('recordProviderRejection', [{ ...AUTO_RESUME, rejectionsInWindow: '1', windowResetAt: 999_999 }, { now: 1, providerResetAt: null }], { refuse: true });
  file.call('recordProviderRejection', [{ ...AUTO_RESUME, windowResetAt: 'soon' }, { now: 1, providerResetAt: null }], { refuse: true });

  const task = settledTask(40, { readOnly: false });
  file.base('planTask', task);
  const breakerTables = [null, {}, { 'github-copilot': 30_000 }, { openai: 30_000 }, { openai: { until: 50_000, source: 'backoff' } }, { 'github-copilot': { until: 12_000, source: 5 } },
    { 'github-copilot': { until: 'x' } }, { 'github-copilot': 'tomorrow' }, { 'github-copilot': null }, { 'github-copilot': 500 }];
  const backups = [null, undefined, { providerId: 'openai', modelId: 'gpt-5', variant: 'high' }, { providerId: 'github-copilot', modelId: 'gpt-4.1' },
    { providerId: 'github-copilot', modelId: 'gpt-5' }, { providerId: 'cursor-acp', modelId: 'auto' }, { providerId: 5, modelId: 'x' }, 'backup', { providerId: 'openai' }];
  for (let index = 0; index < 140; index += 1) {
    const stateRef = file.ref('state', fieldOps({
      trigger: rng.pick(['provider_usage_limit', 'provider_transport', undefined]),
      attemptCount: rng.pick([0, 0, 1, 7, 8, null, undefined]),
      expiresAt: rng.pick([20_000, 100_000, 1_000_000, 0]),
      resetAt: rng.pick([null, 1_500, 15_000, 50_000, 2_000_000, NaN]),
      resetSource: rng.pick(['meridian_quota', null, undefined, 'backoff']),
      windowResetAt: rng.pick([null, 12_000, 2_000]),
      rejectionsInWindow: rng.pick([0, 1, 2, 3, null]),
      noSignalProbes: rng.pick([0, 1, 2, 3, 7, 1.5, 0.5, -3, null]),
      backupAttemptTaskId: rng.pick([null, null, TASK_ID(5)]),
      lastError: rng.pick([null, null, { code: 'backup_availability_unknown', message: '', at: 1 }, 'x']),
    }));
    const ops = [];
    if (rng.chance(0.3)) ops.push(['set', ['readOnly'], true]);
    if (rng.chance(0.2)) ops.push(['set', ['transportRecovery'], rng.pick([TRANSPORT, { ...TRANSPORT, backupAttempts: 1 }])]);
    if (rng.chance(0.2)) ops.push(['set', ['variant'], rng.pick([undefined, 'low'])]);
    const input = {
      now: rng.pick([10_000, 10_000, 30_000, 1_000_000]),
      ...(rng.chance(0.8) ? { backup: rng.pick(backups) } : {}),
      ...(rng.chance(0.4) ? { providerReset: rng.pick([null, { limited: true, resetAt: 40_000 }, { limited: false, resetAt: 40_000 }, { resetAt: 11_000 }, 'x']) } : {}),
      ...(rng.chance(0.3) ? { origin: rng.pick([null, { providerId: 'anthropic', modelId: 'claude', variant: null }, { providerId: 'anthropic' }, { variant: 'max' }]) } : {}),
      ...(rng.chance(0.3) ? { cursorReadOnly: rng.pick([true, false, 'true']) } : {}),
    };
    // The task is a reference to the base; the rest is plain.
    const taskRef = file.ref('planTask', ops);
    const params = { ...input, task: taskRef.value, state: stateRef.value };
    const encodedParams = { ...encode(input), task: taskRef.encoded, state: stateRef.encoded };
    const breakers = rng.pick(breakerTables);
    const row = { fn: 'planAutoResumeAttempt', args: [encodedParams, encode(breakers)] };
    try { row.ok = encode(CALLS.planAutoResumeAttempt(params, breakers)); } catch (error) { row.throw = encodeThrow(error); }
    file.lines.push(JSON.stringify(row));
  }
  file.call('planAutoResumeAttempt', [{ now: 1, task: null, state: AUTO_RESUME }, null]);
  // The backoff ladder alone: no reset, backup or rejection window.
  for (const noSignalProbes of [0, 0.5, 1, 1.5, 2, 2.5, 3, 7, -3, null, true, undefined, NaN]) {
    file.call('planAutoResumeAttempt', [{ now: 10_000, task, state: { ...AUTO_RESUME, resetAt: null, windowResetAt: null, rejectionsInWindow: 0, lastError: null, attemptCount: 0, expiresAt: 1e12, noSignalProbes } }, null]);
  }
  file.call('planAutoResumeAttempt', [{ now: 1, task, state: null }, null]);
  file.call('planAutoResumeAttempt', [{ now: '1', task, state: AUTO_RESUME }, null], { refuse: true });
  file.call('planAutoResumeAttempt', [{ now: 1, task, state: { ...AUTO_RESUME, attemptCount: '0' } }, null], { refuse: true });
  file.call('planAutoResumeAttempt', [{ now: 1, task, state: { ...AUTO_RESUME, trigger: 'provider_transport', attemptCount: 0 }, backup: { providerId: { p: 1 }, modelId: 'm' } }, null]);
  file.call('planAutoResumeAttempt', [{ now: 1, task: { ...task, providerId: { p: 1 } }, state: { ...AUTO_RESUME, trigger: 'provider_transport', attemptCount: 0 }, backup: { providerId: { p: 1 }, modelId: 'm' } }, null], { refuse: true });

  for (const envelope of [null, undefined, {}, { autoResume: null }, { autoResume: { target: null } }, { autoResume: AUTO_RESUME }, { autoResume: { ...AUTO_RESUME, target: { providerId: 'p', modelId: 'm' } } },
    { autoResume: { ...AUTO_RESUME, target: 'x' } }, { autoResume: { ...AUTO_RESUME, cancelGeneration: [1, 2], attemptCount: undefined } }]) {
    file.call('buildAutoResumeAcknowledgeParams', [{ task, envelope }]);
  }
  file.call('buildAutoResumeAcknowledgeParams', [{ task: null, envelope: { autoResume: AUTO_RESUME } }]);
  file.call('buildAutoResumeAcknowledgeParams', [{ task: { ...task, taskId: { toString: 'x' } }, envelope: { autoResume: AUTO_RESUME } }], { refuse: true });
  for (const envelope of [null, undefined, 'x', {}, { autoResume: 'x' }, { autoResume: { enabled: true, state: 'planning' } }, { autoResume: { enabled: 'true', state: 'planning' } },
    { autoResume: { enabled: true, state: 'exhausted' } }, { autoResume: AUTO_RESUME }]) {
    file.call('isAutoResumeActive', [envelope]);
  }
  return file;
}

// ---------------------------------------------------------------------------
// proof-store.jsonl: native proof shards.

function proofStoreVectors() {
  const file = new VectorFile('proof-store.jsonl');
  // Tombstones as compaction makes them, until one shard holds three.
  const byShard = new Map();
  let shard = null;
  for (let index = 0; shard === null && index < 400; index += 1) {
    const task = nativeTask(300 + index);
    delete task.operatorStop;
    delete task.terminationIntent;
    const released = persistence.compactManagedOrchestrationState({ version: 1, tasks: [task], resultEnvelopes: [envelopeOf(task, 1 + index)] }, { now: 9e12, maxAgeMs: 1 });
    if (released.tombstonedTaskIds.length !== 1) throw new Error('compaction made no tombstone');
    const proof = { task: released.state.tasks[0], envelope: released.state.resultEnvelopes[0] };
    const name = proofStore.managedNativeJobProofShard(proof.task.taskId);
    byShard.set(name, [...(byShard.get(name) ?? []), proof]);
    if (byShard.get(name).length === 3) shard = name;
  }
  const members = byShard.get(shard);
  const entries = members.map(({ task, envelope }) => ({ task, envelope }));
  file.base('entries', entries);
  file.call('encodeManagedNativeJobProofShard', [shard, file.ref('entries')]);
  const document = JSON.parse(proofStore.encodeManagedNativeJobProofShard(shard, entries));
  file.base('document', document);
  file.call('decodeManagedNativeJobProofShard', [file.ref('document'), shard]);
  const other = shard === '00' ? '01' : '00';
  for (const [ops, name] of [[[], other], [[], 'zz'], [[['set', ['extra'], 1]], shard], [[['set', ['shard'], other]], shard], [[['delete', ['resultEnvelopes']]], shard],
    [[['set', ['version'], 2]], shard], [[['push', ['tasks'], document.tasks[0]]], shard], [[['set', ['tasks', 0, 'prompt'], 'body']], shard],
    [[['set', ['tasks', 0, 'status'], 'bogus']], shard], [[['set', ['resultEnvelopes', 0], null]], shard], [[['set', ['resultEnvelopes'], []]], shard],
    [[['set', ['tasks', 0, 'requiredChecks'], 'x']], shard], [[['set', ['tasks', 0, 'requiredCheckCorrections'], 'x']], shard]]) {
    file.call('decodeManagedNativeJobProofShard', [file.ref('document', ops), name]);
  }
  for (const value of [null, 'x', [], { shard }]) file.call('decodeManagedNativeJobProofShard', [value, shard]);
  file.call('decodeManagedNativeJobProof', [entries[0]]);
  for (const entry of [null, {}, { task: { taskId: '' } }, { task: entries[0].task }, { task: entries[0].task, envelope: { ...entries[0].envelope, status: 'x' } }]) {
    file.call('decodeManagedNativeJobProof', [entry]);
  }
  file.call('encodeManagedNativeJobProofShard', [shard, [...entries].reverse()]);
  for (const [name, value] of [[other, entries], ['zz', entries], [shard, []], [shard, [{ task: entries[0].task, envelope: null }]], [shard, [null]],
    [shard, [{ task: { taskId: '' }, envelope: {} }]], [shard, [{ task: { taskId: 5 } }]]]) {
    file.call('encodeManagedNativeJobProofShard', [name, value]);
  }
  file.call('encodeManagedNativeJobProofShard', [shard, [entries[0], { task: { taskId: 5 }, envelope: {} }]], { refuse: true });
  file.call('encodeManagedNativeJobProofShard', [shard, 'entries'], { refuse: true });
  return file;
}

/** Every vector file's text, by file name. */
export async function renderVectors() {
  const { file: codecFile, saves } = await codecVectors();
  const files = [retryVectors(), primitiveVectors(), recordVectors(), codecFile, persistenceVectors(saves), transitionVectors(), autoResumeVectors(), proofStoreVectors()];
  return new Map(files.map(file => [file.name, file.render()]));
}

export const VECTOR_FILES = Object.freeze(['retry.jsonl', 'primitives.jsonl', 'records.jsonl', 'codec.jsonl', 'persistence.jsonl', 'transitions.jsonl', 'auto-resume.jsonl', 'proof-store.jsonl']);

async function main() {
  const check = process.argv.includes('--check');
  const rendered = await renderVectors();
  let stale = 0;
  for (const [name, text] of rendered) {
    const target = path.join(VECTOR_DIR, name);
    if (check) {
      let current = null;
      try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
      if (current !== text) { stale += 1; console.error(`${name} is not what the JavaScript gives; regenerate with: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`); }
    } else {
      writeFileSync(target, text);
      console.log(`${name}: ${text.split('\n').length - 1} rows, ${Buffer.byteLength(text)} bytes`);
    }
  }
  if (stale) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
