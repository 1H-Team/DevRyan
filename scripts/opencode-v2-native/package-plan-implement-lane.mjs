import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { CdpConnection, discoverPageTarget, evaluate } from '../qa/cdp.mjs';
import { reservePort, startOwnedProcess } from '../qa/process.mjs';
import { selectQaDesktopAppearance, assertQaDesktopAppearance } from '../qa/appearance.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { createQaNativeLaunchEnvironment } from '../qa/native-profile-preparation.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { reapOrphanedManagedOpenCodeProcesses, readManagedOpenCodeRegistry } from '../../packages/web/server/lib/opencode/managed-process-registry.js';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';
import { prepareRuntimeUiProfile, readRuntimeUiLease } from '../qa/native-backend-ui-diagnostic.mjs';
import { waitFor } from './process-lanes.mjs';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { captureQaSourceIdentity } from '../qa/artifact-evidence.mjs';
import { captureNativeAcceptanceSource, repositoryRoot } from './artifacts.mjs';
import { capturePerfJournal } from '../perf/electron-run-evidence.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PLAN_LANE_TIMEOUT_MS = 480000;
// Reserve the existing browser and application owners' 30-second cleanup allowances.
const PLAN_CLEANUP_RESERVE_MS = 60000;
export async function captureApplicationPlanJournal({ journalDirectory, root, deadline,
  captureJournal = capturePerfJournal, writeEvidence = fs.writeFile }) {
  const controller = new AbortController();
  let timer;
  const expire = () => {
    const remaining = deadline - performance.now();
    if (remaining > 0) { timer = setTimeout(expire, Math.max(1, Math.ceil(remaining))); return; }
    controller.abort(Object.assign(Error('Plan journal cleanup deadline exceeded'), { code: 'ABORT_ERR' }));
  };
  expire();
  let failure;
  let evidence = { schemaVersion: 1, scope: 'after-owned-host-exit-before-payload-cleanup', available: false,
    complete: false, chunks: 0, buckets: 0, records: 0, gapRecords: 0, manifestGapRecords: 0,
    errorRecords: 0, uncompressedBytesScanned: 0, gapCodes: [], errorCodes: [], captureCode: null };
  try {
    try {
      const journal = await captureJournal(journalDirectory, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const count = value => { assert.ok(Number.isSafeInteger(value) && value >= 0, 'Plan journal count invalid'); return value; };
      assert.ok(Array.isArray(journal.rows) && Array.isArray(journal.gaps), 'Plan journal inventory invalid');
      const manifestGapRecords = journal.rows.reduce((sum, row) => count(sum + count(row.gaps)), 0);
      evidence = { ...evidence, available: journal.available === true, complete: journal.complete === true,
        chunks: count(journal.chunks), buckets: count(journal.rows.length), records: count(journal.records),
        gapRecords: count(journal.gapRecords), manifestGapRecords, errorRecords: count(journal.errorRecords),
        uncompressedBytesScanned: count(journal.uncompressedBytesScanned),
        gapCodes: [...new Set(journal.gaps.map(gap => ['segment_parse_failed','native_observation_gap'].includes(gap.reason) ? gap.reason : 'journal_gap'))],
        errorCodes: journal.errorRecords ? ['error_log'] : [] };
    } catch (error) {
      failure = error;
      evidence.captureCode = ['ENOENT','EACCES','EIO','ABORT_ERR'].includes(error?.code) ? error.code : 'journal_capture_failed';
    }
    try {
      await writeEvidence(path.join(root, 'plan-journal-coverage.json'), JSON.stringify(evidence, null, 2) + '\n',
        { mode: 0o600, signal: controller.signal });
      controller.signal.throwIfAborted();
    } catch (error) {
      throw failure ? new AggregateError([failure,error], 'Plan journal capture and evidence write failed', { cause: failure }) : error;
    }
    if (failure) throw failure;
    assert.ok(evidence.available && evidence.complete && evidence.records > 0
      && evidence.gapRecords === 0 && evidence.manifestGapRecords === 0, 'Plan journal coverage must be available, complete, nonempty and gap-free');
    return evidence;
  } finally { clearTimeout(timer); }
}
export async function captureApplicationPlanIdentity({ repository = repositoryRoot,
  captureNativeSource = captureNativeAcceptanceSource, captureUiSource = captureQaSourceIdentity } = {}) {
  const manifestBytes = await fs.readFile(path.join(repository, 'packages/web/dist/.vite/manifest.json'));
  const entry = JSON.parse(manifestBytes)['index.html'];
  assert.ok(entry?.isEntry === true && typeof entry.file === 'string' && /^assets\/[a-zA-Z0-9_.-]+\.js$/.test(entry.file), 'Plan UI artifact identity invalid');
  return { nativeSource: await captureNativeSource(), uiSource: await captureUiSource(repository),
    runnerSha256: hash(await fs.readFile(path.join(repository, 'scripts/opencode-v2-native/package-plan-implement-lane.mjs'))),
    uiArtifact: { file: entry.file, sha256: hash(await fs.readFile(path.join(repository, 'packages/web/dist', entry.file))), manifestSha256: hash(manifestBytes) } };
}
export function assertApplicationPlanIdentity(before, after) {
  assert.deepEqual(after, before, 'Actual Plan qualification source, runner or UI artifact changed');
  return { valid: true, changedPaths: [] };
}
export async function finishApplicationPlanSourceVerification({ identity, root, failure, captureIdentity = captureApplicationPlanIdentity }) {
  let sourceCohort;
  try {
    const after = await captureIdentity();
    await fs.writeFile(path.join(root, 'plan-source-identity-after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
    sourceCohort = assertApplicationPlanIdentity(identity, after);
  } catch(error) {
    sourceCohort = {valid:false};
    failure = failure ? new AggregateError([failure,error], 'Plan qualification and source verification failed', {cause:failure}) : error;
  }
  try { await fs.writeFile(path.join(root, 'plan-source-cohort.json'), JSON.stringify(sourceCohort), {mode:0o600}); }
  catch(error) { failure = failure ? new AggregateError([failure,error], 'Plan qualification evidence write failed', {cause:failure}) : error; }
  return {sourceCohort,failure};
}
// Renderer requests must settle before the application starts HTTP shutdown.
// Failed captures still close the browser, but cannot acknowledge settlement.
export async function settleApplicationPlanBrowser({ approvalWork, closeBrowser, acknowledge }) {
  const settled = await Promise.allSettled(approvalWork);
  const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason);
  try { await closeBrowser(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Plan captures and browser cleanup failed', { cause: failures[0] });
  await acknowledge();
}
export async function cleanupApplicationPlanResources({ failure, operations, deadline }) {
  const failures = failure ? [failure] : [];
  const pending = [];
  for (const operation of operations) {
    let timer;
    try {
      const phaseDeadline = Math.min(deadline, performance.now() + 30000);
      const work = Promise.resolve().then(() => operation({ deadline: phaseDeadline }));
      pending.push(work);
      await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Plan cleanup deadline exceeded')),
          Math.max(0, phaseDeadline - performance.now()));
      })]);
      if (performance.now() >= deadline) throw Error('Plan cleanup deadline exceeded');
    } catch (error) { failures.push(error); } finally { clearTimeout(timer); }
  }
  let drainTimer;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise((_, reject) => {
      drainTimer = setTimeout(() => reject(Error('Plan cleanup did not physically settle before its deadline')), Math.max(0, deadline - performance.now()));
    })]);
  } catch(error) { failures.push(error); } finally { clearTimeout(drainTimer); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Plan qualification and cleanup failed', { cause: failures[0] });
}
export async function awaitApplicationPlanExit(child, closed, deadline) {
  let timer;
  try {
    return await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Object.assign(Error('Actual Plan process did not exit before its phase deadline inside the 480-second lane'), { code: 'qa_plan_deadline_exceeded' }));
      }, Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
