import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';

export async function runExecutionFailureQa({ fixture, cdp, directory, check, screenshot, skillOnly = false }) {
  const ui = createQaUiDriver(cdp);
  const origin = await evaluate(cdp, 'location.origin');
  const text = (sessionID, messageID, value) => ({ id: `prt_${messageID}`, sessionID, messageID, type: 'text', text: value });
  const user = (sessionID, id, created, parts) => ({ info: { id, sessionID, role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model' }, time: { created } }, parts });
  const assistant = (sessionID, id, parentID, created, parts) => ({ info: { id, sessionID, parentID, role: 'assistant', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created } }, parts });
    if (!skillOnly) await check('session failure without assistant is visible after idle and survives reload', async () => {
      const response = await fetch(`${fixture.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Local execution failure fixture' }) });
      assert.equal(response.status, 200);
      const session = await response.json();
      const userId = `msg_qa_failure_${Date.now()}`;
      fixture.replayRecoveryVisual({ sessionID: session.id, rows: [user(session.id, userId, Date.now(), [text(session.id, userId, 'Read the fixture file')])] });
      await cdp.send('Page.navigate', { url: `${origin}/?session=${session.id}` });
      await ui.waitVisibleText('Read the fixture file');
      fixture.replaySessionFailure(session.id);
      await ui.waitVisibleText('The workspace was not ready before the startup deadline.');
      await screenshot('local-execution-failure');
      await ui.reload();
      // Notification persistence intentionally restores the bounded classification.
      await ui.waitVisibleText('Local tool execution could not start or finish.');
      await screenshot('local-execution-failure-reloaded');
      const assistantId = `${userId}_assistant`;
      const failedTools = ['grep', 'glob'].map((tool, index) => ({
        id: `prt_failure_${index}`, sessionID: session.id, messageID: assistantId,
        type: 'tool', tool, callID: `call_failure_${index}`,
        state: { status: 'error', input: {}, error: 'local_execution_timeout', time: { start: Date.now() - 100, end: Date.now() } },
      }));
      fixture.replayRecoveryVisual({ sessionID: session.id, rows: [
        user(session.id, userId, Date.now() - 200, [text(session.id, userId, 'Read the fixture file')]),
        assistant(session.id, assistantId, userId, Date.now() - 100, failedTools, false),
      ] });
      // This label intentionally uses opacity-85 and an animated count split
      // across text nodes; the generic text-node/opacity-95 helper cannot read it.
      await ui.waitExpression('visible failed tool count', `(() => {
        const label = document.querySelector('[title="2 tools failed"]');
        if (!label || !label.textContent.includes('tools failed')) return false;
        const rect = label.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
          && getComputedStyle(label).visibility === 'visible' && Number(getComputedStyle(label).opacity) >= 0.8;
      })()`);
      await screenshot('local-execution-failed-tool-group');
    });
  await check('skill loading settles into a visible failure and survives reload', async () => {
    const response = await fetch(`${fixture.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Skill preparation fixture' }) });
    assert.equal(response.status, 200);
    const session = await response.json(), now = Date.now();
    const userId = `msg_skill_${now}`, assistantId = `${userId}_assistant`;
    const skill = { id: `prt_skill_${now}`, sessionID: session.id, messageID: assistantId,
      type: 'tool', tool: 'skill', callID: 'call_skill',
      state: { status: 'running', input: { name: 'Superpowers' }, time: { start: now } } };
    const rows = () => [user(session.id, userId, now - 1, [text(session.id, userId, 'Load the Superpowers skill')]),
      assistant(session.id, assistantId, userId, now, [skill])];
    const waitTitle = title => ui.waitExpression(title, `(() => {
      const row = document.querySelector('[title="${title}"]');
      return Boolean(row && row.getBoundingClientRect().height > 0);
    })()`);
    fixture.replayRecoveryVisual({ sessionID: session.id, rows: rows(), status: 'busy' });
    await cdp.send('Page.navigate', { url: `${origin}/?session=${session.id}` });
    await waitTitle('Loading skill:');
    await screenshot('skill-preparing');
    skill.state = { status: 'error', input: { name: 'Superpowers' }, error: 'local_execution_timeout', time: { start: now, end: now + 1 } };
    fixture.replayRecoveryVisual({ sessionID: session.id, rows: rows(), status: 'idle' });
    await waitTitle('Skill failed:');
    await ui.waitVisibleText('The workspace was not ready before the startup deadline.');
    await screenshot('skill-preparation-failed');
    await ui.reload();
    await waitTitle('Skill failed:');
    await ui.waitVisibleText('The workspace was not ready before the startup deadline.');
    await screenshot('skill-preparation-failed-reloaded');
    skill.state = { status: 'completed', input: { name: 'Superpowers' }, title: 'Superpowers', output: 'Fixture skill', metadata: {}, time: { start: now, end: now + 2 } };
    fixture.replayRecoveryVisual({ sessionID: session.id, rows: rows(), status: 'idle' });
    await waitTitle('Loaded skill:');
    await screenshot('skill-loaded');
  });
  return { outcome: 'passed', liveProvider: false };
}
