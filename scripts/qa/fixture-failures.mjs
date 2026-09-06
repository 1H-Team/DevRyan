import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rowSelector = id => `[data-message-id=${JSON.stringify(id)}]`;

export async function revealQaFixtureTool({ cdp, ui, assistant, expectedText }) {
  const selector = rowSelector(assistant.info.id);
  if (await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(selector + ' button[aria-expanded="false"]')}))`)) {
    await ui.reveal(selector + ' button[aria-expanded="false"]', undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
    await ui.click({ selector: selector + ' button[aria-expanded="false"]' });
  }
  if (!await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(expectedText)})`)) {
    await ui.waitExpression('focusable fixture tool disclosure', `(() => {
      const e=[...document.querySelectorAll(${JSON.stringify(selector + ' [role="button"]')})].find(item=>item.innerText.includes('npm test'));
      if(!e)return false;e.focus();return document.activeElement===e;
    })()`);
    await ui.key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await ui.revealText(expectedText, selector, { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
}

export async function runQaFixtureFailureRecovery({ cell, fixture, cdp, ui, api, check, screenshot,
  sessionID, directory, send, idle, latestAssistant }) {
  assert.equal(cell.transport, 'fixture', 'Deterministic failure controls require fixture transport');
  const evidence = { source: 'deterministic UI/HTTP/SSE fixture; no native scheduler or provider acceptance' };
  const rows = () => api(`/api/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`);
  await check('permission denial clears the exact request and a fresh send recovers', async () => {
    fixture.configureNextPrompt(sessionID, { hold: true, tool: 'completed', chunks: 2, intervalMs: 100 });
    const sent = await send('QA deny the fixture permission and preserve the request identity.');
    const requestID = fixture.askPermission(sessionID);
    await ui.waitVisibleText('Deny');
    await screenshot('fixture-permission-denial-pending');
    await ui.click({ text: 'Deny' });
    await ui.waitFor('exact rejected permission reply', () => fixture.getState().replies.some(reply => reply.requestID === requestID && reply.reply === 'reject'));
    await idle(sessionID);
    const assistant = await latestAssistant(sessionID);
    assert.equal(assistant.info.parentID, sent.messageID);
    assert.equal(assistant.parts.find(part => part.type === 'tool')?.state.status, 'error');
    assert.equal(fixture.getState().permissionCount, 0);
    await revealQaFixtureTool({ cdp, ui, assistant, expectedText: 'Tool cancelled' });
    await screenshot('fixture-permission-denied');
    const recovered = await send('QA successful follow-up after denying the fixture permission.'); await idle(sessionID);
    const recoveredAssistant = await latestAssistant(sessionID);
    await ui.reload();
    await ui.waitExpression('permission recovery canonical turn restored once', `document.querySelectorAll(${JSON.stringify(rowSelector(recovered.messageID))}).length===1`);
    await ui.waitVisibleText('QA response chunk 1.', rowSelector(recoveredAssistant.info.id));
    const saved = await rows();
    assert.equal(saved.filter(row => row.info.id === sent.messageID).length, 1);
    assert.equal(saved.filter(row => row.info.id === recovered.messageID).length, 1);
    evidence.permissionDenial = { requestID, userMessageID: sent.messageID, assistantMessageID: assistant.info.id,
      toolCallID: assistant.parts.find(part => part.type === 'tool').callID, reply: 'reject', recoveredMessageID: recovered.messageID };
    await screenshot('fixture-permission-recovered');
  });
  await check('failed tool output is keyboard-readable and a follow-up succeeds', async () => {
    fixture.configureNextPrompt(sessionID, { tool: 'error', chunks: 2, intervalMs: 100 });
    const sent = await send('QA render a native-shaped failed tool response.'); await idle(sessionID);
    const assistant = await latestAssistant(sessionID);
    assert.equal(assistant.info.parentID, sent.messageID);
    const tool = assistant.parts.find(part => part.type === 'tool');
    assert.equal(tool.state.status, 'error');
    await revealQaFixtureTool({ cdp, ui, assistant, expectedText: 'Fixture test failure' });
    await screenshot('fixture-tool-failed');
    fixture.configureNextPrompt(sessionID, { tool: 'completed', chunks: 2, intervalMs: 100 });
    const recovered = await send('QA recover from the failed fixture tool with a completed tool.'); await idle(sessionID);
    const final = await latestAssistant(sessionID);
    assert.equal(final.info.parentID, recovered.messageID);
    assert.equal(final.parts.find(part => part.type === 'tool').state.status, 'completed');
    await revealQaFixtureTool({ cdp, ui, assistant: final, expectedText: 'Fixture tests passed.' });
    evidence.toolFailure = { userMessageID: sent.messageID, assistantMessageID: assistant.info.id, toolCallID: tool.callID,
      recoveredMessageID: recovered.messageID, recoveredAssistantMessageID: final.info.id };
    await screenshot('fixture-tool-recovered');
  });
  await check('missing message and idle events recover from canonical snapshots after reconnect', async () => {
    fixture.configureNextPrompt(sessionID, { chunks: 8, intervalMs: 400 });
    const sent = await send('QA recover the missing tail of this exact turn from canonical snapshots.');
    const assistant = await latestAssistant(sessionID);
    const selector = rowSelector(assistant.info.id);
    await ui.waitExpression('first visible chunk before suppressing events', `document.querySelector(${JSON.stringify(selector)})?.innerText.includes('QA response chunk 1.')`);
    assert.equal(assistant.info.parentID, sent.messageID);
    fixture.suppressMessageEvents({ sessionID, messageID: assistant.info.id,
      types: ['message.part.delta', 'message.part.updated', 'message.updated', 'session.status'], maximumEvents: 64, durationMs: 15000 });
    try {
      await ui.waitFor('fixture canonical prompt completion without delivery', () => fixture.getState().activePrompts === 0);
      const canonical = (await rows()).find(row => row.info.id === assistant.info.id);
      const status = await api(`/api/session/status?directory=${encodeURIComponent(directory)}`);
      const text = canonical.parts.find(part => part.type === 'text').text.trim();
      assert.ok(canonical.info.time.completed && text.includes('QA response chunk 8.'));
      assert.equal(status[sessionID].type, 'idle');
      const stale = await evaluate(cdp, `({ text:document.querySelector(${JSON.stringify(selector)})?.innerText ?? '',
        stopVisible:[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop Generating'&&!e.disabled) })`);
      assert.ok(!stale.text.includes('QA response chunk 8.') && stale.stopVisible, 'The missing-event state must exist before recovery is triggered');
      await screenshot('fixture-missing-events-before-recovery');
      fixture.clearMessageEventSuppression();
      const before = fixture.getState();
      const skipped = before.suppressedEvents.filter(event => event.sessionID === sessionID);
      assert.ok(['message.part.delta', 'message.part.updated', 'message.updated', 'session.status'].every(type => skipped.some(event => event.type === type)));
      assert.equal(before.suppressionRuns.at(-1).endedReason, 'explicit-clear', 'Recovery must precede the suppression bound');
      fixture.disconnectEvents();
      await ui.waitExpression('full missed text restored from the reconnect snapshot', `document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(text)})`);
      await ui.waitExpression('idle restored from the reconnect snapshot', `![...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop Generating'&&!e.disabled)`);
      await ui.waitFor('production reconnect fetched both canonical snapshots', () => {
        const after = fixture.getState();
        return after.sseConnectionCount > before.sseConnectionCount && after.statusRequestCount > before.statusRequestCount
          && after.messageRequestCounts[sessionID] > before.messageRequestCounts[sessionID];
      });
      const after = fixture.getState();
      assert.equal(after.receivedPrompts.length, before.receivedPrompts.length);
      assert.equal(await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(rowSelector(sent.messageID))}).length`), 1);
      assert.equal(await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`), 1);
      evidence.missingEvents = { userMessageID: sent.messageID, assistantMessageID: assistant.info.id, skipped,
        canonicalBeforeReconnect: { completedAt: canonical.info.time.completed, status: 'idle', text },
        recovery: 'explicit SSE disconnect followed by production reconnect snapshot resync',
        beforeCounts: { sse: before.sseConnectionCount, status: before.statusRequestCount, messages: before.messageRequestCounts[sessionID], prompts: before.receivedPrompts.length },
        afterCounts: { sse: after.sseConnectionCount, status: after.statusRequestCount, messages: after.messageRequestCounts[sessionID], prompts: after.receivedPrompts.length } };
      await screenshot('fixture-missing-events-recovered');
    } finally { fixture.clearMessageEventSuppression(); }
  });
  await check('a documented ten-second idle interval permits reconnect and a new send', async () => {
    const before = fixture.getState();
    const startedAt = Date.now();
    await pause(10000);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 10000);
    assert.equal(fixture.getState().receivedPrompts.length, before.receivedPrompts.length);
    fixture.disconnectEvents();
    await ui.waitFor('connection restored after bounded idle', () => fixture.getState().sseConnectionCount > before.sseConnectionCount);
    const sent = await send('QA new turn after a bounded ten-second idle and reconnect.'); await idle(sessionID);
    const assistant = await latestAssistant(sessionID);
    assert.equal(assistant.info.parentID, sent.messageID);
    assert.ok(assistant.info.time.completed);
    evidence.boundedIdle = { requestedMs: 10000, elapsedMs, startedAt, userMessageID: sent.messageID,
      assistantMessageID: assistant.info.id, scope: 'bounded idle only; operating-system sleep and long idle are not tested' };
    await screenshot('fixture-bounded-idle-recovered');
  });
  return evidence;
}