export const PLAN_REQUEST = '[devryan-plan-implement:v1] Inspect first, then propose the saved plan.';
export const REPAIR_REQUEST = '[devryan-plan-repair:v1] Recover the partial implementation and run the required checks.';
export const PLAN_CONTENT = '# Native Plan implementation\n\n## Context\nKeep this same session and its saved plan.\n\n## Steps\n1. Fixer writes fixer.txt.\n2. Designer writes designer.txt.\n3. Run exact checks and recover the deliberate missing repair file.\n\n## Verification\nRun real shell checks, restart, then Revert and Redo the implementation.\n';
const tools = messages => new Map(messages.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row]));
const text = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const call = (id, name, input) => ({ items: [{ type: 'toolCall', index: 0, id, name, input }], reason: 'tool-calls' });
const final = value => ({ items: [{ type: 'textDelta', text: value }], reason: 'stop' });
const parse = result => { assert.equal(typeof result?.content, 'string'); return JSON.parse(result.content); };

/** Only model decisions are synthetic. These packets never execute a tool or
 * manufacture native records, permissions, completion, check or publication. */
export function createPlanImplementResponder({ continuePlan = false } = {}) {
  let prefixIssued = false;
  const split = PLAN_CONTENT.indexOf('Run real shell checks');
  const decisions = [];
  const child = (messages, role, readOnly) => {
    const results = tools(messages), prefix = `native_plan_${role}`, file = `${role}.txt`;
    if (!results.has(`${prefix}_write`)) return call(`${prefix}_write`, 'write', { path: file, content: `${role} real native publication\n` });
    if (!results.has(`${prefix}_check`)) return readOnly
      ? call(`${prefix}_check`, 'read', { path: 'plan-seed.txt' })
      : call(`${prefix}_check`, 'shell', { command: `test -s ${file}` });
    return final(`**Status:** complete\n**Changed:** ${readOnly ? 'none (read-only write refused)' : file}\n**Verification:** native shell check returned\n**Unresolved:** none\n`);
  };
  const dispatch = (messages, role, readOnly = false) => {
    const results = tools(messages), prefix = `native_plan_${role}`;
    if (!results.has(`${prefix}_start`)) return call(`${prefix}_start`, 'devryan_task', { action: 'start', agent: role === 'inspection' ? 'fixer' : role,
      prompt: `[devryan-plan-child:${role}] ${readOnly ? 'Verify read-only policy.' : `Write ${role}.txt and check it.`}`,
      ...(readOnly ? {} : { required_checks: [{ name: `${role}-exact`, command: `test -s ${role}.txt`, paths: [`${role}.txt`] }] }),
    });
    const taskID = parse(results.get(`${prefix}_start`)).task.taskId;
    if (!results.has(`${prefix}_wait`)) return call(`${prefix}_wait`, 'devryan_task', { action: 'wait', task_id: taskID });
    const waited = parse(results.get(`${prefix}_wait`));
    assert.equal(waited.task.status, 'completed', `Actual ${role} child failed: ${waited.task.failureReason ?? 'unknown'}`);
    const pages = [...results.entries()].filter(([id]) => id.startsWith(`${prefix}_page_`));
    const delivered = [waited, ...pages.map(([, result]) => parse(result))];
    const metadata = delivered.findLast(value => value.metadataReference)?.metadataReference;
    const report = delivered.findLast(value => value.resultReference)?.resultReference;
    const cursor = metadata?.complete === false ? metadata.nextCursor : report?.complete === false ? report.nextCursor : null;
    if (cursor) return call(`${prefix}_page_${pages.length}`, 'devryan_task', { action: 'read_result', task_id: taskID, result_cursor: cursor });
    if (!results.has(`${prefix}_continue`)) return call(`${prefix}_continue`, 'devryan_task', { action: 'continue', task_id: taskID });
    assert.equal(parse(results.get(`${prefix}_continue`)).resultEnvelope.action, 'continue');
    return null;
  };
  return { decisions, responder(request) {
    assert.equal(request.body.model, 'smoke-write');
    const messages = request.body.messages, user = messages.findLast(row => row.role === 'user'), userText = text(user);
    if (messages.some(row => text(row).includes('Generate a concise title for this coding session'))) {
      assert.ok(!request.body.tools?.length, 'Title helper acquired conversation tools');
      assert.equal(request.body.reasoning_effort, undefined, 'Title helper inherited conversation reasoning');
      const context = messages.map(text).join('\n');
      const role = ['inspection', 'fixer', 'designer'].find(value => context.includes(`[devryan-plan-child:${value}]`));
      assert.ok(role, 'Unrelated title source in isolated Plan lane');
      decisions.push({ requestID: request.id, phase: 'title', role });
      return final(role === 'inspection' ? 'Verify Plan Read-Only Inspection' : `Publish ${role === 'fixer' ? 'Fixer' : 'Designer'} Implementation`);
    }
    decisions.push({ requestID: request.id, phase: userText.includes(REPAIR_REQUEST) ? 'repair' : userText.includes('[devryan-plan-child:') ? 'child' : 'primary' });
    for (const role of ['inspection', 'fixer', 'designer']) {
      if (userText.includes(`[devryan-plan-child:${role}]`)) return child(messages, role, role === 'inspection');
    }
    const results = tools(messages);
    if (userText.includes(REPAIR_REQUEST)) {
      if (!results.has('native_plan_repair_write')) return call('native_plan_repair_write', 'write', { path: 'repair.txt', content: 'recovered real native publication\n' });
      if (!results.has('native_plan_repair_check')) return call('native_plan_repair_check', 'shell', { command: 'test -s fixer.txt && test -s designer.txt && test -s repair.txt' });
      return final('Native Plan implementation recovered and verified.');
    }
    if (userText.includes('[devryan-plan-action:v1]')) {
      for (const role of ['fixer', 'designer']) { const reply = dispatch(messages, role); if (reply) return reply; }
      if (!results.has('native_plan_partial_check')) return call('native_plan_partial_check', 'shell', { command: 'test -s repair.txt' });
      return final('Partial implementation retained: Fixer and Designer published; the repair check failed.');
    }
    if (continuePlan && userText.includes('The previous response was interrupted. Continue from where you left off without repeating completed content.')) {
      assert.equal(prefixIssued, true); return final(PLAN_CONTENT.slice(split));
    }
    assert.ok(userText.includes(PLAN_REQUEST), 'Unrelated provider request in isolated Plan lane');
    if (!results.has('native_plan_denied_write')) return call('native_plan_denied_write', 'write', { path: 'plan-forbidden.txt', content: 'must never publish\n' });
    if (!results.has('native_plan_denied_shell')) return call('native_plan_denied_shell', 'shell', { command: "printf 'must never publish' > plan-shell-forbidden.txt" });
    if (!results.has('native_plan_safe_read')) return call('native_plan_safe_read', 'shell', { command: 'test -r plan-seed.txt' });
    const inspected = dispatch(messages, 'inspection', true); if (inspected) return inspected;
    if (continuePlan) { assert.equal(prefixIssued, false); prefixIssued = true; return final(`<!--plan-->\n${PLAN_CONTENT.slice(0, split)}`); }
    return final(`<!--plan-->\n${PLAN_CONTENT}`);
  } };
}

