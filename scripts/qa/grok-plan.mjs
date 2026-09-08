import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';

const cardSelector = '[data-plan-source-message-id]';
const chat = '[data-scrollbar="chat"]';
const preamble = 'I am checking the shared renderer before composing the plan.';
const title = 'Live Grok plan';
const markdown = `# ${title}\n\n## Context\nThe plan appears as it is composed.\n\n## Implementation\n1. Render every streamed section in the card.\n2. Preserve the first section when later parts arrive.\n\n## Verification\n1. Check web and Electron before completion.\n2. Reload the completed plan and inspect its final text.`;

export function createGrokPlanScene(directory, now) {
  const sessionID = PERF_PARENT_SESSION_ID;
  const userID = `msg_${now.toString(16)}001user`;
  const draftID = `msg_${(now + 1).toString(16)}001draft`;
  const finalID = `msg_${(now + 2).toString(16)}001final`;
  const part = (messageID, name, type, text) => ({ id: `prt_${messageID}_${name}`, sessionID, messageID, type, text,
    ...(type === 'reasoning' ? { time: { start: now } } : {}) });
  const assistant = id => ({ info: { id, sessionID, parentID: userID, role: 'assistant', agent: 'build', providerID: 'xai', modelID: 'grok-4.6',
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 10, output: 1, reasoning: 1, cache: { read: 0, write: 0 } }, time: { created: now + 1 } }, parts: [] });
  const first = part(draftID, '01', 'reasoning', `${preamble}\n`);
  const draft = assistant(draftID);
  draft.parts.push(first);
  const final = assistant(finalID);
  const rows = [{ info: { id: userID, sessionID, role: 'user', agent: 'build', mode: 'plan', model: { providerID: 'xai', modelID: 'grok-4.6' }, time: { created: now } },
    parts: [part(userID, 'request', 'text', 'Plan a streaming card improvement.'), { ...part(userID, 'policy', 'text', 'User has requested to enter plan mode.'), synthetic: true }] }, draft];
  return { sessionID, userID, draftID, finalID, draft, final, first, rows, part };
}

