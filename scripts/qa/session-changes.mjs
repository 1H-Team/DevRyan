import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createSessionChangeHost } from '../../packages/harness-runtime/lib/session-changes-host.js';
import { normalizeInteractionUpdateToSdkMessage } from '../../packages/cursor-sdk-runtime/interaction-update-normalize.js';
import { mergeCursorNativeTaskActivity } from '../../packages/cursor-sdk-runtime/cursor-native-task.js';
import { PERF_PARENT_SESSION_ID, PERF_CHILD_SESSION_IDS } from '../perf/fixture-session-seeds.mjs';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { installQaChangeProof } from './fixture-session-change-proof.mjs';

// Seed the production private store, then deliver explicitly delayed evidence
// through a separate host under its cross-process lock during isolated QA.
export async function prepareSessionChangesQa({ fixture, directory, dataDirectory }) {
  const openCodeClient = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }), getAuthHeaders: () => fixture.authHeaders });
  const create = title => openCodeClient.sessions.create({ title }, { directory });
  const unrelated = await create('Independent writer');
  const restorable = await create('Restore verification');
  const partial = await create('Capture limitation');
  const recovery = await create('Late receipt recovery');
  const native = await create('Native task reconciliation');
  let publishEvent = () => {};
  const host = createSessionChangeHost({ dataDirectory, openCodeClient,
    publishEvent: (payload, { directory: eventDirectory }) => publishEvent(payload, eventDirectory),
    restoreOwned: async () => { throw Object.assign(new Error('fixture has no native ownership'), { code: 'mutation_history_unavailable' }); },
    previewOwned: async () => { throw Object.assign(new Error('fixture has no native ownership'), { code: 'mutation_history_unavailable' }); } });
  const rows = new Map();
  let sequence = Date.now();
  const scene = sessionID => {
    if (rows.has(sessionID)) return rows.get(sessionID);
    const now = sequence += 100;
    const userID = `msg_${now.toString(16)}user`;
    const messageID = `msg_${(now + 1).toString(16)}answer`;
    const value = [{ info: { id: userID, sessionID, role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model' }, time: { created: now } }, parts: [{ id: `prt_${userID}`, sessionID, messageID: userID, type: 'text', text: 'Implement the session-specific file updates.' }] },
      { info: { id: messageID, sessionID, parentID: userID, role: 'assistant', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', mode: 'build', path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now + 1, completed: now + 2 }, finish: 'stop' }, parts: [{ id: `prt_${messageID}`, sessionID, messageID, type: 'text', text: 'Implementation complete. Review the recorded file changes below.' }] }];
    rows.set(sessionID, value); return value;
  };
  const replay = (id, status = 'idle') => fixture.replayRecoveryVisual({ sessionID: id, rows: scene(id), status });
  const begin = async (id, file, tool = 'edit') => {
    const records = scene(id); const messageID = records[1].info.id;
    const callID = `call_changes_${++sequence}`;
    const part = { id: `prt_${callID}`, sessionID: id, messageID, type: 'tool', callID, tool,
      state: { status: 'running', input: { filePath: file }, time: { start: sequence } } };
    records[1].parts.push(part); replay(id);
    await host.plugin({ action: 'message', sessionID: id, directory, userMessageID: records[0].info.id });
    await host.plugin({ action: 'before', sessionID: id, directory, callID });
    return { id, file, callID, part };
  };
  const finish = async (op, before, after, exact = true) => {
    await writeFile(path.join(directory, op.file), after);
    op.part.state = { ...op.part.state, status: 'completed', output: 'File updated', title: op.file,
      time: { start: op.part.state.time.start, end: ++sequence },
      ...(exact ? { metadata: { filediff: { file: op.file, before, after } } } : {}) };
    replay(op.id);
    await host.plugin({ action: 'after', sessionID: op.id, directory, callID: op.callID });
  };
  let prepared = false;
  try {
    const a = await begin(PERF_PARENT_SESSION_ID, 'shared.txt');
    const b = await begin(unrelated.id, 'independent.txt', 'write');
    await finish(a, null, 'first selected edit\n');
    await finish(b, null, 'independent session content\n');
    execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");fs.writeFileSync("shared.txt","external writer content\\n");fs.writeFileSync("external-only.txt","external only\\n")'], { cwd: directory });
    const second = await begin(PERF_PARENT_SESSION_ID, 'shared.txt');
    await finish(second, 'external writer content\n', 'second selected edit\n' + 'selected detail\n'.repeat(6000));
    const child = await begin(PERF_CHILD_SESSION_IDS[0], 'child.txt', 'oc_write');
    await finish(child, null, 'verified child content\n');
    for (const file of ['theme.css', 'test.txt']) {
      const op = await begin(PERF_PARENT_SESSION_ID, file, 'write'); await finish(op, null, `${file} selected content\n`);
    }
    const restore = await begin(restorable.id, 'restore.txt', 'write'); await finish(restore, null, 'restorable content\n');
    const known = await begin(partial.id, 'known.txt', 'write'); await finish(known, null, 'known exact content\n');
    const opaque = await begin(partial.id, 'opaque.txt', 'bash'); await finish(opaque, null, 'opaque effects\n', false);
    const retained = await begin(recovery.id, 'retained.txt', 'write'); await finish(retained, null, 'retained exact content\n');
    const recoveredRows = scene(recovery.id), recoveredMessageID = recoveredRows[1].info.id;
    const late = { id: `prt_late_${++sequence}`, sessionID: recovery.id, messageID: recoveredMessageID, type: 'tool', callID: `late_${sequence}`, tool: 'edit',
      state: { status: 'completed', input: { filePath: 'recovered.txt' }, output: 'File updated', time: { start: sequence, end: sequence + 1 } } };
    recoveredRows[1].parts.push(late); replay(recovery.id);
    await host.plugin({ action: 'after', sessionID: recovery.id, directory, callID: late.callID });

    const nativeRows = scene(native.id), nativeMessageID = nativeRows[1].info.id;
    nativeRows[1].info.providerID = 'cursor-acp';
    const nativeIdentity = { sessionID: native.id, directory, messageID: nativeMessageID, userMessageID: nativeRows[0].info.id };
    const taskID = `task_${++sequence}`;
    await host.acceptExecution({ ...nativeIdentity, phase: 'tool', callID: taskID, tool: 'task', state: 'running' });
    let projection;
    for (let i = 1; i <= 28; i++) {
      const file = `native-${String(i).padStart(2, '0')}.txt`;
      const patch = `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${i === 28 ? 'long-native-edit-'.repeat(400) : `native edit ${i}`}\n`;
      const message = normalizeInteractionUpdateToSdkMessage({ type: 'tool-call-delta', callId: taskID,
        taskUpdate: { type: 'tool-call-completed', callId: `edit_${i}`, toolCall: { type: 'edit', args: { path: file }, result: { status: 'success', value: { diffString: patch } } } } });
      await host.acceptExecution({ ...nativeIdentity, ...message.sessionChange });
      projection = mergeCursorNativeTaskActivity(projection, message);
    }
    assert.equal(projection.entries.length, 24);
    await host.acceptExecution({ ...nativeIdentity, phase: 'tool', callID: taskID, tool: 'task', state: 'completed' });
    nativeRows[1].parts.push({ id: `prt_${taskID}`, sessionID: native.id, messageID: nativeMessageID, type: 'tool', callID: taskID, tool: 'task',
      state: { status: 'completed', input: { prompt: 'Update 28 files.' }, output: 'Updated 28 files.', metadata: { cursorNativeTask: projection }, time: { start: sequence, end: sequence + 1 } } });
    replay(native.id);
    prepared = true;
    return { host, setPublisher: callback => { publishEvent = callback; }, sessionIDs: [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS, unrelated.id, restorable.id, partial.id, recovery.id, native.id], root: PERF_PARENT_SESSION_ID, child: PERF_CHILD_SESSION_IDS[0], unrelated: unrelated.id, restorable: restorable.id, partial: partial.id, recovery: recovery.id, native: native.id,
      repairLateReceipt: async () => {
        late.state.metadata = { filediff: { file: 'recovered.txt', before: null, after: 'recovered exact content\n' } };
        replay(recovery.id);
        await host.observe({ type: 'message.part.updated', properties: { part: late } }, directory);
      },
      settleNative: async () => { await host.acceptExecution({ ...nativeIdentity, phase: 'run-settled' }); },
      setStatus: (id, status) => replay(id, status),
      appendLiveEdit: async (id, file, before, after) => {
        const records = scene(id), messageID = records[1].info.id, callID = `call_changes_live_${++sequence}`;
        await writeFile(path.join(directory, file), after);
        records[1].parts.push({ id: `prt_${callID}`, sessionID: id, messageID, callID, type: 'tool', tool: 'write',
          state: { status: 'completed', input: { filePath: file }, output: 'File updated', title: file,
            time: { start: sequence, end: sequence + 1 }, metadata: { filediff: { file, before, after } } } });
        replay(id);
        const part = records[1].parts.at(-1);
        await host.observe({ type: 'message.part.updated', properties: { part } }, directory);
      } };
  } finally { if (!prepared) await host.drain(); }
}

export async function runSessionChangesQa({ cdp, directory, runtime, prepared, check, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const card = '[data-session-changes-card-root]';
  const cardText = () => evaluate(cdp, `document.querySelector('${card}')?.textContent ?? ''`);
  const summary = id => ui.waitFor('session change summary', async () => {
    const result = await evaluate(cdp, `fetch('/api/devryan/session/${id}/changes?directory='+encodeURIComponent(${JSON.stringify(directory)})).then(async r=>({status:r.status,body:await r.json()}))`);
    if (result.status === 503 && result.body?.code === 'reconciliation_busy') return null;
    if (result.status !== 200) throw new Error(`summary ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  });
  const select = async id => {
    await cdp.send('Page.navigate', { url: `${await evaluate(cdp, 'location.origin')}/?session=${id}` });
    await ui.waitExpression('selected session changes card', `Boolean(document.querySelector('${card}'))`);
    await ui.reveal(`${card} [data-session-changes-card]`, undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'down' });
  };
  const openHistory = async () => {
    if (await evaluate(cdp, `Boolean(document.querySelector('${card} [data-session-changes-action="show-more"]'))`)) {
      await ui.click({ selector: `${card} [data-session-changes-action="show-more"]` });
    }
    await ui.waitExpression('captured history visible', `Boolean(document.querySelector('${card} [data-session-changes-rows]'))`);
  };
  const review = '[data-session-changes-review]';
  const openReview = async () => {
    await ui.click({ selector: `${card} [data-session-changes-action="review"]` });
    await ui.waitExpression('changes review details', `Boolean(document.querySelector('${review}'))`);
  };
  const result = { externalWriterProcess: true, productionController: true, privateGitStore: true, checkpoints: [] };
  await check('exact summary excludes independent and external writers', async () => {
    const value = await summary(prepared.root);
    assert.equal(value.coverage, 'complete'); assert.equal(value.fileCount, 4);
    assert.equal(value.totalsMode, 'recorded'); assert.equal(value.restoreAvailable, false);
    assert.deepEqual(value.files.map(file => file.path), ['child.txt', 'shared.txt', 'test.txt', 'theme.css']);
    assert.equal(value.files.find(file => file.path === 'shared.txt').segmentCount, 2);
    result.checkpoints.push({ name: 'root', fileCount: value.fileCount, coverage: value.coverage, totalsMode: value.totalsMode });
  });
  await check('live exact receipt arrives through SSE without changing an unrelated summary', async () => {
    await select(prepared.unrelated);
    assert.match(await cardText(), /Edited 1 file/);
    assert.equal((await summary(prepared.unrelated)).current.state, 'verified');
    await openReview();
    await ui.waitExpression('verified current observation', `Boolean(document.querySelector('${review} [data-session-changes-current="verified"]'))`);
    await ui.key('Escape');
    await openHistory();
    await prepared.appendLiveEdit(prepared.unrelated, 'independent-live.txt', null, 'live independent content\n');
    await ui.waitExpression('live receipt added to selected card', `document.querySelector('${card}')?.textContent.includes('independent-live.txt')`);
    assert.equal((await summary(prepared.unrelated)).fileCount, 2);
    assert.equal((await summary(prepared.root)).fileCount, 4);
    await screenshot('changes-live-independent-receipt');
  });
  await check('a late exact receipt clears only its repaired error without reloading', async () => {
    await select(prepared.recovery);
    await openHistory();
    await openReview();
    await ui.waitExpression('recoverable capture error', `document.querySelector('${review}')?.textContent.includes('A tool did not provide a complete record')`);
    assert.match(await cardText(), /retained.txt/);
    await screenshot('changes-before-late-recovery');
    await prepared.repairLateReceipt();
    await ui.waitExpression('late receipt settled in card', `document.querySelector('${card}')?.textContent.includes('recovered.txt') && !document.querySelector('${review}')?.textContent.includes('A tool did not provide a complete record')`);
    assert.equal((await summary(prepared.recovery)).coverage, 'complete');
    await screenshot('changes-after-late-recovery');
    await ui.key('Escape');
  });
  await check('native receipts exceed preview limits and pending coverage automatically settles', async () => {
    await select(prepared.native);
    await openReview();
    await ui.waitExpression('pending native reconciliation', `document.querySelector('${review}')?.textContent.includes('Loading session changes')`);
    const pending = await summary(prepared.native);
    assert.equal(pending.fileCount, 28); assert.equal(pending.reconciliationState, 'pending');
    assert.equal(pending.restoreAvailable, false);
    await screenshot('changes-native-pending');
    // No UI event is published for this delayed commit: subscribed backoff must
    // discover settlement on its own.
    await prepared.settleNative();
    await ui.waitExpression('native reconciliation settled', `document.querySelector('${card}')?.textContent.includes('28 files') && !document.querySelector('${review}')?.textContent.includes('Loading session changes')`);
    const settled = await summary(prepared.native);
    assert.equal(settled.coverage, 'complete'); assert.equal(settled.reconciliationState, 'settled'); assert.equal(settled.restoreAvailable, false);
    const diff = await evaluate(cdp, `fetch('/api/devryan/session/${prepared.native}/changes/diff?directory='+encodeURIComponent(${JSON.stringify(directory)})+'&revision=${settled.revision}&file=native-28.txt&segment=0').then(r=>r.json())`);
    assert.ok(diff.patch.includes('long-native-edit-'.repeat(400)));
    await screenshot('changes-native-settled');
    await ui.key('Escape');
    result.checkpoints.push({ name: 'native', fileCount: settled.fileCount, coverage: settled.coverage, previewRows: 24 });
  });
  const exerciseUnavailableRestore = async prefix => {
    await select(prepared.restorable);
    const value = await summary(prepared.restorable);
    assert.equal(value.restoreAvailable, false);
    assert.ok(value.restoreReasons.includes('restore_evidence_unavailable'));
    const button = `${card} [data-session-changes-action="undo"]`;
    await ui.waitExpression('unowned undo is disabled', `Boolean(document.querySelector('${button}:disabled'))`);
    const reason = await evaluate(cdp, `document.querySelector('${button}')?.parentElement?.getAttribute('title')`);
    assert.match(reason, /evidence needed for safe Undo or Redo is unavailable/i);
    await screenshot(`${prefix}-undo-unavailable`);
  };
  for (const theme of ['light', 'dark']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const narrow of [false, true]) {
      const width = narrow ? (runtime === 'electron' ? 600 : 390) : 1280;
      const prefix = `changes-${theme}-${width}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: narrow ? 844 : 800, deviceScaleFactor: 1, mobile: narrow && runtime === 'web' });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: narrow && runtime === 'web' });
      await check(`${prefix}: completed card while independent writer is busy`, async () => {
        prepared.setStatus(prepared.unrelated, 'busy');
        await select(prepared.root);
        await ui.waitExpression('compact captured files visible', `document.querySelector('${card}')?.textContent.includes('Edited 4 files') && document.querySelectorAll('${card} [data-session-changes-rows] button').length === 4`);
        assert.equal((await summary(prepared.root)).current.state, 'verified', 'an independent busy session must not make this completed root uncertain');
        assert.match(await cardText(), /4 files/); assert.doesNotMatch(await cardText(), /independent.txt|external-only.txt|unverified|overlapping owners/);
        assert.equal(await evaluate(cdp, `document.documentElement.classList.contains('dark')`), theme === 'dark');
        assert.equal(await evaluate(cdp, `Boolean(document.querySelector('${card} [data-session-changes-action="show-more"]'))`), false);
        await ui.waitExpression('visible fourth row', `document.querySelector('${card}')?.textContent.includes('theme.css')`);
        await screenshot(`${prefix}-expanded-busy-sibling`);
        const bounds = await evaluate(cdp, `(() => {const r=document.querySelector('${card}').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
        assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && !bounds.overflow, JSON.stringify(bounds));
      });
      await check(`${prefix}: recorded segment navigation and patch pagination`, async () => {
        await ui.click({ selector: `${card} [data-session-changes-rows] button`, text: 'shared.txt', exact: false });
        await ui.waitVisibleText('Edit 1 of 2');
        assert.match(await evaluate(cdp, `document.querySelector('[role="dialog"] pre')?.textContent`), /first selected edit/);
        await screenshot(`${prefix}-first-edit`);
        await ui.click({ text: 'Next Edit' });
        await ui.waitVisibleText('Edit 2 of 2');
        await ui.waitExpression('second recorded patch', `document.querySelector('[role="dialog"] pre')?.textContent.includes('second selected edit')`);
        await ui.click({ text: 'Next', selector: '[role="dialog"] button' });
        await ui.waitVisibleText('Page 2');
        await screenshot(`${prefix}-second-edit-page-two`);
        await ui.key('Escape');
      });
      await check(`${prefix}: child selection and reload excludes its parent`, async () => {
        await select(prepared.child);
        await openHistory();
        await ui.waitExpression('child file', `document.querySelector('${card}')?.textContent.includes('child.txt')`);
        assert.doesNotMatch(await cardText(), /shared.txt|theme.css|Recorded Edits/);
        assert.equal((await summary(prepared.child)).fileCount, 1);
        await ui.reload();
        await ui.waitExpression('reloaded child changes card', `Boolean(document.querySelector('${card}'))`);
        await openHistory();
        await ui.reveal(`${card} [data-session-changes-card]`, undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'down' });
        await screenshot(`${prefix}-child-reloaded`);
      });
      await check(`${prefix}: precise capture limitation retains exact file`, async () => {
        prepared.setStatus(prepared.unrelated, 'idle');
        await select(prepared.partial);
        const value = await summary(prepared.partial);
        assert.deepEqual(value.files.map(file => file.path), ['known.txt']); assert.equal(value.coverage, 'partial');
        await openReview();
        await ui.waitExpression('specific missing execution evidence', `document.querySelector('${review}')?.textContent.includes('A tool did not provide a complete record of its file edits')`);
        assert.doesNotMatch(await cardText(), /could not be verified for this session/);
        await screenshot(`${prefix}-capture-limitation`);
        await ui.key('Escape');
      });
      await check(`${prefix}: unowned Undo stays disabled with explanation`, () => exerciseUnavailableRestore(prefix));
    }
  }
  await check('unowned real host refuses an unproved Undo without changing files', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await select(prepared.restorable);
    const value = await summary(prepared.restorable); assert.equal(value.restoreAvailable, false);
    const before = await readFile(path.join(directory, 'restore.txt'), 'utf8');
    const refused = await evaluate(cdp, `fetch('/api/devryan/session/${prepared.restorable}/changes/undo?directory='+encodeURIComponent(${JSON.stringify(directory)}),{method:'POST',headers:{'Content-Type':'application/json','X-DevRyan-CSRF':'1'},body:JSON.stringify({revision:${JSON.stringify(value.revision)}})}).then(async r=>({status:r.status,body:await r.json()}))`);
    assert.equal(refused.status, 409); assert.equal(await readFile(path.join(directory, 'restore.txt'), 'utf8'), before);
    assert.equal(await readFile(path.join(directory, 'external-only.txt'), 'utf8'), 'external only\n');
  });
  await check('fixture-only proof revision refreshes after a stale Undo, then scopes Undo and Redo', async () => {
    const realSummary = await summary(prepared.restorable);
    const origin = await evaluate(cdp, 'location.origin');
    const transport = await installQaChangeProof({ cdp, origin, sessionID: prepared.restorable, directory, summary: realSummary });
    try {
      await select(prepared.restorable);
      const undo = `${card} [data-session-changes-action="undo"]`;
      await ui.waitExpression('fixture-owned undo enabled', `Boolean(document.querySelector('${undo}:not(:disabled)'))`);
      const initial = await summary(prepared.restorable);
      assert.equal(initial.restoreProof?.version, 1); assert.match(initial.restoreProof.digest, /^[a-f0-9]{64}$/);
      await evaluate(cdp, `globalThis.__devryanQaChangeProof.staleNext=true`);
      await ui.click({ selector: undo }); await ui.waitVisibleText('Undo this session’s changes?', '[role="dialog"]');
      await screenshot('changes-proof-desktop-confirm');
      await ui.click({ text: 'Undo', selector: '[role="dialog"] button' });
      await ui.waitExpression('stale proof refresh', `globalThis.__devryanQaChangeProof.requests.length===1 && globalThis.__devryanQaChangeProof.proof.digest!==${JSON.stringify(initial.restoreProof.digest)} && Boolean(document.querySelector('${undo}:not(:disabled)'))`);
      const refreshed = await summary(prepared.restorable);
      assert.notEqual(refreshed.revision, initial.revision); assert.notEqual(refreshed.restoreProof.digest, initial.restoreProof.digest);
      await ui.click({ selector: undo }); await ui.waitVisibleText('Undo this session’s changes?', '[role="dialog"]');
      await ui.click({ text: 'Undo', selector: '[role="dialog"] button' });
      await ui.waitExpression('fixture redo enabled after fresh proof', `Boolean(document.querySelector('[data-session-changes-action="redo"]:not(:disabled)'))`);
      const undone = await summary(prepared.restorable);
      assert.equal(undone.undone, true); assert.notEqual(undone.revision, refreshed.revision);
      const undoRequest = await evaluate(cdp, `globalThis.__devryanQaChangeProof.requests[1]`);
      assert.deepEqual(undoRequest.body, { revision: refreshed.revision, restoreProof: refreshed.restoreProof });
      if (runtime === 'web') {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await new Promise(resolve => setTimeout(resolve, 500));
        const sidebarOpen = await evaluate(cdp, `Boolean(document.querySelector('button[aria-label="Close Sessions"]'))`);
        if (sidebarOpen) await ui.click({ label: 'Close Sessions' });
        await ui.reveal(`${card} [data-session-changes-action="redo"]`, undefined, { scrollContainer: '[data-scrollbar="chat"]' });
      }
      await screenshot('changes-proof-mobile-redo');
      await ui.click({ selector: '[data-session-changes-action="redo"]' });
      await ui.waitExpression('fixture fresh redo proof accepted', `Boolean(document.querySelector('${undo}:not(:disabled)'))`);
      const requests = await evaluate(cdp, `globalThis.__devryanQaChangeProof.requests`);
      assert.deepEqual(requests[2], { action: 'redo', body: { revision: undone.revision, restoreProof: undone.restoreProof } });
      assert.equal(await readFile(path.join(directory, 'restore.txt'), 'utf8'), 'restorable content\n');
      result.proofFixture = { source: 'scoped UI transport simulation; no native restore or filesystem mutation', requests: requests.length, staleRejected: true };
    } finally { await transport.close(); await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); }
  });
  return result;
}