/** Called inside the real application entrypoint, with its ordinary routes. */
export async function runApplicationPlanImplementation({ api, messages, directory, dataDirectory, restart, approvePlan, checkpoint = async () => {} }) {
  const query = `directory=${encodeURIComponent(directory)}`;
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await api(`/api/session?${query}`, { title: 'Native Plan to Implement qualification', agent: 'orchestrator', model });
  const sessionID = session.id;
  await checkpoint({ phase: 'session-created', sessionID });
  const planUserID = createV2MessageId();
  await api(`/api/session/${sessionID}/prompt_async?${query}`, { messageID: planUserID, agent: 'orchestrator', variant: 'high', model,
    planMode: true, parts: [{ type: 'text', text: PLAN_REQUEST }] });
  const finished = async phrase => waitFor(() => messages(sessionID), rows => rows.some(row => row.info.role === 'assistant'
    && row.info.finish === 'stop' && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text.includes(phrase))), `Native ${phrase} never completed`, 120000);
  let rows = await finished('Run real shell checks');
  await waitFor(() => api(`/api/session/status?${query}`), status => !status[sessionID] || status[sessionID].type === 'idle', 'Plan source never settled');
  const source = rows.findLast(row => row.parts.some(part => part.type === 'text' && part.text.includes('# Native Plan implementation')));
  assert.ok(source?.info.error, 'Actual interrupted Plan prefix was not retained');
  const continuedTail = rows.findLast(row => row.info.role === 'assistant');
  assert.notEqual(continuedTail.info.parentID, planUserID, 'Native continuation did not create its exact synthetic successor');
  assert.equal(continuedTail.parts.some(part => part.type === 'text' && /<!--plan-->|^#/m.test(part.text)), false, 'Continuation tail must remain heading-free');
  assert.equal(rows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_denied_write')?.state.status, 'error');
  const deniedShell = rows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_denied_shell');
  assert.ok(deniedShell?.state.status === 'error' || Number.isSafeInteger(deniedShell?.state.metadata?.exit) && deniedShell.state.metadata.exit !== 0, 'Plan shell gained write authority');
  assert.equal(rows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_safe_read')?.state.status, 'completed');
  for (const file of ['plan-forbidden.txt', 'plan-shell-forbidden.txt', 'inspection.txt']) await assert.rejects(fs.readFile(path.join(directory, file)), error => error.code === 'ENOENT');
  const current = await api(`/api/session/${sessionID}?${query}`);
  const identity = { directory, sessionCreated: current.time.created, sessionSlug: current.slug };
  const revisionRoute = `/api/session/${sessionID}/plan-revisions/${source.info.id}`;
  const saved = await api(revisionRoute, { ...identity, markdown: '# Must not replace canonical bytes' });
  assert.equal(saved.content, PLAN_CONTENT); assert.match(saved.version, /^[a-f0-9]{64}$/);
  assert.equal(saved.sourceIdentity.current, true);
  assert.equal(saved.sourceIdentity.memberUserMessageIDs.length, 2);
  assert.equal(saved.sourceIdentity.currentSourceMessageID, continuedTail.info.id);
  await checkpoint({ phase: 'continued-plan', sessionID, sourceMessageID: source.info.id, canonicalIdentity: identity, version: saved.version });
  const beforeApproval = new Set(rows.map(row => row.info.id));
  const approval = await approvePlan({ sessionID, sourceMessageID: source.info.id, version: saved.version });
  assert.equal(approval.source, 'actual-plan-card-click');
  rows = await finished('Partial implementation retained:');
  const implement = rows.find(row => row.info.role === 'user' && !beforeApproval.has(row.info.id)
    && row.parts.some(part => part.type === 'text' && part.text.startsWith('[devryan-plan-action:v1] ')));
  assert.ok(implement, 'Actual UI approval never reached canonical native admission');
  const marker = JSON.parse(implement.parts.find(part => part.type === 'text' && part.text.startsWith('[devryan-plan-action:v1] ')).text.slice('[devryan-plan-action:v1] '.length));
  assert.deepEqual({ session: marker.sourceSessionId, source: marker.sourceMessageId, index: marker.planIndex, version: marker.version },
    { session: sessionID, source: source.info.id, index: 0, version: saved.version });
  const partialCheck = rows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_partial_check');
  assert.ok(partialCheck?.state.status === 'error' || Number.isSafeInteger(partialCheck?.state.metadata?.exit) && partialCheck.state.metadata.exit !== 0, 'Deliberate failed check was silently successful');
  const partialMessageID = rows.findLast(row => row.parts.some(part => part.type === 'text' && part.text.includes('Partial implementation retained:'))).info.id;
  await checkpoint({ phase: 'partial-outcome', sessionID, messageID: partialMessageID, targetText: 'Partial implementation retained:' });
  const snapshot = await api(`/api/orchestration/snapshot?rootSessionId=${sessionID}`);
  const children = snapshot.tasks.filter(task => ['fixer', 'designer'].includes(task.agent));
  assert.equal(children.length, 3);
  const inspection = children.find(task => task.dispatchCallId === 'native_plan_inspection_start');
  assert.ok(inspection?.childSessionId);
  const inspectionRows = await messages(inspection.childSessionId);
  assert.equal(inspectionRows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_inspection_write')?.state.status, 'error', 'Managed Plan child gained write authority');
  for (const role of ['fixer', 'designer']) {
    const task = children.find(task => task.dispatchCallId === `native_plan_${role}_start`);
    assert.ok(task?.childSessionId); assert.equal(task.status, 'completed');
    const childRows = await messages(task.childSessionId);
    const check = childRows.flatMap(row => row.parts).find(part => part.callID === `native_plan_${role}_check`);
    assert.equal(check?.state.status, 'completed'); assert.equal(check.state.metadata?.exit, 0);
    assert.equal(check.state.input.command, `test -s ${role}.txt`);
    const writeRow = childRows.find(row => row.parts.some(part => part.callID === `native_plan_${role}_write`));
    assert.equal(writeRow?.parts.find(part => part.callID === `native_plan_${role}_write`)?.state.status, 'completed');
    const lease = await readRuntimeUiLease({ storage: path.join(dataDirectory, 'harness/session-mutations'), directory,
      sessionID: task.childSessionId, callID: `native_plan_${role}_write` });
    assert.equal(lease.state, 'published'); assert.equal(lease.scope.messageID, writeRow.info.id);
    const receipt = await readSessionExecutionReceipt(lease);
    assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true); assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.cancelled, false);
    assert.equal(await fs.readFile(path.join(directory, `${role}.txt`), 'utf8'), `${role} real native publication\n`);
  }
  const historyBeforeRestart = rows.map(row => row.info.id);
  await restart();
  assert.deepEqual((await messages(sessionID)).map(row => row.info.id), historyBeforeRestart, 'Restart replayed or lost canonical Plan history');
  const readQuery = new URLSearchParams({ ...identity, sessionCreated: String(identity.sessionCreated) });
  const restoredPlan = await api(`${revisionRoute}?${readQuery}`);
  assert.equal(restoredPlan.content, PLAN_CONTENT); assert.equal(restoredPlan.version, saved.version);
  await checkpoint({ phase: 'restart-restored', sessionID, messageID: partialMessageID, targetText: 'Partial implementation retained:' });
  const recoveryID = createV2MessageId();
  await api(`/api/session/${sessionID}/prompt_async?${query}`, { messageID: recoveryID, agent: 'orchestrator', variant: 'high', model,
    parts: [{ type: 'text', text: REPAIR_REQUEST }] });
  rows = await finished('Native Plan implementation recovered and verified.');
  assert.equal(rows.flatMap(row => row.parts).find(part => part.callID === 'native_plan_repair_check')?.state.status, 'completed');
  await waitFor(() => api(`/api/session/status?${query}`), status => !status[sessionID] || status[sessionID].type === 'idle', 'Recovered implementation never settled');
  const recoveryMessageID = rows.findLast(row => row.parts.some(part => part.type === 'text' && part.text.includes('Native Plan implementation recovered and verified.'))).info.id;
  await checkpoint({ phase: 'recovered-outcome', sessionID, messageID: recoveryMessageID, targetText: 'Native Plan implementation recovered and verified.' });
  const sessionIDs = [sessionID, ...children.map(task => task.childSessionId)];
  const histories = new Map(await Promise.all(sessionIDs.map(async id => [id, (await messages(id)).map(row => row.info.id)])));
  await checkpoint({ phase: 'file-undo', sessionID, fileAction: 'undo', targetSelector: '[data-session-changes-action="redo"]' });
  for (const file of ['fixer.txt', 'designer.txt', 'repair.txt']) await assert.rejects(fs.readFile(path.join(directory, file)), error => error.code === 'ENOENT');
  for (const id of sessionIDs) assert.deepEqual((await messages(id)).map(row => row.info.id), histories.get(id), 'File Undo changed canonical conversation identity');
  await checkpoint({ phase: 'file-redo', sessionID, fileAction: 'redo', targetSelector: '[data-session-changes-action="undo"]' });
  for (const role of ['fixer', 'designer']) assert.equal(await fs.readFile(path.join(directory, `${role}.txt`), 'utf8'), `${role} real native publication\n`);
  assert.equal(await fs.readFile(path.join(directory, 'repair.txt'), 'utf8'), 'recovered real native publication\n');
  for (const id of sessionIDs) assert.deepEqual((await messages(id)).map(row => row.info.id), histories.get(id), 'File Redo changed canonical conversation identity');
  const reverted = await api(`/api/devryan/session/${sessionID}/scoped-revert?${query}`, { messageID: implement.info.id, scope: 'tree' });
  assert.equal(reverted.verification?.ok, true); assert.equal(reverted.redoAvailable, true);
  for (const file of ['fixer.txt', 'designer.txt', 'repair.txt']) await assert.rejects(fs.readFile(path.join(directory, file)), error => error.code === 'ENOENT');
  await checkpoint({ phase: 'reverted', sessionID, messageID: continuedTail.info.id,
    targetText: 'Run real shell checks', hiddenMessageIDs: [implement.info.id, recoveryMessageID] });
  const redone = await api(`/api/devryan/session/${sessionID}/scoped-unrevert?${query}`, {});
  assert.equal(redone.verification?.ok, true);
  for (const role of ['fixer', 'designer']) assert.equal(await fs.readFile(path.join(directory, `${role}.txt`), 'utf8'), `${role} real native publication\n`);
  assert.equal(await fs.readFile(path.join(directory, 'repair.txt'), 'utf8'), 'recovered real native publication\n');
  for (const id of sessionIDs) assert.deepEqual((await messages(id)).map(row => row.info.id), histories.get(id), 'Redo changed canonical conversation identity');
  await checkpoint({ phase: 'redone', sessionID, messageID: recoveryMessageID,
    targetText: 'Native Plan implementation recovered and verified.' });
  await checkpoint({ phase: 'helper-settings', sessionID });
  return { status: 'passed', sessionID, planUserID, sourceMessageID: source.info.id, version: saved.version,
    implementUserID: implement.info.id, recoveryID, approval, taskIDs: children.map(task => task.taskId),
    restart: 'exact-history-and-saved-version-restored', partialRecovery: 'failed-shell-check-retained-then-real-writer-and-check',
    fileUndoRedo: 'actual-card-clicks-exact-files-and-unchanged-conversation-identities',
    revertTransactionID: reverted.verification.transactionID, redoTransactionID: redone.verification.transactionID,
    source: 'actual-application-native-prompts-tools-publications-plan-card-click-restart-and-revert-redo' };
}

export async function restoreApplicationPlanFiles(ui, action) {
  assert.ok(['undo', 'redo'].includes(action));
  const selector = `[data-session-changes-action="${action}"]`;
  await ui.reveal(selector, undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'down', fullyVisible: true });
  await ui.waitExpression('authoritative file restoration is enabled', `Boolean(document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled)`);
  await ui.click({ selector });
  if (action === 'undo') {
    // Undo opens the product's confirmation dialog; only its scoped, enabled
    // confirmation dispatches the restoration owner. Redo dispatches directly.
    const labelledBy = await ui.waitExpression('exact file Undo confirmation is enabled', `(() => {
      const dialogs=Array.from(document.querySelectorAll('[role="dialog"]')).filter(e=>{
        const r=e.getBoundingClientRect();return r.width>0&&r.height>0;
      });
      if(dialogs.length!==1)return false;
      const dialog=dialogs[0],label=dialog.getAttribute('aria-labelledby');
      if(!label||label.split(/\\s+/).map(id=>document.getElementById(id)?.textContent?.trim()??'').join(' ')!=='Undo this session’s changes?')return false;
      const buttons=Array.from(dialog.querySelectorAll('button')).filter(e=>e.innerText.trim()==='Undo');
      return buttons.length===1&&!buttons[0].disabled?label:false;
    })()`);
    assert.ok(typeof labelledBy === 'string' && labelledBy.length > 0);
    const dialog = `[role="dialog"][aria-labelledby=${JSON.stringify(labelledBy)}]`;
    await ui.click({ selector: `${dialog} button`, text: 'Undo' });
    await ui.waitExpression('file Undo confirmation is closed', `!document.querySelector(${JSON.stringify(dialog)})`);
  }
  await ui.waitExpression('file restoration settled in the real card', `Boolean(document.querySelector(${JSON.stringify(`[data-session-changes-card="${action === 'undo' ? 'undone' : 'changes'}"] [data-session-changes-action="${action === 'undo' ? 'redo' : 'undo'}"]:not(:disabled)`)}))`);
}

export function createApplicationPlanChangesEvidence({ origin, sessionID, directory, now = () => performance.now() }) {
  const started = now(), pending = new Map(), records = []; let dropped = 0;
  const append = value => { if (records.length < 256) records.push(value); else dropped++; };
  return {
    request({ requestId, request }) {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) return;
      let url; try { url = new URL(request?.url); } catch { return; }
      const base = `/api/devryan/session/${encodeURIComponent(sessionID)}/changes`;
      const kind = url.pathname === base ? 'summary' : ['undo', 'redo', 'diff'].find(value => url.pathname === `${base}/${value}`);
      if (url.origin !== origin || !kind || request.method !== (['undo', 'redo'].includes(kind) ? 'POST' : 'GET')) return;
      if (pending.size >= 128) { dropped++; return; }
      const row = { requestID: requestId, pathKind: kind, sessionID, directoryMatches: url.searchParams.get('directory') === directory,
        startedMs: Math.max(0, now() - started) };
      pending.set(requestId, row); append({ ...row, phase: 'request' });
    },
    response({ requestId, response }) {
      const row = pending.get(requestId); if (!row) return;
      if (Number.isSafeInteger(response?.status) && response.status >= 100 && response.status <= 599)
        append({ ...row, phase: 'response', status: response.status, elapsedMs: Math.max(0, now() - started - row.startedMs) });
    },
    failed({ requestId }) {
      const row = pending.get(requestId); if (!row) return;
      append({ ...row, phase: 'failed', elapsedMs: Math.max(0, now() - started - row.startedMs) }); pending.delete(requestId);
    },
    finished({ requestId }) { pending.delete(requestId); },
    snapshot: () => ({ records: records.map(row => ({ ...row })), dropped, pending: pending.size }),
  };
}

