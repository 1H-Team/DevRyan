import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../packages/harness-runtime/lib/atomic-file.js';
import { readQaPinnedFile, assertQaPrivateDirectory } from './live-setup-mirror.mjs';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';

const fail = code => Object.assign(new Error(code), { code });

export function selectQaAdvertisedClaudeDefault(catalog) {
  const modelID = catalog?.default?.anthropic;
  const providers = catalog?.all?.filter(provider => provider?.id === 'anthropic');
  const model = providers?.length === 1 && providers[0].models?.[modelID];
  if (typeof modelID !== 'string' || !model || model.capabilities?.toolcall !== true) throw fail('qa_focused_claude_default_unavailable');
  return { providerID: 'anthropic', modelID, variant: null, source: 'canonical-provider-default' };
}

// One instance spans both sequential host cells. Retests require the same
// original baseline; a new run must not silently reset the authorized budget.
export function createQaClaudeBudget({ baseline, state, retest = false, now = Date.now } = {}) {
  if (state && (state.schema !== 1 || Object.keys(state).some(key => !['schema', 'baseline', 'previous', 'stopped', 'inFlight'].includes(key))
    || typeof state.stopped !== 'boolean' || typeof state.inFlight !== 'boolean'
    || !(state.stopped && state.baseline === null && state.previous === null || state.baseline && state.previous
      && Number.isFinite(state.baseline.usedPercent) && Number.isFinite(state.baseline.resetAt)
      && Number.isFinite(state.previous.usedPercent) && Number.isFinite(state.previous.resetAt) && Number.isFinite(state.previous.observedAt)))) throw fail('qa_claude_budget_state_invalid');
  let initial = state?.baseline ?? baseline, previous = state?.previous, stopped = state?.stopped || state?.inFlight || false, inFlight = false;
  return Object.freeze({
    stop() { stopped = true; },
    snapshot() { return { schema: 1, baseline: initial ? { ...initial } : null, previous: previous ? { ...previous } : null, stopped, inFlight }; },
    sample(payload, { before = false } = {}) {
      if (stopped) throw fail('qa_claude_budget_stopped');
      if (before && inFlight) { stopped = true; throw fail('qa_claude_budget_inflight'); }
      try {
        const current = now(), window = payload?.usage?.windows?.['5h'];
        if (payload?.ok !== true || payload.configured !== true || payload.providerId !== 'claude'
          || !Number.isFinite(payload.usageUpdatedAt) || current - payload.usageUpdatedAt > 15000 || payload.usageUpdatedAt > current + 1000
          || !Number.isFinite(window?.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
          || window.windowSeconds !== 18000 || !Number.isFinite(window.resetAt) || window.resetAt <= current) throw fail('qa_claude_budget_unavailable');
        const sample = { usedPercent: window.usedPercent, resetAt: window.resetAt, observedAt: payload.usageUpdatedAt };
        initial ??= { usedPercent: sample.usedPercent, resetAt: sample.resetAt };
        if (!Number.isFinite(initial.usedPercent) || initial.usedPercent < 0 || initial.usedPercent > 100
          || initial.resetAt !== sample.resetAt || sample.usedPercent < (previous?.usedPercent ?? initial.usedPercent)
          || before && previous && sample.usedPercent !== previous.usedPercent) throw fail('qa_claude_budget_changed');
        const consumed = sample.usedPercent - initial.usedPercent;
        previous = sample;
        const routineLimit = Math.min(6, Math.max(0, 96 - initial.usedPercent));
        const totalLimit = Math.min(10, Math.max(0, 100 - initial.usedPercent));
        if (consumed < 0 || consumed >= (retest ? totalLimit : routineLimit)) throw fail('qa_claude_budget_exhausted');
        inFlight = before;
        return { ...sample, baseline: { ...initial }, consumed, routineLimit, reserve: 4, totalLimit };
      } catch (error) { stopped = true; throw error; }
    },
  });
}

/** The attended source owns this file; a reused source cannot acquire a new baseline.
 * An interrupted in-flight sample refuses further traffic after restart. */
export async function openQaClaudeBudget(directory, { now = Date.now } = {}) {
  await assertQaPrivateDirectory(directory);
  const file = path.join(directory, 'claude-budget.json');
  let state;
  try { state = JSON.parse(await readQaPinnedFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const budget = createQaClaudeBudget({ state, now });
  const persist = () => writeFileAtomic(file, JSON.stringify(budget.snapshot()) + '\n', { mode: 0o600 });
  return Object.freeze({
    async sample(payload, options) {
      try { const sample = budget.sample(payload, options); await persist(); return sample; }
      catch (error) { budget.stop(); await persist(); throw error; }
    },
    async stop() { budget.stop(); await persist(); },
  });
}

export function findQaDispatchedTurn(observations, { sessionID, userMessageID, providerID, modelID }) {
  const scope = (a, b) => a.sessionID === b.sessionID && a.controllerInstanceID === b.controllerInstanceID && a.configurationDigest === b.configurationDigest && a.directory === b.directory;
  const attempt = (a, b) => a && b && a.traceID === b.traceID && a.spanID === b.spanID;
  const steps = observations.filter(row => row.stage === 'step-link' && row.sessionID === sessionID && row.userMessageID === userMessageID
    && row.execution?.providerID === providerID && row.execution.modelID === modelID);
  for (const step of steps) {
    const physical = observations.find(row => row.stage === 'physical' && row.kind === 'primary' && scope(row, step) && attempt(row.attempt, step.attempt)
      && observations.some(prepared => prepared.stage === 'model-prepared' && prepared.kind === 'primary' && scope(prepared, row)
        && prepared.requestID === row.requestID && prepared.execution?.providerID === providerID && prepared.execution.modelID === modelID));
    if (physical) return { requestID: physical.requestID, assistantMessageID: step.assistantMessageID, userMessageID, attempt: { ...step.attempt }, ordinal: physical.ordinal };
  }
  return null;
}

export function gradeQaFollowup(rows, userMessageID) {
  const assistants = rows.filter(row => row.info?.role === 'assistant' && row.info.parentID === userMessageID);
  const text = assistants.flatMap(row => (row.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '')).join('').trim();
  assert.equal(text, 'DevRyan live QA ready.', 'Follow-up did not recall the first assistant reply');
  return { userMessageID, assistantMessageIDs: assistants.map(row => row.info.id), exactRecall: true };
}

export const focusedToolPrompt = 'This is a bounded native tool acceptance check, not Task Board implementation. Successfully read src/tasks.mjs using native read, then create focused-provider-proof.txt using native write containing exactly DevRyan native tool proof followed by one newline. Do not change any other file, run commands, delegate, or use network. Finish with exactly: DevRyan tools complete.';

export async function gradeQaFocusedTools({ rows, sessionID, directory, storage, leaseForCall, readReceipt = readSessionExecutionReceipt }) {
  const tools = rows.flatMap(row => (row.parts ?? []).filter(part => part.type === 'tool').map(part => ({ row, part })));
  const read = tools.find(({ part }) => ['read', 'oc_read', 'file_read'].includes(part.tool) && part.state?.status === 'completed'
    && path.resolve(directory, part.state.input?.filePath ?? part.state.input?.file_path ?? part.state.input?.path ?? '') === path.join(directory, 'src/tasks.mjs'));
  assert.ok(read, 'Native source read is missing');
  const writes = tools.filter(({ part }) => ['write', 'oc_write'].includes(part.tool) && part.state?.status === 'completed'
    && path.resolve(directory, part.state.input?.filePath ?? part.state.input?.file_path ?? part.state.input?.path ?? '') === path.join(directory, 'focused-provider-proof.txt'));
  assert.equal(writes.length, 1, 'Require one completed native proof write');
  const { row, part } = writes[0];
  assert.equal(row.info.sessionID, sessionID);
  // The attended owner imports budget helpers before runtime paths are bound.
  const readLease = leaseForCall ?? (await import('./native-backend-ui-diagnostic.mjs')).readRuntimeUiLease;
  const lease = await readLease({ storage, directory, sessionID, callID: part.callID });
  assert.equal(lease.state, 'published');
  assert.equal(lease.executionKind, 'process');
  assert.equal(lease.directory, directory);
  assert.equal(lease.scope.sessionID, sessionID);
  assert.equal(lease.scope.callID, part.callID);
  assert.equal(lease.scope.messageID, row.info.id);
  assert.ok(lease.result?.operationID);
  const receipt = await readReceipt(lease);
  assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true);
  assert.equal(receipt.cancelled, false); assert.equal(receipt.exitCode, 0);
  assert.equal(await readFile(path.join(directory, 'focused-provider-proof.txt'), 'utf8'), 'DevRyan native tool proof\n');
  return { readCallID: read.part.callID, writeCallID: part.callID, messageID: row.info.id, operationID: lease.result.operationID, publication: 'published', confined: true };
}