/** Real UI/HTTP/SSE with controlled provider-shaped deltas, never a live-provider claim. */
export async function runGrokPlanQa({ fixture, cdp, directory, dataDirectory, runtime, check, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const result = { liveProvider: false, providerId: 'xai', modelId: 'grok-4.6', renderMode: 'live', checkpoints: [], savedPlans: [] };
  const configureReasoning = async value => {
    const status = await evaluate(cdp, `fetch('/api/config/settings', {method:'PUT',headers:{'Content-Type':'application/json','X-DevRyan-CSRF':'1'},body:JSON.stringify({showReasoningTraces:${value}})}).then(r=>r.status)`);
    assert.equal(status, 200);
  };
  const readCard = () => evaluate(cdp, `(() => {
    const cards=[...document.querySelectorAll('${cardSelector}')]; const e=cards[0]; if(!e)return {count:0};
    const r=e.getBoundingClientRect();const body=e.querySelector('.oc-plan-card-text');
    const thought=[...document.querySelectorAll('[data-reasoning-group], [data-reasoning-part]')].map(e=>e.textContent).join('\\n');
    return {count:cards.length,source:e.dataset.planSourceMessageId,state:e.dataset.planState,text:body?.textContent??'',streaming:body?.dataset.streaming==='true',
      canImplement:[...e.querySelectorAll('button')].some(b=>b.textContent==='Implement Plan'&&!b.disabled),thought,
      bounds:{left:r.left,right:r.right,width:r.width,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1}};
  })()`);
  const assertCard = async ({ label, contains, source, streaming = true, actionable = false }) => {
    await ui.waitExpression(label, `(() => {const e=document.querySelector('${cardSelector}');const body=e?.querySelector('.oc-plan-card-text');
      return body?.textContent.includes(${JSON.stringify(contains)})&&e.dataset.planSourceMessageId===${JSON.stringify(source)}
        &&(body.dataset.streaming==='true')===${streaming}
        &&[...e.querySelectorAll('button')].some(b=>b.textContent==='Implement Plan'&&!b.disabled)===${actionable};})()`);
    const state = await readCard();
    assert.equal(state.count, 1);
    assert.equal(state.source, source);
    assert.equal(state.streaming, streaming, `${label}: streaming state`);
    assert.equal(state.canImplement, actionable, `${label}: implementation state`);
    assert.doesNotMatch(state.thought, /Live Grok plan|Render every streamed section|Check web and Electron/);
    assert.ok(state.bounds.width > 0 && state.bounds.left >= -1 && state.bounds.right <= state.bounds.viewport + 1 && !state.bounds.overflow, JSON.stringify(state.bounds));
    result.checkpoints.push({ label, source, characters: state.text.length, streaming: state.streaming, canImplement: state.canImplement });
    return state;
  };
  const capture = async name => {
    await ui.reveal(cardSelector, undefined, { scrollContainer: chat, direction: 'down' });
    await screenshot(name);
  };
  const restoreChat = async () => {
    if (await evaluate(cdp, `Boolean(document.querySelector('button[aria-label="Close Plan"]')?.getBoundingClientRect().width)`)) {
      await ui.click({ label: 'Close Plan' });
    }
  };
  const startHandoffProbe = async () => evaluate(cdp, `(() => {
    const probe={active:true,frames:0,failures:[],maxScrollDelta:0,lastScrollTop:null};window.__grokPlanHandoff=probe;
    const sample=()=>{if(!probe.active)return;const cards=[...document.querySelectorAll('${cardSelector}')];
      const lengths=cards.map(e=>e.querySelector('.oc-plan-card-text')?.textContent.length??0);
      const scrollTop=document.querySelector('${chat}')?.scrollTop??0;
      if(probe.lastScrollTop!==null)probe.maxScrollDelta=Math.max(probe.maxScrollDelta,Math.abs(scrollTop-probe.lastScrollTop));probe.lastScrollTop=scrollTop;
      probe.frames++;if(cards.length!==1||!lengths[0]){if(probe.failures.length<20)probe.failures.push({count:cards.length,lengths});}
      requestAnimationFrame(sample);};requestAnimationFrame(sample);
    return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  const finishHandoffProbe = async () => {
    const probe = await evaluate(cdp, `(async () => {await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const p=window.__grokPlanHandoff;p.active=false;return {frames:p.frames,failures:p.failures,maxScrollDelta:p.maxScrollDelta};})()`);
    assert.ok(probe.frames >= 2);
    assert.deepEqual(probe.failures, [], 'handoff must not paint a blank or duplicate card');
    return probe;
  };
  let sequence = Date.now();
  for (const theme of ['light', 'dark']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const narrow of [false, true]) {
      const width = narrow ? (runtime === 'electron' ? 600 : 390) : 1280;
      const name = `grok-${theme}-${width}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: narrow ? 844 : 800, deviceScaleFactor: 1, mobile: narrow && runtime === 'web' });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: narrow && runtime === 'web' });
      await configureReasoning(true);
      const scene = createGrokPlanScene(directory, sequence += 100);
      const replay = (status = 'busy') => fixture.replayRecoveryVisual({ sessionID: scene.sessionID, rows: scene.rows, status });
      const delta = (part, value) => {
        part.text += value;
        fixture.appendVisualPartDelta({ sessionID: scene.sessionID, messageID: part.messageID, partID: part.id, delta: value });
      };
      replay();
      await ui.reload();
      await restoreChat();
      await check(`${name}: card grows before reasoning and turn completion`, async () => {
        assert.equal(await evaluate(cdp, `document.documentElement.classList.contains('dark')`), theme === 'dark');
        await ui.waitExpression('live reasoning disclosure', `Boolean(document.querySelector('[data-reasoning-group] button'))`);
        const disclosure = '[data-reasoning-group] button';
        await ui.reveal(disclosure, undefined, { scrollContainer: chat });
        if (await evaluate(cdp, `document.querySelector('${disclosure}')?.getAttribute('aria-expanded')!=='true'`)) {
          await ui.click({ selector: disclosure, touch: narrow && runtime === 'web' });
        }
        await ui.waitVisibleText(preamble);
        assert.equal((await readCard()).count, 0);
        delta(scene.first, '<!--pl');
        const second = scene.part(scene.draftID, '02', 'reasoning', 'an-->\n');
        scene.draft.parts.push(second);
        replay();
        delta(second, `# ${title}`);
        const first = await assertCard({ label: `${name} first tokens`, contains: title, source: scene.draftID });
        await capture(`${name}-first-tokens`);
        delta(second, '\n\n## Context\nThe plan appears as it is composed.');
        const context = await assertCard({ label: `${name} context`, contains: 'The plan appears as it is composed.', source: scene.draftID });
        assert.ok(context.text.length > first.text.length);
        const third = scene.part(scene.draftID, '03', 'reasoning', '');
        scene.draft.parts.push(third);
        replay();
        delta(third, '## Implementation\n1. Render every streamed section in the card.');
        const implementation = await assertCard({ label: `${name} implementation`, contains: 'Render every streamed section', source: scene.draftID });
        assert.ok(implementation.text.length > context.text.length);
        assert.match(implementation.text, /Live Grok plan/);
        await capture(`${name}-streaming`);
      });
      await check(`${name}: hidden reasoning and reload preserve the live card`, async () => {
        const rows = await fetch(`${fixture.origin}/session/${scene.sessionID}/message`).then(response => response.json());
        assert.deepEqual(rows.find(row => row.info.id === scene.draftID)?.parts, scene.draft.parts, 'reloaded fixture data must retain every delta');
        await configureReasoning(false);
        await ui.reload();
        await restoreChat();
        await assertCard({ label: `${name} hidden reasoning`, contains: 'Render every streamed section', source: scene.draftID });
        assert.equal(await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(preamble)})`), false);
        const tail = scene.part(scene.draftID, '04', 'text', '## Verification\n1. Check web and Electron before completion.');
        scene.draft.parts.push(tail);
        replay();
        await assertCard({ label: `${name} channel continuation`, contains: 'Check web and Electron before completion.', source: scene.draftID });
        await capture(`${name}-hidden`);
      });
      await check(`${name}: final text replaces the draft and saves only on idle`, async () => {
        scene.draft.info.time.completed = Date.now();
        scene.draft.info.finish = 'tool-calls';
        for (const part of scene.draft.parts) if (part.type === 'reasoning') part.time.end = Date.now();
        // A tool-call completion before the next assistant starts is still busy.
        replay();
        await assertCard({ label: `${name} tool boundary`, contains: title, source: scene.draftID, streaming: false });
        const finalText = scene.part(scene.finalID, '01', 'text', '<!--plan-->\n');
        scene.final.parts.push(finalText);
        scene.rows.push(scene.final);
        replay();
        await assertCard({ label: `${name} pending final marker`, contains: title, source: scene.draftID, streaming: false });
        await startHandoffProbe();
        delta(finalText, markdown);
        await assertCard({ label: `${name} final handoff`, contains: 'Reload the completed plan', source: scene.finalID });
        result.checkpoints.push({ label: `${name} handoff frames`, ...await finishHandoffProbe() });
        await capture(`${name}-final-streaming`);
        const draftFiles = (await readdir(dataDirectory, { recursive: true })).filter(file => file.endsWith(`${scene.draftID}.md`));
        assert.equal(draftFiles.length, 0, 'busy reasoning drafts must not be saved');
        scene.final.info.time.completed = Date.now();
        scene.final.info.finish = 'stop';
        replay('idle');
        await ui.waitExpression('saved final plan action', `document.querySelector('${cardSelector}')?.dataset.planState==='actionable'`);
        await assertCard({ label: `${name} completed`, contains: 'Reload the completed plan', source: scene.finalID, streaming: false, actionable: true });
        const files = (await readdir(dataDirectory, { recursive: true })).filter(file => file.endsWith(`${scene.finalID}.md`));
        assert.equal(files.length, 1);
        assert.equal(await readFile(path.join(dataDirectory, files[0]), 'utf8'), markdown);
        result.savedPlans.push({ source: scene.finalID, markdownMatches: true });
        if (narrow && runtime === 'web') {
          await ui.waitExpression('mobile saved plan reader', `(document.querySelector('button[aria-label="Close Plan"]')?.getBoundingClientRect().width??0)>0`);
        }
        await restoreChat();
        await capture(`${name}-completed`);
        const expand = `${cardSelector} button[aria-label="Expand Plan"]`;
        if (await evaluate(cdp, `Boolean(document.querySelector('${expand}'))`)) {
          await ui.reveal(expand, undefined, { scrollContainer: chat });
          await ui.click({ selector: expand, touch: narrow && runtime === 'web' });
          await ui.waitExpression('expanded plan', `document.querySelector('${cardSelector} .oc-plan-card-body')?.getAttribute('aria-expanded')==='true'`);
          await ui.revealText('Reload the completed plan', cardSelector, { scrollContainer: chat, direction: 'down' });
          await screenshot(`${name}-expanded`);
          if (narrow && runtime === 'electron') {
            await ui.reveal(`${cardSelector} button`, 'Implement Plan', { scrollContainer: chat, direction: 'down', fullyVisible: true });
            await screenshot(`${name}-action`);
          }
        }
        await ui.reload();
        await ui.waitExpression('actionable card after reload', `document.querySelector('${cardSelector}')?.dataset.planState==='actionable'`);
        await assertCard({ label: `${name} reloaded final`, contains: 'Reload the completed plan', source: scene.finalID, streaming: false, actionable: true });
        if (narrow && runtime === 'web') {
          await ui.waitExpression('mobile reloaded plan reader', `(document.querySelector('button[aria-label="Close Plan"]')?.getBoundingClientRect().width??0)>0`);
        }
        await restoreChat();
        await capture(`${name}-reloaded`);
      });
    }
  }
  await check('aborted reasoning plan stays visible without saving or enabling implementation', async () => {
    const scene = createGrokPlanScene(directory, sequence += 100);
    scene.first.text += '<!--plan-->\n# Cancelled draft\n## Context\nThis response was interrupted.';
    scene.draft.info.error = { name: 'MessageAbortedError', data: { message: 'The user aborted the request.' } };
    scene.draft.info.time.completed = Date.now();
    scene.first.time.end = Date.now();
    fixture.replayRecoveryVisual({ sessionID: scene.sessionID, rows: scene.rows, status: 'idle' });
    await ui.reload();
    await restoreChat();
    await assertCard({ label: 'aborted draft', contains: 'Cancelled draft', source: scene.draftID, streaming: false });
    assert.equal((await readdir(dataDirectory, { recursive: true })).filter(file => file.endsWith(`${scene.draftID}.md`)).length, 0);
    await capture('grok-cancelled-draft');
  });
  return result;
}