export function applicationPlanHelperLabel(catalog, selection) {
  assert.ok(Array.isArray(catalog?.providers));
  const providers = catalog.providers.filter(row => row.id === selection.providerID);
  assert.equal(providers.length, 1);
  const model = providers[0].models?.[selection.modelID];
  assert.ok(model && typeof model === 'object');
  return typeof model.name === 'string' && model.name.length > 0 ? model.name : selection.modelID;
}

const helperTrigger = '[data-helper-model-settings] [data-slot="dropdown-menu-trigger"],[data-helper-model-settings] button:has(> div):has(> svg)';
export function applicationPlanControlReady(label, selector = 'button', exactText = false) {
  return `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e=>{
    if(${exactText ? 'e.innerText.trim()' : "e.getAttribute('aria-label')"}!==${JSON.stringify(label)}||e.disabled||e.getAttribute('aria-disabled')==='true')return false;
    for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<=0||s.pointerEvents==='none')return false;}
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    if(r.width<=0||r.height<=0||x<0||x>=innerWidth||y<0||y>=innerHeight)return false;
    const hit=document.elementFromPoint(x,y);return Boolean(hit&&e.contains(hit));
  }))()`;
}
export async function ensureApplicationPlanSidebar(ui) {
  const settings = applicationPlanControlReady('Settings'), sessions = applicationPlanControlReady('Open Sessions');
  const state = await ui.waitExpression('actual responsive sidebar control is ready', `${settings}?'settings':${sessions}?'sessions':false`);
  if (state === 'sessions') {
    await ui.click({ label: 'Open Sessions' });
    await ui.waitExpression('opened sidebar Settings control is hit-ready', settings);
  }
}
export async function openApplicationPlanSessionDefaults(ui) {
  const agents = applicationPlanControlReady('Agents', '[data-settings-view] button', true);
  const settings = applicationPlanControlReady('Settings'), sessions = applicationPlanControlReady('Open Sessions');
  const state = await ui.waitExpression('fresh responsive settings navigation is ready', `${agents}?'settings-view':${settings}?'settings':${sessions}?'sessions':false`);
  if (state !== 'settings-view') {
    await ensureApplicationPlanSidebar(ui);
    await ui.click({ label: 'Settings' });
    await ui.waitExpression('actual settings Agents navigation is ready', agents);
  }
  await ui.click({ selector: '[data-settings-view] button', text: 'Agents' });
  await ui.click({ selector: '[data-settings-view] button', text: 'Session Defaults', exact: false });
}
export async function reloadApplicationPlanDocument(cdp, { deadline, signal }) {
  signal?.throwIfAborted();
  const remaining = Math.min(30000, deadline - performance.now());
  assert.ok(remaining > 0, 'Actual Plan reload exhausted its existing deadline');
  const loaded = cdp.waitFor('Page.loadEventFired', remaining);
  void loaded.catch(() => {});
  await cdp.send('Page.reload', {}, { timeoutMs: remaining });
  await loaded;
  signal?.throwIfAborted();
}
export async function waitApplicationPlanHelperMenuClosed(ui, menuID) {
  return ui.waitExpression('exact helper menu has closed and finished painting', `(async()=>{
    const closed=()=>{
      const trigger=document.querySelector('[data-helper-model-settings] [data-slot="dropdown-menu-trigger"]');
      if(!trigger||trigger.getAttribute('aria-expanded')!=='false')return false;
      const menu=document.getElementById(${JSON.stringify(menuID)});if(!menu)return true;
      if(menu.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.pending))return false;
      const s=getComputedStyle(menu),r=menu.getBoundingClientRect();
      return s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||r.width<=0||r.height<=0;
    };
    if(!closed())return false;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return closed();
  })()`);
}
export async function waitApplicationPlanHelperTrigger(ui, label) {
  await ui.reveal(helperTrigger, undefined, { direction: 'down', fullyVisible: true });
  return ui.waitExpression('exact hydrated helper control is enabled', `(() => {
    const controls=Array.from(document.querySelectorAll(${JSON.stringify(helperTrigger)})).filter(e=>e.getClientRects().length>0);
    if(controls.length!==1)return false;const e=controls[0],s=getComputedStyle(e);
    return !e.disabled&&e.getAttribute('aria-disabled')!=='true'&&s.pointerEvents!=='none'&&Number(s.opacity)>=0.99
      &&e.innerText.trim()===${JSON.stringify(label)};
  })()`);
}

