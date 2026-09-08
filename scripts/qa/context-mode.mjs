import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ContextModeWorkerPool } from '../../packages/web/server/lib/opencode/context-mode-worker-pool.js';
import { PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';

export function createContextModeScene(directory, now = Date.now()) {
  const sessionID = PERF_PARENT_SESSION_ID;
  const userID = `msg_${now.toString(16)}001user`;
  const assistantID = `msg_${(now + 1).toString(16)}001assistant`;
  const tool = { id: `prt_${now.toString(16)}001tool`, sessionID, messageID: assistantID,
    type: 'tool', tool: 'ctx_index', callID: `call_${now.toString(16)}`,
    state: { status: 'running', input: { content: 'Disposable fixture content', source: 'fixture' }, time: { start: now } } };
  const assistant = { info: { id: assistantID, sessionID, parentID: userID, role: 'assistant', agent: 'build',
    providerID: 'fixture', modelID: 'fixture-model', path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now + 1 } }, parts: [tool] };
  const rows = [{ info: { id: userID, sessionID, role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model' }, time: { created: now } },
    parts: [{ id: `prt_${now.toString(16)}001user`, sessionID, messageID: userID, type: 'text', text: 'Index the disposable fixture.' }] }, assistant];
  return { sessionID, userID, assistantID, tool, assistant, rows };
}

// Real UI/HTTP/SSE, fed the actual pool error from a deliberately silent worker.
// General composer Stop/abort acceptance runs before this scenario in run.mjs;
// real toolCtx cancellation/process cleanup is covered by the Bun worker check.
export async function runContextModeQa({ fixture, cdp, directory, check, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const scene = createContextModeScene(directory);
  const events = [];
  const messages = [];
  class SilentWorker extends EventEmitter {
    postMessage(message) { messages.push(message); }
    async terminate() { this.emit('exit', 0); }
  }
  const pool = new ContextModeWorkerPool({ WorkerClass: SilentWorker, executionTimeoutMs: 5000,
    cleanupTimeoutMs: 100, onEvent: (event) => events.push(event) });
  const beforePrompts = fixture.getState().receivedPrompts.length;
  const replay = (status = 'busy') => fixture.replayRecoveryVisual({ sessionID: scene.sessionID, rows: scene.rows, status });
  const messageSelector = `[data-message-id="${scene.assistantID}"]`;
  const expandError = async () => {
    const shown = await evaluate(cdp, `document.querySelector('${messageSelector}')?.innerText.includes('Execution outcome is unknown')`);
    if (!shown) await ui.click({ selector: `${messageSelector} [role="button"]`, text: 'Context Mode: Index', exact: false });
    await ui.waitVisibleText('Execution outcome is unknown', messageSelector);
  };
  try {
    replay();
    await ui.reload();
    await check('context-mode running state keeps Stop available', async () => {
      await ui.waitVisibleText('Using Context Mode: Index');
      assert.ok(await evaluate(cdp, `Boolean(document.querySelector('button[aria-label="Stop Generating"]:not(:disabled)'))`));
      await screenshot('context-mode-running');
    });
    const execution = pool.execute({ name: 'ctx_index', args: scene.tool.state.input, projectDir: directory,
      sessionId: scene.sessionID, callId: scene.tool.callID, messageId: scene.assistantID, env: {} });
    const error = await execution.then(() => { throw new Error('Silent worker unexpectedly completed'); }, (error) => error);
    scene.tool.state = { ...scene.tool.state, status: 'error', error: error.message, time: { start: scene.tool.state.time.start, end: Date.now() } };
    replay();
    await check('context-mode timeout replaces activity with an actionable error', async () => {
      await ui.waitExpression('Context Mode activity cleared', `!document.body.innerText.includes('Using Context Mode: Index')`);
      await expandError();
      await screenshot('context-mode-timeout');
    });
    scene.assistant.info.time.completed = Date.now();
    scene.assistant.info.finish = 'stop';
    scene.assistant.parts.push({ id: `${scene.tool.id}_fallback`, sessionID: scene.sessionID, messageID: scene.assistantID,
      type: 'text', text: 'Context Mode is unavailable. Use permitted native read/search tools and inspect current state before retrying.' });
    replay('idle');
    await check('context-mode timeout survives reconnect without replay or stale activity', async () => {
      fixture.disconnectEvents();
      await ui.reload();
      await expandError();
      await ui.waitExpression('idle composer restored', `Boolean(document.querySelector('button[aria-label="Send Message"]')) && !document.querySelector('button[aria-label="Stop Generating"]')`);
      assert.equal(fixture.getState().receivedPrompts.length, beforePrompts);
      assert.equal(messages.filter(message => message.type === 'execute').length, 1);
      await screenshot('context-mode-reopened');
    });
    return { liveProvider: false, worker: 'silent injected worker, production pool', errorCode: error.code,
      events, dispatchCount: messages.filter(message => message.type === 'execute').length,
      timeoutVisible: true, stopAvailable: true, reconnectWithoutReplay: true };
  } finally { await pool.close(); }
}
