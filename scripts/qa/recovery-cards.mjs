import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStandardSessionTitleRuntime } from '../../packages/web/server/lib/opencode/standard-session-title-runtime.js';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createManagedTaskRecord, toManagedTaskEvent } from '../../packages/orchestration-runtime/contract.js';
import { projectRequiredCheckEvidence, projectRequiredCheckCompletion } from '../../packages/orchestration-runtime/required-checks.js';
import { createManagedTaskResultEnvelope } from '../../packages/orchestration-runtime/result-envelope.js';
import { PERF_PARENT_SESSION_ID, PERF_CHILD_SESSION_IDS } from '../perf/fixture-session-seeds.mjs';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { installQaManagedTaskReadModel } from './fixture-managed-tasks.mjs';

/** Actual web/Electron UI + HTTP/SSE replay; provider execution is intentionally deterministic. */
export async function runQaRecoveryCards({ fixture, cdp, directory, dataDirectory, runtime, check, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const root = PERF_PARENT_SESSION_ID, child = PERF_CHILD_SESSION_IDS[0], now = Date.now();
  const origin = await evaluate(cdp, 'location.origin');
  const ids = Object.fromEntries(['human', 'dispatch', 'wake', 'plan', 'childUser', 'childAssistant'].map((key, i) => [key, `msg_${(now + i).toString(16)}000${key}`]));
  const text = (sessionID, messageID, value, synthetic = false) => ({ id: `prt_${messageID}_${synthetic ? 'policy' : 'text'}`, sessionID, messageID, type: 'text', text: value, synthetic });
  const user = (sessionID, id, created, parts, plan = false) => ({ info: { id, sessionID, role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model' }, ...(plan ? { mode: 'plan' } : {}), time: { created } }, parts });
  const assistant = (sessionID, id, parentID, created, parts, completed = true) => ({ info: { id, sessionID, parentID, role: 'assistant', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created, ...(completed ? { completed: created + 1 } : {}) }, ...(completed ? { finish: 'stop' } : {}) }, parts });
  const tasks = Array.from({ length: 6 }, (_, i) => ({ ...createManagedTaskRecord({ taskId: `dvr_task_qa_recovery_${i + 1}`, idempotencyKey: `recovery-${i + 1}`, rootSessionId: root, parentTaskId: null, childSessionId: child,
    dispatchCallId: 'call_qa_original_recovery', dispatchGroupId: ids.dispatch, dispatchWaveId: 'dvr_wave_qa_recovery', directory, sequence: i + 1, mode: 'orchestrator', providerId: i === 5 ? 'opencode' : 'openai', modelId: i === 5 ? 'deepseek-v4-flash' : 'gpt-6.1-sol', agent: 'explorer', variant: null,
    label: 'Locate calendar and booking details', prompt: 'Read-only fixture investigation.', attempt: i + 1, priorTaskId: i ? `dvr_task_qa_recovery_${i}` : null, executionKind: i ? 'retry_in_place' : 'start', recoveryLineageId: i ? 'dvr_lineage_qa_recovery_1' : null, createdAt: now + i * 10, timeoutAt: now + 60000 }),
    status: i === 5 ? 'running' : 'failed', startedAt: now + i * 10 + 1, finishedAt: i === 5 ? null : now + i * 10 + 2, childPromptedAt: now + i * 10 + 1, firstAssistantPartAt: now + i * 10 + 1,
    failureReason: i === 5 ? null : 'The usage limit has been reached', partial: i !== 5, recoverablePreview: '', canonicalRefs: [] }));
  const envelope = task => createManagedTaskResultEnvelope(task, { sequence: task.sequence, createdAt: task.finishedAt, resumable: task.status !== 'completed' });
  const model = (records, objectiveVerification = null, objectiveId = ids.human, originatingMessageId = ids.human) => ({ directory, rootSessionID: root, objectiveId, originatingMessageId, objectiveVerification,
    records: records.map(record => { const event = toManagedTaskEvent(record.task, record.resultEnvelope ?? undefined);
      if (record.verification) event.properties.task.verification = structuredClone(record.verification);
      return { ...record, event }; }),
    snapshot: { available: true, bridgeReady: false, recoveryWarning: null,
      tasks: records.map(record => ({ ...toManagedTaskEvent(record.task).properties.task, ...(record.verification ? { verification: record.verification } : {}) })),
      resultEnvelopes: records.flatMap(record => record.resultEnvelope ? [record.resultEnvelope] : []) } });
  const failed = { task: tasks[0], resultEnvelope: envelope(tasks[0]) };
  const originalPart = { id: 'prt_qa_dispatch', sessionID: root, messageID: ids.dispatch, type: 'tool', tool: 'devryan_task', callID: tasks[0].dispatchCallId,
    state: { status: 'completed', input: { action: 'start', agent: 'explorer', label: tasks[0].label }, output: JSON.stringify({ task: toManagedTaskEvent(tasks[0]).properties.task }), title: tasks[0].label, metadata: {}, time: { start: now, end: now + 1 } } };
  const parentRows = [user(root, ids.human, now, [text(root, ids.human, 'Plan the calendar and booking detail fix.'), text(root, ids.human, 'User has requested to enter plan mode.', true)], true),
    assistant(root, ids.dispatch, ids.human, now + 1, [text(root, ids.dispatch, 'I will collect the Explorer result before writing the plan.'), originalPart])];
  const childRows = [user(child, ids.childUser, now, [text(child, ids.childUser, 'Locate the calendar and booking detail components.')]),
    assistant(child, ids.childAssistant, ids.childUser, now + 1, [{ ...text(child, ids.childAssistant, 'Recovered child: inspecting shared calendar and appointment details.'), time: { start: now + 1, end: now + 2 } }], false)];
  fixture.replayRecoveryVisual({ sessionID: root, rows: parentRows });
  fixture.replayRecoveryVisual({ sessionID: child, rows: childRows, status: 'busy' });
  const transport = await installQaManagedTaskReadModel({ transport: 'fixture', origin, cdp, model: model([failed]) });
  const selectionRequests = new Map(), selectionResponses = [];
  const offRequest = cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (!request.url.includes('/session-retention/selection')) return;
    try { const { sessionID, revision, committed } = JSON.parse(request.postData); selectionRequests.set(requestId, { sessionID, revision, committed }); } catch {}
  });
  const offResponse = cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (selectionRequests.has(requestId)) selectionResponses.push({ ...selectionRequests.get(requestId), status: response.status });
  });
  const card = '[aria-label="Agent Dispatch"]';
  const activeSelector = `[data-managed-task-id="${tasks[5].taskId}"]`;
  const planSelector = `[data-plan-source-message-id="${ids.plan}"]`;
  const chat = '[data-scrollbar="chat"]';
  const screenshotVisible = async (selector, name) => {
    await ui.waitFor(`visible screenshot ${name}`, async () => {
      await ui.reveal(selector, undefined, { scrollContainer: chat, fullyVisible: true });
      await new Promise(resolve => setTimeout(resolve, 250));
      await screenshot(name);
      return evaluate(cdp, `(() => {const e=document.querySelector(${JSON.stringify(selector)}), r=e?.getBoundingClientRect();
        return Boolean(r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
          && e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)));})()`);
    });
  };
  let titleRuntime;
  try {
    await check('recovery fixture preserves genuine failure before resumption', async () => {
      await ui.reload();
      await ui.waitExpression('failed authoritative row', `Boolean(document.querySelector('[data-managed-task-id="${tasks[0].taskId}"]'))`);
      await ui.reveal(`[data-managed-task-id="${tasks[0].taskId}"]`, undefined, { scrollContainer: chat });
      await screenshot('recovery-failed');
      assert.match(await evaluate(cdp, `document.querySelector('[data-managed-task-id="${tasks[0].taskId}"]').innerText`), /Error/);
    });
    const retained = tasks.slice(2).map(task => ({ task, ...(task.status === 'failed' ? { resultEnvelope: { ...envelope(task), action: 'retry_in_place', acknowledgedAt: now + 100, followUpTaskId: `dvr_task_qa_recovery_${task.attempt + 1}` } } : {}) }));
    const completed = { ...tasks[5], status: 'completed', finishedAt: now + 200, recoverablePreview: 'Located shared components.' };
    const completedRecord = { task: completed, resultEnvelope: { ...envelope(completed), action: 'continue', acknowledgedAt: now + 201 } };
    const markdown = '# Calendar and booking details\n\n## Context\nRestore consistent appointment details and calendar spacing.\n\n## Implementation\n\n### Phase 1: Shared details\n1. Align the service and patient labels.\n2. Restore the popover spacing.\n\n### Phase 2: Navigation\n1. Preserve the selected appointment when opening its detail page.\n2. Keep the patient name below the service title in both views.\n3. Verify return navigation restores the previous calendar position.\n\n### Phase 3: Responsive presentation\n1. Let the calendar expand without an internal scrollbar.\n2. Match the spacing on clinic and professional popovers.\n3. Verify dismissal animation and keyboard focus.\n\n## Verification\n1. Check clinic and professional calendars.\n2. Reload and verify the full plan remains in its card.';
    fixture.qaPlan = { sessionID: root, sourceMessageID: ids.plan, rootUserID: ids.human, wakeID: ids.wake, markdown };
    const completeRows = [...parentRows,
      user(root, ids.wake, now + 210, [text(root, ids.wake, '[devryan-provider-recovery:v1:dvr_task_qa_recovery_6]\nCollect the completed result.', true)]),
      assistant(root, ids.plan, ids.wake, now + 211, [text(root, ids.plan, `The recovered investigation is complete.\n<!--plan-->\n${markdown}`)])];
    const planRows = [...parentRows,
      user(root, ids.wake, now + 210, [text(root, ids.wake, 'Prepare the calendar plan from the recovered investigation.')], true),
      assistant(root, ids.plan, ids.wake, now + 211, [text(root, ids.plan, `The recovered investigation is complete.\n<!--plan-->\n${markdown}`)])];
    const checkDefinition = [{ name: 'Calendar integration', command: 'bun test calendar', paths: ['calendar.ts'] }];
    const fingerprint = 'a'.repeat(64);
    const verification = (status, objectiveId, observedAt) => {
      const hasReceipt = status !== 'pending';
      const receipt = hasReceipt ? [{ name: 'Calendar integration', callId: 'call_qa_check', messageId: ids.plan,
        exitCode: status === 'failed' ? 1 : 0, status: status === 'failed' ? 'failed' : 'passed',
        observedAt, contentHash: fingerprint }] : [];
      const checks = projectRequiredCheckEvidence(checkDefinition, receipt,
        { 'Calendar integration': status === 'stale' ? 'b'.repeat(64) : fingerprint });
      return { ...projectRequiredCheckCompletion(checks), objectiveId, checks, observedAt };
    };
    await transport.updateModel(model([...retained.slice(0, -1), completedRecord], null, ids.human, ids.wake));
    fixture.replayRecoveryVisual({ sessionID: root, rows: completeRows, taskEvents: [completedRecord] });
    await check('completed task distinguishes pending, stale, failed and verified evidence', async () => {
      for (const [index, status, label] of [[0, 'pending', 'Verification pending'], [1, 'stale', 'Checks need rerunning'],
        [2, 'failed', 'Checks failed'], [3, 'passed', 'Verified']]) {
        const projected = verification(status, ids.human, now + 500 + index);
        await transport.updateModel(model([...retained.slice(0, -1), { ...completedRecord, verification: projected }],
          verification('pending', ids.human, now + 600 + index), ids.human, ids.wake));
        await ui.waitExpression(`completed ${status} verification`, `(() => {const row=document.querySelector('${activeSelector}');
          return Boolean(row && row.innerText.includes('Complete') && row.innerText.includes(${JSON.stringify(label)})
            && row.querySelector('[data-task-verification]'));})()`);
        await screenshotVisible(activeSelector, `recovery-verification-${status}`);
      }
      await ui.reload();
      await ui.waitExpression('root objective checks panel', `Boolean(document.querySelector('[data-objective-verification="${ids.human}"]'))`);
      const panel = `[data-objective-verification="${ids.human}"]`;
      await ui.waitExpression('current objective check text', `(() => {const text=document.querySelector('${panel}')?.innerText;return text?.includes('Objective checks') && text.includes('Calendar integration') && text.includes('Pending evidence');})()`);
      await screenshotVisible(panel, 'recovery-objective-checks');
      const wrong = await evaluate(cdp, `fetch('/api/orchestration/objective/verification?'+new URLSearchParams({rootSessionId:${JSON.stringify(root)},directory:${JSON.stringify(directory)},expectedObjectiveId:'msg_wrong'})).then(r=>r.status)`);
      assert.equal(wrong, 409, 'old objective proof must not be returned as current');
      const nextObjective = `${ids.human}_next`, nextAssistant = `${ids.plan}_next`;
      const nextRows = [...completeRows, user(root, nextObjective, now + 700, [text(root, nextObjective, 'Verify the follow-up objective.')]),
        assistant(root, nextAssistant, nextObjective, now + 701, [text(root, nextAssistant, 'Checking the follow-up objective.')])];
      await transport.updateModel(model([...retained.slice(0, -1), { ...completedRecord, verification: verification('passed', ids.human, now + 704) }],
        verification('failed', nextObjective, now + 705), nextObjective, nextObjective));
      fixture.replayRecoveryVisual({ sessionID: root, rows: nextRows });
      await ui.waitExpression('new objective replaces old root proof', `Boolean(document.querySelector('[data-objective-verification="${nextObjective}"]'))
        && !document.querySelector('[data-objective-verification="${ids.human}"]')`);
      const nextPanel = `[data-objective-verification="${nextObjective}"]`;
      await ui.waitExpression('new objective failed check', `document.querySelector('${nextPanel}')?.innerText.includes('Failed')`);
      await screenshotVisible(nextPanel, 'recovery-objective-changed');
      await transport.updateModel(model([...retained.slice(0, -1), { ...completedRecord, verification: verification('passed', ids.human, now + 706) }],
        verification('pending', ids.human, now + 707), ids.human, ids.wake));
      fixture.replayRecoveryVisual({ sessionID: root, rows: completeRows, taskEvents: [completedRecord] });
      await ui.reload();
      await ui.waitExpression('original objective restored for remaining journey', `Boolean(document.querySelector('[data-objective-verification="${ids.human}"]'))`);
      if (runtime === 'web') {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await ui.reveal(panel, undefined, { scrollContainer: chat });
        const bounds = await evaluate(cdp, `(() => {const r=document.querySelector('${panel}').getBoundingClientRect();return {x:r.x,right:r.right,width:innerWidth,scrollWidth:document.documentElement.scrollWidth};})()`);
        assert.ok(bounds.x >= -1 && bounds.right <= bounds.width + 1 && bounds.scrollWidth <= bounds.width + 1, 'objective panel stays in mobile viewport');
        await screenshotVisible(panel, 'recovery-objective-checks-mobile');
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    });
    await transport.updateModel(model([failed]));
    fixture.replayRecoveryVisual({ sessionID: root, rows: parentRows });
    await check('sixth attempt replaces pruned failure live and after reload', async () => {
      await transport.updateModel(model(retained));
      fixture.replayRecoveryVisual({ sessionID: root, rows: parentRows, taskEvents: retained });
      fixture.removeManagedTaskVisual(tasks[0]);
      fixture.removeManagedTaskVisual(tasks[1]);
      await ui.waitExpression('current sixth attempt', `Boolean(document.querySelector('${activeSelector}'))`);
      for (const reloaded of [false, true]) {
        if (reloaded) await ui.reload();
        await ui.waitExpression('only current attempt in original card', `document.querySelectorAll('${activeSelector}').length===1 && !document.querySelector('[data-managed-task-fallback-id]')`);
        await ui.reveal(activeSelector, undefined, { scrollContainer: chat });
        const visible = await evaluate(cdp, `document.querySelector('${activeSelector}').innerText`);
        assert.match(visible, /Running/); assert.doesNotMatch(visible, /Error/); assert.match(visible, /deepseek-v4-flash/);
        await screenshot(reloaded ? 'recovery-running-reload' : 'recovery-running-live');
      }
      await ui.waitFor('Open Subtask reaches the child', async () => {
        if (await evaluate(cdp, `document.body.innerText.includes('Recovered child: inspecting shared calendar')`)) return true;
        await ui.reveal(activeSelector + ' button', 'Open Subtask', { scrollContainer: chat });
        await ui.click({ selector: activeSelector + ' button', text: 'Open Subtask' });
        await new Promise(resolve => setTimeout(resolve, 700));
        return evaluate(cdp, `document.body.innerText.includes('Recovered child: inspecting shared calendar')`);
      });
      await ui.waitVisibleText('Recovered child: inspecting shared calendar');
      await ui.waitExpression('parent row no longer displayed after child navigation', `!document.querySelector('${activeSelector}')`);
      await screenshot('recovery-child');
      await cdp.send('Page.navigate', { url: `${origin}/?session=${root}` });
      await ui.waitExpression('parent restored', `Boolean(document.querySelector('${activeSelector}'))`);
    });
    await check('a follow-up human turn produces one saved actionable plan with completed dispatch', async () => {
      fixture.qaPlan = { sessionID: root, sourceMessageID: ids.plan, rootUserID: ids.wake, wakeID: ids.wake, markdown };
      await transport.updateModel(model([...retained.slice(0, -1), completedRecord], null, ids.wake, ids.wake));
      fixture.replayRecoveryVisual({ sessionID: child, rows: [childRows[0], assistant(child, ids.childAssistant, ids.childUser, now + 1, childRows[1].parts)] });
      fixture.replayRecoveryVisual({ sessionID: root, rows: planRows, taskEvents: [completedRecord] });
      await ui.waitExpression('one recovered Plan card', `document.querySelectorAll('${planSelector}').length===1`);
      await ui.reveal(planSelector + ' button', 'Implement Plan', { scrollContainer: chat, direction: 'down' });
      await ui.waitExpression('saved plan action enabled', `Array.from(document.querySelectorAll('${planSelector} button')).some(e=>e.innerText==='Implement Plan'&&!e.disabled)`);
      const savedFiles = (await readdir(dataDirectory, { recursive: true })).filter(file => file.endsWith(`${ids.plan}.md`));
      assert.equal(savedFiles.length, 1, 'one canonical saved Markdown file');
      assert.equal(await readFile(path.join(dataDirectory, savedFiles[0]), 'utf8'), markdown);
      await ui.waitVisibleText('Implement Plan', planSelector);
      // Let the enabled action's CSS transition finish before capturing it.
      await new Promise(resolve => setTimeout(resolve, 300));
      await screenshot('recovery-plan-saved');
      await ui.reveal(planSelector + ' button[aria-label="Expand Plan"]', undefined, { scrollContainer: chat });
      await ui.click({ selector: planSelector + ' button', label: 'Expand Plan' });
      await ui.waitExpression('plan expansion finished', `(() => {const e=document.querySelector('${planSelector} .oc-plan-card-body');return e?.getAttribute('aria-expanded')==='true'&&e.clientHeight>=e.scrollHeight-1;})()`);
      await ui.revealText('Reload and verify the full plan remains in its card.', planSelector, { scrollContainer: chat, direction: 'down' });
      await screenshot('recovery-plan-expanded');
      await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
      await ui.reload();
      await ui.waitExpression('saved plan after reload', `document.querySelectorAll('${planSelector}').length===1`);
      await ui.revealText('Complete', activeSelector, { scrollContainer: chat });
      assert.match(await evaluate(cdp, `document.querySelector('${activeSelector}').innerText`), /Complete/);
      await screenshot('recovery-completed-reload');
      assert.equal(await evaluate(cdp, `document.querySelectorAll('${card}').length`), 1);
    });
    await check('narrow viewport keeps the saved plan and recovered row usable', async () => {
      if (runtime === 'electron') {
        await ui.click({ label: 'Close Sessions' });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 844, deviceScaleFactor: 1, mobile: false });
      } else {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await ui.waitExpression('mobile layout', `Boolean(document.querySelector('button[aria-label="Open Sessions"]'))`);
        await ui.waitExpression('mobile saved plan panel', `Boolean(document.querySelector('button[aria-label="Close Plan"]'))`);
        await ui.waitVisibleText('Calendar and booking details');
        await screenshot('recovery-mobile-saved-file');
        await ui.click({ label: 'Close Plan', touch: true });
      }
      await ui.reveal(planSelector + ' button', 'Implement Plan', { scrollContainer: chat, direction: 'down', fullyVisible: true });
      await screenshot('recovery-narrow-plan');
      await ui.revealText('Complete', activeSelector, { scrollContainer: chat });
      await screenshot('recovery-narrow-dispatch');
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    });
    const fixtureClient = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }), getAuthHeaders: () => fixture.authHeaders });
    const summarizedChildren = [], fixtureChildSessionIDs = [];
    let titleSource = null;
    titleRuntime = createStandardSessionTitleRuntime({ openCodeClient: fixtureClient, watchdogEnabled: false,
      captureManagedTitleInput: async ({ sessionID, messageID }) => {
        if (!titleSource || titleSource.sessionID !== sessionID || titleSource.messageID !== messageID) throw new Error('qa_title_scope_refused');
        return { directory, sourceMessageID: messageID, text: titleSource.brief, recheck: async () => { if (titleSource?.sessionID !== sessionID) throw new Error('qa_title_scope_refused'); } };
      },
      generateSessionModelTitle: async () => titleSource?.expected,
      onTitleGenerated: ({ session, title }) => { void transport.publish([{ directory, payload: { type: 'session.updated', properties: { info: { ...session, title }, sessionID: session.id } } }]); } });
    await check('generic Explorer and Designer session titles summarize the brief, persist and survive reload', async () => {
      for (const [agent, brief, expected] of [
        ['explorer', 'Inspect profile review statistics and navigation', 'Inspect Profile Review Statistics and Navigation'],
        ['designer', 'Implement compact reviews summary and back navigation', 'Compact Reviews Summary and Back Navigation'],
      ]) {
        const session = await fixtureClient.sessions.create({ parentID: root, title: `Managed ${agent} task` }, { directory });
        fixtureChildSessionIDs.push(session.id);
        await transport.updateModel({ ...model([...retained.slice(0, -1), completedRecord], null, ids.wake, ids.wake), fixtureChildSessionIDs });
        const titleUserId = `msg_qa_title_${agent}`;
        const titleRows = [{
          ...user(session.id, titleUserId, now + 300, [text(session.id, titleUserId, `[devryan-agent-contract:v1] Runtime instructions.\nFollow the task brief.\n\n${brief}`)]),
          info: { ...user(session.id, titleUserId, now + 300, []).info, agent, model: { providerID: 'anthropic', modelID: 'fixture-model' } },
        }];
        titleSource = { sessionID: session.id, messageID: titleUserId, brief, expected };
        fixture.replayRecoveryVisual({ sessionID: session.id, rows: titleRows, agent, status: 'busy' });
        await cdp.send('Page.navigate', { url: `${origin}/?session=${session.id}` });
        await ui.waitVisibleText(`Managed ${agent} task`);
        await titleRuntime.schedule({ sessionID: session.id, directory, acceptedInputID: titleUserId });
        await ui.waitVisibleText(expected);
        // Canonical persistence still waits for the child's authoritative idle edge.
        const before = await fixtureClient.sessions.get(session.id, { directory });
        assert.equal(before.title, `Managed ${agent} task`);
        fixture.replayRecoveryVisual({ sessionID: session.id, rows: titleRows, status: 'idle' });
        await titleRuntime.processOpenCodeEvent({ type: 'session.idle', properties: { sessionID: session.id } });
        await ui.waitFor('canonical summarized child title', async () => (await fixtureClient.sessions.get(session.id, { directory })).title === expected);
        await ui.reload();
        await ui.waitVisibleText(expected);
        await screenshot(`recovery-${agent}-title`);
        summarizedChildren.push({ agent, sessionID: session.id, title: expected });
      }
    });
    await transport.assertHealthy();
    return { outcome: 'passed', source: 'actual UI with canonical HTTP/SSE recovery replay; no live provider execution', attempts: 6, rootSessionID: root, childSessionID: child, planMessageID: ids.plan, markdown, summarizedChildren, snapshotTransport: transport.evidence };
  } catch (error) {
    const evidence = await transport.readEvidence();
    console.error(JSON.stringify({ recoveryFixtureDiagnostic: { selectionResponses, objectiveRequests: evidence?.requests?.filter(request => request.url.includes('/objective/verification')).map(({ url, responseStatus }) => ({ url, responseStatus })) } }));
    throw error;
  } finally { await titleRuntime?.dispose(); delete fixture.qaPlan; offRequest(); offResponse(); await transport.close(); }
}