export async function selectApplicationPlanCurrentHelper(ui, label) {
  await waitApplicationPlanHelperTrigger(ui, label);
  await ui.click({ selector: helperTrigger });
  const menuLabel = label.length > 40 ? label.slice(0, 37) + '...' : label;
  const menuID = await ui.waitExpression('exact helper menu owns the selected model row', `(() => {
    const trigger=document.querySelector('[data-helper-model-settings] [data-slot="dropdown-menu-trigger"]');
    const id=trigger?.getAttribute('aria-controls'),menu=id&&document.getElementById(id);if(!menu||menu.getAttribute('role')!=='menu')return false;
    const selected=Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(e=>e.querySelector(':scope > div:last-child > svg.text-primary')
      &&e.querySelector('span.font-medium')?.textContent.trim()===${JSON.stringify(menuLabel)}&&e.getAttribute('aria-disabled')!=='true');
    return selected.length===1?id:false;
  })()`);
  assert.ok(typeof menuID === 'string' && menuID.length > 0);
  await ui.click({ selector: `[role="menu"][id=${JSON.stringify(menuID)}] [role="menuitem"]:has(> div:last-child > svg.text-primary)`, text: menuLabel, exact: false });
  await waitApplicationPlanHelperMenuClosed(ui, menuID);
}

export async function waitApplicationPlanCapture(ui, phase, selector) {
  const cardMode = phase === 'file-undo' ? 'undone' : ['file-redo', 'restart-restored', 'partial-outcome', 'recovered-outcome'].includes(phase) ? 'changes' : null;
  const requireEnabled = phase !== 'partial-outcome';
  if (!cardMode && phase !== 'continued-plan') return null;
  const target = cardMode ? `[data-session-changes-card="${cardMode}"] [data-session-changes-action="${cardMode === 'undone' ? 'redo' : 'undo'}"]` : selector;
  return ui.waitExpression('positive capture has settled enabled authority and paint', `(async()=>{
    const read=()=>{
      const e=document.querySelector(${JSON.stringify(target)});if(!e)return false;
      const card=e.closest('[data-session-changes-card]'),status=card?.querySelector(':scope > p')?.innerText??'';
      if(status.includes('Session changes could not be loaded'))throw Error('qa_plan_session_changes_load_failed');
      if(status.includes('Loading session changes'))return false;
      const enabled=!e.disabled&&e.getAttribute('aria-disabled')!=='true';
      if(${requireEnabled}&&!enabled)return false;
      if(${JSON.stringify(phase)}==='continued-plan'&&!e.closest('[data-plan-state="actionable"]'))return false;
      const s=getComputedStyle(e);if(${requireEnabled}&&(s.pointerEvents==='none'||Number(s.opacity)<0.99)||e.getAnimations().some(a=>a.playState==='running'||a.pending))return false;
      return {enabled,mode:${JSON.stringify(cardMode ?? 'actionable')},status:'settled',opacity:Number(s.opacity),paintStable:true};
    };
    if(!read())return false;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return read();
  })()`);
}

export async function openOwnedPlan({ origin, owner, sessionID, root, environment, showBrowser, deadline, workDeadline = deadline, identity,
  signal, onAcquired = () => {}, startBrowser = startOwnedProcess, discoverTarget = discoverPageTarget, connectCdp = url => CdpConnection.connect(url) }) {
  signal?.throwIfAborted();
  const port = await reservePort(), profile = path.join(root, 'chromium'), require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
  signal?.throwIfAborted();
  const browserEnvironment = createQaHostLaunchEnvironment(environment, { DEVRYAN_QA_ORIGIN: origin, DEVRYAN_QA_BACKGROUND: showBrowser ? '0' : '1' });
  delete browserEnvironment.NODE_OPTIONS; delete browserEnvironment.ELECTRON_RUN_AS_NODE;
  const browser = startBrowser(require('electron'), [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    fileURLToPath(new URL('../qa/browser-shell.cjs', import.meta.url))], { env: browserEnvironment });
  let cdp, ui, helperSave;
  const screenshots = [], visualChecks = [], planIdentityRequests = [], helperRequests = [], loadedUiDigests = []; let serial = Promise.resolve();
  const changesEvidence = createApplicationPlanChangesEvidence({ origin, sessionID, directory: path.join(root, 'workspace') });
  let closeWork;
  const close = ({ deadline: phaseDeadline = Math.min(deadline, performance.now() + 30000) } = {}) => closeWork ??= (async () => {
    try { await Promise.all([
      fs.writeFile(path.join(root, 'plan-identity-requests.json'), JSON.stringify(planIdentityRequests, null, 2), { mode: 0o600 }),
      fs.writeFile(path.join(root, 'session-changes-network.json'), JSON.stringify(changesEvidence.snapshot(), null, 2), { mode: 0o600 }),
    ]); }
    finally {
      try { cdp?.close(); }
      finally { await browser.stop({ deadline: phaseDeadline }); await fs.rm(profile, { recursive: true, force: true }); }
    }
  })();
  try {
    onAcquired(close);
    signal?.throwIfAborted();
    const target = await discoverTarget(port, Math.max(1,Math.min(45000,workDeadline-performance.now())));
    signal?.throwIfAborted();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    signal?.throwIfAborted();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Network.enable', { maxPostDataSize: 4096 });
    cdp.on('Network.requestWillBeSent', input => changesEvidence.request(input));
    cdp.on('Network.responseReceived', input => changesEvidence.response(input));
    cdp.on('Network.loadingFailed', input => changesEvidence.failed(input));
    cdp.on('Network.loadingFinished', input => changesEvidence.finished(input));
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (request.method === 'PUT' && request.url === `${origin}/api/config/settings`) {
        try { const selection = JSON.parse(request.postData)?.helperModelSelection;
          if (selection) helperRequests.push({ providerID: selection.providerID, modelID: selection.modelID, revision: selection.revision });
        } catch { /* No raw settings are retained. */ }
      }
      if (request.method !== 'POST' || !request.url.startsWith(`${origin}/api/session/`) || !request.url.includes('/plan-revisions/')) return;
      try {
        const body = JSON.parse(request.postData);
        planIdentityRequests.push({ path: new URL(request.url).pathname, directory: body.directory,
          sessionCreated: body.sessionCreated, sessionSlug: body.sessionSlug });
      } catch { /* No request body is recorded when the metadata is unavailable. */ }
    });
    await cdp.send('Network.setCookie', { name: owner.name, value: owner.value, url: origin, httpOnly: true, sameSite: 'Strict' });
    await cdp.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(sessionID)}` });
    ui = createQaUiDriver(cdp, { timeoutMs: 60000, navigationReads: true, deadline: workDeadline, signal,
      checkAlive: () => { signal?.throwIfAborted(); browser.check(); } });
    const selectSession = async () => {
      const selector = `[data-session-row=${JSON.stringify(sessionID)}] [data-session-select]`;
      // The initial bootstrap can finish after a row first becomes visible.
      // Reconcile through the real sidebar action until selected chat renders.
      await ui.waitFor('actual selected session chat', async () => {
        const selected = await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)})?.querySelector('.typography-ui-label.text-primary'))`);
        if (selected) return true;
        await ui.click({ selector });
        return false;
      });
    };
    // Native empty sessions can be absent from the first sidebar snapshot.
    // Connect the real UI before prompting, then select its row once the
    // transcript exists at the first visual/approval checkpoint.
    await ui.waitExpression('owned application composer ready', `Boolean(document.querySelector('textarea'))`);
    const verifyLoadedUi = async () => {
      const loaded = await evaluate(cdp, `(async()=>{const script=[...document.scripts].find(s=>new URL(s.src,location.href).pathname===${JSON.stringify('/' + identity.uiArtifact.file)});if(!script)return null;
        const response=await fetch(script.src,{cache:'no-store'});if(!response.ok)return null;const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
        return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');})()`);
      assert.equal(loaded, identity.uiArtifact.sha256, 'Actual Plan UI served a different artifact');
      loadedUiDigests.push(loaded);
    };
    await verifyLoadedUi();
    const controlVisible = label => evaluate(cdp, applicationPlanControlReady(label));
    const qualifyHttpHelperSave = async () => {
      const previous = await evaluate(cdp, `fetch('/api/config/settings',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('settings read failed');return r.json()}).then(s=>s.helperModelSelection)`);
      assert.equal(previous.providerID, 'devryan-smoke'); assert.equal(previous.modelID, 'smoke-write');
      const catalog = await evaluate(cdp, `fetch('/api/config/providers',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('catalog read failed');return r.json()}).then(value=>({providers:value.providers.filter(p=>p.id===${JSON.stringify(previous.providerID)}).map(p=>({id:p.id,models:{[${JSON.stringify(previous.modelID)}]:p.models?.[${JSON.stringify(previous.modelID)}]?{name:p.models[${JSON.stringify(previous.modelID)}].name}:null}}))}))`);
      const label = applicationPlanHelperLabel(catalog, previous);
      await waitApplicationPlanHelperTrigger(ui, label);
      await evaluate(cdp, `(()=>{globalThis.__qaUuidDescriptor=Object.getOwnPropertyDescriptor(crypto,'randomUUID');Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});return typeof crypto.randomUUID})()`);
      try {
        await selectApplicationPlanCurrentHelper(ui, label);
        let saved;
        await ui.waitFor('HTTP helper selection is durably acknowledged without randomUUID', async () => {
          saved = await evaluate(cdp, `fetch('/api/config/settings',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('settings read failed');return r.json()}).then(s=>s.helperModelSelection)`);
          return saved?.revision !== previous.revision;
        });
        assert.deepEqual({ providerID: saved.providerID, modelID: saved.modelID }, { providerID: previous.providerID, modelID: previous.modelID });
        assert.equal(typeof saved.revision, 'string'); assert.ok(saved.revision.length > 0);
        assert.deepEqual(helperRequests, [saved]);
        await waitApplicationPlanHelperTrigger(ui, label);
        helperSave = { http: true, randomUUIDAbsent: true, acknowledged: true, controlsRestored: true,
          providerID: saved.providerID, modelID: saved.modelID, revision: saved.revision, displayLabel: label };
      } finally {
        await evaluate(cdp, `(()=>{const d=globalThis.__qaUuidDescriptor;if(d)Object.defineProperty(crypto,'randomUUID',d);else delete crypto.randomUUID;delete globalThis.__qaUuidDescriptor})()`);
      }
    };
    const capture = (phase, sourceMessageID, target = {}) => {
      assert.match(phase, /^[a-z0-9-]+$/);
      const work = serial.then(async () => {
        // Scoped conversation restoration has a different owner from the file-only Undo/Redo card.
        if (phase === 'reverted' || phase === 'redone') {
          await cdp.send('Page.reload');
          await ui.waitExpression('restored canonical chat composer ready', `Boolean(document.querySelector('textarea'))`);
        }
        for (const theme of ['light', 'dark']) {
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
          await ui.waitExpression('desktop layout', `document.documentElement.classList.contains('device-desktop')`);
          if (phase === 'helper-settings') {
            if (await evaluate(cdp, `Boolean(document.querySelector('[data-settings-view]'))`)) {
              await ui.click({ selector: '[data-settings-view] button', label: 'Back' });
            }
          }
          await ensureApplicationPlanSidebar(ui);
          await selectSession();
          await selectQaDesktopAppearance({ cdp, ui, theme });
          if (phase === 'helper-settings') {
            // Stay in the live appearance context: hard navigation can reload
            // before its asynchronous preference save acknowledges the toggle.
            await openApplicationPlanSessionDefaults(ui);
            await ui.waitVisibleText('Helper model');
            if (!helperSave) await qualifyHttpHelperSave();
          }
          for (const [width, height] of [[1280, 800], [390, 844]]) {
            await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
            await ui.waitExpression('requested real responsive layout', `document.documentElement.classList.contains(${JSON.stringify(width === 390 ? 'device-mobile' : 'device-desktop')})`);
            if (width === 390 && await controlVisible('Close Sessions')) await ui.click({ label: 'Close Sessions', touch: true });
            if (width === 390 && phase !== 'helper-settings') {
              // The responsive Plan View mounts after the device class changes.
              // Select the actual chat tab rather than racing its close control.
              await ui.click({ selector: '[role="tab"]', label: 'Chat', touch: true });
              await ui.waitExpression('mobile chat selected', `Boolean(document.querySelector('[role="tab"][aria-label="Chat"][aria-selected="true"]'))`);
            }
            await assertQaDesktopAppearance({ cdp, theme });
            const chat = '[data-scrollbar="chat"]';
            let visibleTarget;
            const planSource = sourceMessageID ?? target.sourceMessageID;
            if (planSource || phase.includes('plan')) {
              visibleTarget = planSource ? `[data-plan-source-message-id=${JSON.stringify(planSource)}] button.oc-plan-implement-btn` : '[data-plan-source-message-id] button.oc-plan-implement-btn';
              await ui.reveal(visibleTarget, 'Implement Plan', { scrollContainer: chat, direction: 'up', allowDisabled: true, fullyVisible: true });
              if (phase === 'continued-plan') await ui.waitExpression('verified current saved Plan approval is visibly enabled', `Array.from(document.querySelectorAll(${JSON.stringify(visibleTarget)})).some(e=>!e.disabled&&e.closest('[data-plan-state="actionable"]'))`);
            } else if (target.taskID) {
              visibleTarget = `[data-managed-task-id=${JSON.stringify(target.taskID)}] h4`;
              await ui.reveal(visibleTarget, undefined, { scrollContainer: chat, direction: 'down', fullyVisible: true });
            } else if (target.messageID) {
              visibleTarget = `[data-message-id=${JSON.stringify(target.messageID)}]`;
              await ui.reveal(visibleTarget, undefined, { scrollContainer: chat, direction: 'down' });
              await ui.revealText(target.targetText, visibleTarget, { scrollContainer: chat, direction: 'down' });
              for (const hidden of target.hiddenMessageIDs ?? []) {
                assert.match(hidden, /^msg_[A-Za-z0-9]+$/);
                await ui.waitExpression('scoped reverted suffix is absent', `!document.querySelector(${JSON.stringify(`[data-message-id=${JSON.stringify(hidden)}]`)})`);
              }
            } else if (target.targetSelector) {
              visibleTarget = target.targetSelector;
              await ui.reveal(visibleTarget, undefined, { scrollContainer: chat, direction: 'down', allowDisabled: true, fullyVisible: true });
            } else if (phase === 'helper-settings') {
              await ui.revealText('Helper model', '[data-settings-view]', { direction: 'down' });
              await waitApplicationPlanHelperTrigger(ui, helperSave.displayLabel);
            }
            const captureState = await waitApplicationPlanCapture(ui, phase, visibleTarget);
            const geometry = await evaluate(cdp, `(() => {const chat=document.querySelector(${JSON.stringify(chat)}),target=${visibleTarget ? `document.querySelector(${JSON.stringify(visibleTarget)})` : 'null'};const r=target?.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,chatOverflow:chat?chat.scrollWidth>chat.clientWidth+1:false,target:r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom}:null};})()`);
            assert.equal(geometry.width, width); assert.equal(geometry.overflow, false); assert.equal(geometry.chatOverflow, false);
            if (geometry.target) assert.ok(geometry.target.left >= -1 && geometry.target.right <= width + 1, 'Target control/content escapes the real viewport');
            const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
            const name = `${phase}-${width}x${height}-${theme}.png`;
            await fs.writeFile(path.join(root, name), Buffer.from(result.data, 'base64'), { mode: 0o600 }); screenshots.push(name);
            visualChecks.push({ screenshot: name, phase, theme, width, height,
              device: width === 390 ? 'web-mobile-touch' : 'web-desktop',
              noHorizontalOverflow: !geometry.overflow && !geometry.chatOverflow, target: geometry.target, captureState });
          }
        }
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      });
      serial = work.catch(async () => {
        try {
          const diagnostic = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(root, `visual-failure-${phase}.png`), Buffer.from(diagnostic.data, 'base64'), { mode: 0o600 });
        } catch { /* Preserve the original visual failure. */ }
      });
      return work.catch(async error => { await serial; throw error; });
    };
    signal?.throwIfAborted();
    return { screenshots, visualChecks, loadedUiDigests, capture, close, get helperSave() { return helperSave; }, async restoreHelperSave() {
      assert.ok(helperSave?.acknowledged);
      await reloadApplicationPlanDocument(cdp, { deadline: workDeadline, signal });
      await verifyLoadedUi();
      const saved = await evaluate(cdp, `fetch('/api/config/settings',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('settings read failed');return r.json()}).then(s=>s.helperModelSelection)`);
      assert.deepEqual(saved, { providerID: helperSave.providerID, modelID: helperSave.modelID, revision: helperSave.revision });
      await openApplicationPlanSessionDefaults(ui);
      await waitApplicationPlanHelperTrigger(ui, helperSave.displayLabel);
      helperSave.restored = true; helperSave.uiHydrated = true;
    }, async fileChanges(action) {
      await selectSession();
      await restoreApplicationPlanFiles(ui, action);
    }, async approve({ sourceMessageID }) {
      const selector = `[data-plan-source-message-id=${JSON.stringify(sourceMessageID)}] button`;
      await ui.reveal(selector, 'Implement Plan', { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
      await ui.waitExpression('authoritative enabled Plan approval', `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e=>e.innerText.trim()==='Implement Plan'&&!e.disabled)`);
      await capture('approval-before', sourceMessageID);
      process.stderr.write(JSON.stringify({ phase: 'actual-plan-approval-review-ready', origin, sessionID, sourceMessageID, root, holdMs: 25000 }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 25000));
      await ui.click({ selector, text: 'Implement Plan' });
      await ui.waitExpression('Plan approval leaves ready state', `!Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e=>e.innerText.trim()==='Implement Plan'&&!e.disabled)`);
      await capture('approval-after', sourceMessageID);
      return { source: 'actual-plan-card-click', screenshots: [...screenshots] };
    } };
  } catch (error) {
    if (cdp) {
      try {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(root, 'navigation-failure.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      } catch { /* Preserve the navigation failure if the owned page already closed. */ }
    }
    await cleanupApplicationPlanResources({ failure: error, deadline, operations: [close] });
  }
}

/** Actual isolated application + default owned UI driver. No manual marker or
 * fixture callback can silently replace browser approval. */
export async function runPlanImplementApplicationAcceptance({ artifactRoot, root, showBrowser = true }) {
  const deadline = performance.now() + PLAN_LANE_TIMEOUT_MS;
  const workDeadline = deadline - PLAN_CLEANUP_RESERVE_MS;
  const identity = await captureApplicationPlanIdentity();
  const workspace = path.join(root, 'workspace'), runtimeRoot = path.join(root, 'profile');
  let ownedBrowser; let browserFailure; let browserReady, browserNotReady;
  let closeOpeningBrowser;
  const browserLifetime = new AbortController();
  const ready = new Promise((resolve, reject) => { browserReady = resolve; browserNotReady = reject; });
  void ready.catch(() => {});
  const approvalWork = [];
  const captured = new Set();
  const decision = createPlanImplementResponder({ continuePlan: true });
  const respond = async request => {
    browserLifetime.signal.throwIfAborted();
    const reply = decision.responder(request);
    const next = reply.items[0];
    const phase = next.type === 'toolCall' && next.name === 'devryan_task' && next.input.action === 'wait' && next.id.includes('fixer') ? 'dispatch'
      : next.type === 'toolCall' && next.name === 'devryan_task' && next.input.action === 'continue' && !next.id.includes('inspection') ? `result-${next.id.includes('fixer') ? 'fixer' : 'designer'}`
        : text(request.body.messages.findLast(row => row.role === 'user')).includes('The previous response was interrupted.') ? 'continued-plan-incomplete' : null;
    if (phase && !captured.has(phase)) {
      captured.add(phase);
      const work = (async () => {
        await ready;
        const role = phase === 'dispatch' || phase === 'result-fixer' ? 'fixer' : phase === 'result-designer' ? 'designer' : null;
        const taskID = role ? parse(tools(request.body.messages).get(`native_plan_${role}_start`)).task.taskId : undefined;
        await ownedBrowser.capture(phase, undefined, { taskID });
      })();
      approvalWork.push(work);
      try { await work; }
      catch (error) { browserFailure ??= error; browserLifetime.abort(browserFailure); browserNotReady(browserFailure); child?.kill('SIGTERM'); throw error; }
    }
    return reply;
  };
  let cut = false;
  const truncateFixtureReply = (_body, output) => {
    if (!cut && output.includes('Native Plan implementation') && !output.includes('Run real shell checks')) { cut = true; return true; }
    return false;
  };
  let prepared, binding, child, closed, timer, result, failure, journalCoverage, output = '', errors = '';
  try {
    await fs.writeFile(path.join(root, 'plan-source-identity.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
    await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(runtimeRoot, { recursive: true });
    const template = path.join(root, 'git-template'); await fs.mkdir(template);
    await exec('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', `--template=${template}`], { cwd: workspace,
      env: createQaHostLaunchEnvironment({ HOME: workspace, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: root }), timeout: 10000 });
    await fs.writeFile(path.join(workspace, 'plan-seed.txt'), 'owned read-only inspection seed\n');
    prepared = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace,
      targetGeneration: 2, artifactRoot, fixtureResponder: respond, truncateFixtureReply, packetDelayMs: 0, modelContext: 200000,
      helperModelSelection: { providerID: 'devryan-smoke', modelID: 'smoke-write', revision: 'qa-plan-implement-default' } });
    binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot });
    const environment = createQaNativeLaunchEnvironment({ binding, runtimeRoot, baseEnvironment: prepared.env });
    Object.assign(environment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: root });
    await exec('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', `--template=${template}`], { cwd: binding.descriptor.launch.global.home, env: environment, timeout: 10000 });
    assert.ok(performance.now() < workDeadline, 'Actual Plan setup exhausted its work budget');
    child = fork(fileURLToPath(new URL('./package-application-lifecycle-driver.mjs', import.meta.url)), [],
      { cwd: root, env: environment, execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let owner, outputBytes = 0;
    child.on('message', message => {
      if(browserLifetime.signal.aborted)return;
      if (message?.type === 'application-owner-session-ready') child.send({ type: 'application-owner-session', owner: null });
      else if (message?.type === 'application-owner-session') owner = message.owner;
      else if (message?.type === 'application-plan-checkpoint') {
        const pending = approvalWork.slice();
        const operation = (async () => {
          if (message.input.phase === 'browser-settlement') {
            await settleApplicationPlanBrowser({ approvalWork: pending,
              closeBrowser: () => closeOpeningBrowser?.(),
              acknowledge: () => child.send({ type: 'application-plan-checkpoint-done', phase: message.input.phase }) });
            return;
          }
          if (message.input.canonicalIdentity) await fs.writeFile(path.join(root, 'canonical-plan-identity.json'), JSON.stringify(message.input.canonicalIdentity, null, 2), { mode: 0o600 });
          if (message.input.phase === 'session-created') {
            assert.ok(owner?.name && owner.value);
            process.stderr.write(JSON.stringify({ phase: 'actual-plan-ui-ready', origin: message.input.origin, sessionID: message.input.sessionID, root }) + '\n');
            const opened = await openOwnedPlan({ ...message.input, owner, root, environment, showBrowser, deadline, workDeadline, identity,
              signal:browserLifetime.signal,onAcquired:close=>{closeOpeningBrowser=close;} });
            browserLifetime.signal.throwIfAborted();ownedBrowser=opened;browserReady();
          } else {
            await ready;
            if (message.input.fileAction) await ownedBrowser.fileChanges(message.input.fileAction);
            await ownedBrowser.capture(message.input.phase, undefined, message.input);
            if (message.input.phase === 'helper-settings') await ownedBrowser.restoreHelperSave();
          }
          child.send({ type: 'application-plan-checkpoint-done', phase: message.input.phase });
        })();
        approvalWork.push(operation); void operation.catch(error => { browserFailure ??= error; browserLifetime.abort(browserFailure); browserNotReady(browserFailure); child.kill('SIGTERM'); });
      } else if (message?.type === 'application-plan-ready') {
        const operation = (async () => { await ready; const approval = await ownedBrowser.approve(message.input);
          child.send({ type: 'application-plan-approved', approval }); })();
        approvalWork.push(operation); void operation.catch(error => { browserFailure ??= error; browserLifetime.abort(browserFailure); browserNotReady(browserFailure); child.kill('SIGTERM'); });
      }

    });
    child.stdout.on('data', bytes => { outputBytes += bytes.byteLength; if (outputBytes > 65536) child.kill('SIGTERM'); else output += bytes; });
    child.stderr.on('data', bytes => { if (Buffer.byteLength(errors) < 1024 * 1024) errors += bytes; });
    closed = new Promise((resolve, reject) => {
      child.once('error', error => { browserNotReady(error); reject(error); });
      child.once('exit', (code, signal) => {
        if (!ownedBrowser) browserNotReady(browserFailure ?? Error('Application exited before browser readiness'));
        resolve({ code, signal });
      });
    });
    // Normal work/natural exit leaves the two original owner cleanup allowances
    // inside the same absolute 480-second lane; native waits keep their own bounds.
    timer = setTimeout(() => {
      const error = Error('Actual Plan work exhausted its budget inside the 480-second lane');
      browserFailure ??= error; browserLifetime.abort(browserFailure); browserNotReady(browserFailure); child.kill('SIGTERM');
      // Closing the timed-out transport releases queued captures before cleanup.
      void closeOpeningBrowser?.().catch(() => {});
    }, Math.max(0, workDeadline - performance.now()));
    child.stdin.end(JSON.stringify({ mode: 'plan-implement', directory: workspace }));
    const exit = await awaitApplicationPlanExit(child, closed, workDeadline);
    const settled = await Promise.allSettled(approvalWork);
    if (browserFailure) throw browserFailure;
    const rejected = settled.find(value => value.status === 'rejected'); if (rejected) throw rejected.reason;
    await fs.writeFile(path.join(root, 'application-plan-result.json'), output, { mode: 0o600 });
    result = JSON.parse(output);
    assert.equal(exit.code, 0, `Actual application Plan lane failed: ${result.error?.message ?? result.error?.code ?? 'unknown'}`); assert.equal(exit.signal, null);
    assert.equal(result.status, 'passed');
  } catch (error) { failure = browserFailure ?? error; }
  browserLifetime.abort(failure ?? Error('Plan fixture cleanup started'));
  browserNotReady(browserLifetime.signal.reason);
  try {
    const registryPath = binding && path.join(binding.descriptor.launch.global.state, 'managed-opencode-processes.json');
    await cleanupApplicationPlanResources({ failure, deadline, operations: [
      async ({ deadline: phaseDeadline }) => { if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(performance.now() >= workDeadline ? 'SIGKILL' : 'SIGTERM');
        await awaitApplicationPlanExit(child, closed, phaseDeadline);
      } },
      async ({ deadline: phaseDeadline }) => { journalCoverage = await captureApplicationPlanJournal({ root, deadline: phaseDeadline,
        journalDirectory: binding && path.join(binding.descriptor.launch.webDataDirectory, 'harness/journal'),
        captureJournal: (directory, options) => {
          assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'Plan journal requires the owned host to exit');
          return capturePerfJournal(directory, options);
        } }); },
      () => fs.writeFile(path.join(root, 'application-plan.log'), errors, { mode: 0o600 }),
      phase => closeOpeningBrowser?.(phase),
      () => Promise.allSettled(approvalWork),
      () => prepared?.close(),
      async () => { if(!registryPath)return;const reaped = await reapOrphanedManagedOpenCodeProcesses({ registryPath });
        assert.deepEqual(reaped.kept, []); assert.deepEqual(readManagedOpenCodeRegistry({ registryPath }), []); },
    ] });
  } catch(error) { failure = error; } finally { clearTimeout(timer); }
  const verified = await finishApplicationPlanSourceVerification({identity,root,failure});
  const sourceCohort = verified.sourceCohort; failure = verified.failure;
  if(failure)throw failure;
  assert.ok(performance.now() < deadline, 'Actual Plan qualification exhausted its absolute 480-second deadline');
  assert.equal(ownedBrowser.loadedUiDigests.length, 2, 'Actual Plan requires initial and reopened UI artifact proof');
  assert.deepEqual(ownedBrowser.loadedUiDigests, [identity.uiArtifact.sha256,identity.uiArtifact.sha256]);
  // Qualification is published only after every owned runtime/browser settles.
  await fs.writeFile(path.join(root, 'plan-implement-result.json'), JSON.stringify({ ...result, sourceCohort,
    journalCoverage,
    sourceIdentity: { nativeDigest: identity.nativeSource.sourceDigest, uiSha256: identity.uiSource.sha256, runnerSha256: identity.runnerSha256, uiArtifact: identity.uiArtifact },
    providerRequests: prepared.evidence.providerRequests,
    decisions: decision.decisions, visual: { screenshots: ownedBrowser?.screenshots ?? [], checks: ownedBrowser?.visualChecks ?? [], loadedUiDigests: ownedBrowser.loadedUiDigests,
      helperSave: ownedBrowser?.helperSave, matrix: 'actual-theme-controls-web-desktop-and-390x844-touch' } }, null, 2), { mode: 0o600 });
  assert.ok(performance.now() < deadline, 'Actual Plan evidence publication exhausted its absolute 480-second deadline');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'artifact-root': { type: 'string' }, background: { type: 'boolean', default: false } } });
  assert.ok(values['artifact-root'], 'Explicit current owned artifact root required');
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'native-plan-implement-', owner: 'actual-native-plan-implement', extraPayloads: ['workspace'] });
  try {
    const result = await runPlanImplementApplicationAcceptance({ artifactRoot: path.resolve(values['artifact-root']), root: run.dir, showBrowser: !values.background });
    run.finish('passed'); process.stdout.write(JSON.stringify({ status: result.status, root: run.dir, sessionID: result.sessionID }) + '\n');
  } catch (error) { run.finish('failed'); throw error; }
}
