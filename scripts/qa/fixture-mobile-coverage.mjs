import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { revealQaFixtureTool } from './fixture-failures.mjs';
import { createQaManagedTaskReadModel, installQaManagedTaskReadModel } from './fixture-managed-tasks.mjs';
import { PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const row = id => `[data-message-id=${JSON.stringify(id)}]`;
const chat = '[data-scrollbar="chat"]';

const sidebarTargetsExpression = sessionID => `(() => {
  const row=document.querySelector(${JSON.stringify(`[data-session-row="${sessionID}"]`)}),title=row?.querySelector('span.truncate');
  if(!title)return null;
  const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const bounds=rect(title),titleButton=title.closest('button'),glyphs=[],walker=document.createTreeWalker(title,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node&&glyphs.length<2;node=walker.nextNode())for(let i=0;i<node.textContent.length&&glyphs.length<2;i++) {
    if(!node.textContent[i].trim())continue;
    const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();
    const left=Math.max(0,bounds.left,r.left),right=Math.min(innerWidth,bounds.right,r.right),top=Math.max(0,bounds.top,r.top),bottom=Math.min(innerHeight,bounds.bottom,r.bottom);
    if(right<=left||bottom<=top)continue;
    const point={x:(left+right)/2,y:(top+bottom)/2},hit=document.elementFromPoint(point.x,point.y);
    glyphs.push({character:node.textContent[i],left,right,top,bottom,point,hit:!!hit&&titleButton.contains(hit),coveringControl:hit?.closest('button,[role="button"]')?.getAttribute('aria-label')??null});
  }
  const buttons=[...row.querySelectorAll('button[aria-label]')].filter(button=>/pin|archive/i.test(button.getAttribute('aria-label'))&&!button.disabled);
  return {coarse:matchMedia('(pointer:coarse)').matches,fine:matchMedia('(pointer:fine)').matches,row:rect(row),title:bounds,titleText:title.innerText,glyphs,
    leadingControl:[...row.querySelectorAll('button[aria-label]')].filter(button=>/subsessions/i.test(button.getAttribute('aria-label'))).map(button=>({label:button.getAttribute('aria-label'),...rect(button)})),
    hiddenTriggers:[...row.querySelectorAll('[data-slot="dropdown-menu-trigger"]')].map(e=>({tag:e.tagName,role:e.getAttribute('role'),...rect(e)})),
    actions:buttons.map(button=>{const bounds=rect(button);let visible=true;for(let p=button;p&&p!==row;p=p.parentElement)if(Number(getComputedStyle(p).opacity)<0.99)visible=false;return{label:button.getAttribute('aria-label'),...bounds,visible,hit:button.contains(document.elementFromPoint((bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2))};})};
})()`;

async function captureSidebarTargets({ cdp, ui, sessionID, pointer }) {
  const expression = sidebarTargetsExpression(sessionID);
  let previous;const started = performance.now();
  const settled = await ui.waitFor(`landscape ${pointer} row geometry settled`, async () => {
    const current = await evaluate(cdp, expression);
    const stable = current?.[pointer] && previous && JSON.stringify(previous) === JSON.stringify(current)
      && performance.now() - started >= 300;
    previous = current;return stable ? current : false;
  });
  if (pointer === 'fine') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
    x: (settled.row.left + settled.row.right) / 2, y: (settled.row.top + settled.row.bottom) / 2 });
  previous = null;
  return ui.waitFor('landscape quick actions and title bounds settled', async () => {
    const current = await evaluate(cdp, expression);
    if (!current || current.actions.length !== 2 || current.actions.some(action => !action.visible)) return false;
    const stable = previous && JSON.stringify(previous) === JSON.stringify(current);
    previous = current;return stable ? current : false;
  });
}

export async function captureQaFixtureLandscapeHover({ cdp, ui, sessionID }) {
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  return captureSidebarTargets({ cdp, ui, sessionID, pointer: 'fine' });
}

const assertSidebarTargets = (targets, minimum) => {
  assert.ok(targets.actions.every(action => action.hit && action.width >= minimum && action.height >= minimum), 'Sidebar quick actions must keep their native pointer targets');
  assert.ok(targets.title.right <= Math.min(...targets.actions.map(action => action.left)) + 1, 'Sidebar quick actions must not overlap the clipped title');
  assert.equal(targets.glyphs.length, 2, 'The first two visible title characters must be measurable');
  assert.ok(targets.glyphs.every(glyph => glyph.hit), 'Visible title characters must hit the title button, including beside the leading chevron');
  assert.ok(targets.hiddenTriggers.every(trigger => trigger.width <= 1 && trigger.height <= 1), 'Hidden menu anchors must not occupy touch-target space');
  if (targets.coarse) assert.ok(targets.leadingControl.every(control => control.width >= 36 && control.height >= 36), 'Coarse leading controls must preserve their touch target');
};

const projectHeaderExpression = `(() => {
  const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const visible=e=>{const r=rect(e);if(r.width<=0||r.height<=0||r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<0.99)return false;}return true;};
  const header=[...document.querySelectorAll('[data-project-header]')].find(e=>{
    const title=e.querySelector('button[aria-expanded] span.truncate');if(title?.innerText!=='QA workspace'||!visible(e))return false;
    const r=rect(e),hit=document.elementFromPoint(r.left+2,(r.top+r.bottom)/2);return !!hit&&e.contains(hit);
  });
  const title=header?.querySelector('button[aria-expanded] span.truncate');if(!title)return null;
  const titleButton=title.closest('button'),bounds=rect(title),glyphs=[],walker=document.createTreeWalker(title,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode())for(let i=0;i<node.textContent.length;i++) {
    if(!node.textContent[i].trim())continue;
    const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();
    const left=Math.max(0,bounds.left,r.left),right=Math.min(innerWidth,bounds.right,r.right),top=Math.max(0,bounds.top,r.top),bottom=Math.min(innerHeight,bounds.bottom,r.bottom);
    if(right<=left||bottom<=top)continue;
    const point={x:(left+right)/2,y:(top+bottom)/2},hit=document.elementFromPoint(point.x,point.y);
    glyphs.push({character:node.textContent[i],left,right,top,bottom,point,hit:!!hit&&titleButton.contains(hit),coveringControl:hit?.closest('button,[role="button"]')?.getAttribute('aria-label')??null});
  }
  const actions=[...header.querySelectorAll('button[aria-label]')].filter(visible).map(button=>{
    const bounds=rect(button),point={x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2},hit=document.elementFromPoint(point.x,point.y);
    return{label:button.getAttribute('aria-label'),...bounds,point,disabled:button.disabled,hit:!!hit&&button.contains(hit)};
  }).sort((a,b)=>a.left-b.left);
  return{coarse:matchMedia('(pointer:coarse)').matches,viewport:{width:innerWidth,height:innerHeight},header:rect(header),title:bounds,titleText:title.innerText,glyphs,actions,expanded:titleButton.getAttribute('aria-expanded')};
})()`;

export function assertQaFixtureProjectHeaderTargets(targets) {
  assert.equal(targets.coarse, true, 'Project header coverage must use the actual coarse-pointer layout');
  assert.deepEqual(targets.actions.map(action => action.label).sort(), ['New Draft Session', 'New Worktree', 'Project Menu']);
  assert.ok(targets.actions.every(action => !action.disabled && action.hit && action.width >= 36 && action.height >= 36),
    'Visible project actions must preserve their native 36px touch targets');
  assert.ok(targets.title.right <= Math.min(...targets.actions.map(action => action.left)),
    'Project actions must not overlap the clipped workspace title');
  assert.ok(targets.glyphs.length >= 2 && targets.glyphs.every(glyph => glyph.hit),
    'Every visible workspace-title glyph must hit its title button');
  for (let index = 0; index < targets.actions.length; index += 1) {
    for (const other of targets.actions.slice(index + 1)) {
      const action = targets.actions[index];
      const overlapWidth = Math.min(action.right, other.right) - Math.max(action.left, other.left);
      const overlapHeight = Math.min(action.bottom, other.bottom) - Math.max(action.top, other.top);
      assert.ok(overlapWidth <= 0 || overlapHeight <= 0, `${action.label} and ${other.label} must not overlap`);
    }
  }
}

export async function verifyQaFixtureProjectHeader({ cdp, ui, screenshot, prefix, drawer, outputEvidence = {} }) {
  const evidence = Object.assign(outputEvidence, { source: 'actual coarse project header, clipped glyph hit ownership and trusted native Project Menu activation', drawer });
  let openedDrawer = false;
  try {
    if (drawer) {
      await ui.click({ label: 'Open Sessions', touch: true });openedDrawer = true;
      await ui.waitExpression('native Sessions drawer open for project header', `Boolean(document.querySelector('button[aria-label="Close Sessions"]'))`);
    }
    let previous;const started = performance.now();
    evidence.targets = await ui.waitFor('coarse project header geometry settled', async () => {
      const current = await evaluate(cdp, projectHeaderExpression);
      const stable = current?.coarse && previous && JSON.stringify(previous) === JSON.stringify(current)
        && performance.now() - started >= 400;
      previous = current;return stable ? current : false;
    });
    await screenshot(prefix + '-project-header-coarse');
    assertQaFixtureProjectHeaderTargets(evidence.targets);
    const stateExpression = `(() => {
      const visible=e=>{const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<0.99)return false;}return true;};
      return{sessionID:new URL(location.href).searchParams.get('session'),composer:document.querySelector('textarea')?.value,
        drawerOpen:!!document.querySelector('button[aria-label="Close Sessions"]'),
        dialogs:[...document.querySelectorAll('[role="dialog"]')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),text:e.innerText.slice(0,200)}))};
    })()`;
    evidence.beforeMenu = await evaluate(cdp, stateExpression);
    await evaluate(cdp, `(() => {
      window.__qaProjectHeaderClicks=[];
      window.__qaProjectHeaderClickListener=e=>{const button=e.target.closest?.('button');if(button?.closest('[data-project-header]'))window.__qaProjectHeaderClicks.push({label:button.getAttribute('aria-label'),trusted:e.isTrusted});};
      document.addEventListener('click',window.__qaProjectHeaderClickListener,true);
    })()`);
    try {
      await ui.click({ selector: '[data-project-header] button[aria-label="Project Menu"]', touch: true });
      evidence.menu = await ui.waitExpression('actual workspace Project Menu open', `(() => {
        const e=[...document.querySelectorAll('[role="menu"]')].find(e=>e.getBoundingClientRect().width>0&&e.innerText.includes('Rename')&&e.innerText.includes('Close Project'));
        if(!e||e.getAnimations({subtree:true}).some(a=>a.playState==='running'))return null;const r=e.getBoundingClientRect();
        return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,text:e.innerText};
      })()`);
      const { width, height } = evidence.targets.viewport;
      assert.ok(evidence.menu.left >= 0 && evidence.menu.right <= width && evidence.menu.top >= 0 && evidence.menu.bottom <= height,
        'Project Menu must stay inside the viewport');
      await screenshot(prefix + '-project-menu-open');
      await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
      await ui.waitExpression('Project Menu closes on Escape', `![...document.querySelectorAll('[role="menu"]')].some(e=>e.getBoundingClientRect().width>0)`);
      await pause(300);
      evidence.afterMenu = await evaluate(cdp, stateExpression);
      evidence.clicks = await evaluate(cdp, 'window.__qaProjectHeaderClicks');
      assert.deepEqual(evidence.clicks, [{ label: 'Project Menu', trusted: true }], 'Only the intended project action may receive the native click');
      assert.deepEqual(evidence.afterMenu, evidence.beforeMenu, 'Project Menu must not create a draft, open another dialog or close the Sessions drawer');
      const after = await evaluate(cdp, projectHeaderExpression);
      assert.equal(after?.expanded, evidence.targets.expanded, 'Project Menu must not toggle the project header');
      await screenshot(prefix + '-project-menu-closed');
    } finally {
      await evaluate(cdp, `(() => {document.removeEventListener('click',window.__qaProjectHeaderClickListener,true);delete window.__qaProjectHeaderClickListener;delete window.__qaProjectHeaderClicks;})()`);
    }
  } finally {
    if (openedDrawer && await evaluate(cdp, `Boolean(document.querySelector('button[aria-label="Close Sessions"]'))`)) {
      await ui.click({ label: 'Close Sessions', touch: true });
      await ui.waitExpression('native Sessions drawer closed after project header', `!document.querySelector('button[aria-label="Close Sessions"]')`);
    }
  }
  return evidence;
}

export async function runQaFixtureMobileCoverage({ cell, fixture, projectFixture, cdp, ui, api,
  check, screenshot, send, idle, latestAssistant, setPlanMode, selectSession, outputEvidence = {} }) {
  assert.ok(cell.transport === 'fixture' && cell.runtime === 'web' && cell.scenarioId === 'mobile');
  const directory = projectFixture.fixtureRoot;
  const evidence = Object.assign(outputEvidence, { source: 'actual shared mobile UI with deterministic loopback records; no scheduler execution or native mobile-device acceptance',
    viewports: [], childNavigation: [], permissions: [] });
  const requests = async (url, input) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.ok(response.ok, `Canonical fixture preparation failed: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const geometry = async () => evaluate(cdp, `(() => {
    const e=document.querySelector('textarea'),r=e?.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      dark:document.documentElement.classList.contains('dark'),composer:r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null};
  })()`);
  const capture = async (name, theme, width, height, detail = {}) => {
    const bounds = await geometry();
    assert.equal(bounds.dark, theme === 'dark');
    assert.equal(bounds.width, width);assert.equal(bounds.height, height);
    assert.ok(bounds.scrollWidth <= width + 1, 'Responsive document must not overflow horizontally');
    assert.ok(bounds.composer && bounds.composer.width > 0 && bounds.composer.height > 0
      && bounds.composer.left >= -1 && bounds.composer.right <= width + 1
      && bounds.composer.top >= -1 && bounds.composer.bottom <= height + 1, 'The composer must stay inside the viewport');
    evidence.viewports.push({ name, ...bounds, ...detail });
    await screenshot(name);
  };
  const modelButton = '[data-chat-input-footer] button[title^="Fixture model"]';
  const panel = '#mobile-overlay-root [role="dialog"]';
  const openEfforts = async () => {
    await ui.click({ selector: modelButton, touch: true });
    await ui.waitExpression('mobile effort sheet open', `Boolean(document.querySelector(${JSON.stringify(panel)}))`);
    if (await evaluate(cdp, `Boolean(document.querySelector('#mobile-overlay-root button[aria-label="Show Thinking Modes"]'))`)) {
      await ui.click({ label: 'Show Thinking Modes', touch: true });
    }
    for (const label of ['Default', 'Low', 'High']) await ui.waitVisibleText(label, '#mobile-overlay-root');
  };
  const choose = async label => {
    await openEfforts();
    await ui.click({ selector: '#mobile-overlay-root button[aria-pressed]', text: label, touch: true });
    await ui.waitExpression(`mobile ${label} selection applied`, `!document.querySelector(${JSON.stringify(panel)})&&document.querySelector(${JSON.stringify(modelButton)})?.title==='Fixture model · ${label}'`);
  };
  const mobileViewport = async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await ui.waitExpression('mobile model control mounted', `document.querySelector(${JSON.stringify(modelButton)})?.getBoundingClientRect().width>0`);
  };
  const desktopViewport = async () => {
    await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await ui.waitExpression('desktop model control mounted', `document.querySelector('.model-controls__model-trigger')?.getBoundingClientRect().width>0`);
  };
  const assertSubmittedVariant = async (submitted, variant) => {
    assert.equal(submitted.variant, variant);assert.equal(submitted.model.variant, variant);
    const rows = await api(`/api/session/${submitted.sessionID}/message?directory=${encodeURIComponent(directory)}`);
    const canonical = rows.find(row => row.info.id === submitted.messageID && row.info.role === 'user');
    assert.ok(canonical, 'Exact native submission must have a canonical user record');
    assert.equal(canonical.info.model.variant, variant);
    return { sessionID: submitted.sessionID, userMessageID: submitted.messageID,
      rawVariant: submitted.variant, submittedModelVariant: submitted.model.variant, canonicalVariant: canonical.info.model.variant };
  };
  await ui.click({ text: 'New Chat' });
  await ui.click({ selector: 'button:has(.model-controls__agent-label)' });
  await ui.click({ selector: '[role="menuitem"]', text: cell.agent === 'builder' ? 'Builder' : 'Orchestrator' });
  await ui.waitExpression('mobile fixture model selected', `document.querySelector('.model-controls__model-trigger')?.innerText.includes('Fixture model')`);
  await setPlanMode(true);
  fixture.configureNextCreatedSessionPrompt({ responseText: '<!--plan-->\n# QA mobile saved plan\n\n## Context\n\nKeep task creation order and preserve the user note.\n\n## Implementation\n\n1. Add the Priority filter.\n2. Keep the existing tasks and persistence.', chunks: 1, intervalMs: 10 });
  const planRequest = await send('QA prepare the saved plan used by the responsive visual fixture.');
  const sessionID = planRequest.sessionID;evidence.sessionID = sessionID;
  await idle(sessionID);
  const planAssistant = await latestAssistant(sessionID);
  const planSelector = `[data-plan-source-message-id=${JSON.stringify(planAssistant.info.id)}]`;
  await ui.waitExpression('mobile saved Plan card', `Boolean(document.querySelector(${JSON.stringify(planSelector)}))`);
  await api(`/api/session/${sessionID}?directory=${encodeURIComponent(directory)}`);
  await setPlanMode(false);
  fixture.configureNextPrompt(sessionID, { tool: 'completed', chunks: 1, intervalMs: 10 });
  await send('QA show the completed tool output in narrow layouts.');await idle(sessionID);
  const toolAssistant = await latestAssistant(sessionID);
  await revealQaFixtureTool({ cdp, ui, assistant: toolAssistant, expectedText: 'Fixture tests passed.' });
  await check('mobile High to Default selection submits explicit default and survives reload', async () => {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await ui.waitExpression('fresh mobile saved Plan is ready to close', `Boolean(document.querySelector('button[aria-label="Close Plan"]'))`);
    await screenshot('fixture-mobile-auto-revealed-plan');
    await ui.click({ label: 'Close Plan', touch: true });
    evidence.mobilePlanAutoReveal = 'captured and closed through its native control';
    await choose('High');
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    const high = await send('QA submit the explicit High choice from the native mobile model sheet.');
    await idle(sessionID);
    await assertSubmittedVariant(high, 'high');
    await choose('Default');
    await openEfforts();
    await ui.waitExpression('mobile Default chip pressed', `Boolean([...document.querySelectorAll('#mobile-overlay-root button[aria-pressed="true"]')].find(e=>e.innerText.trim()==='Default'))`);
    await capture('fixture-mobile-default-selected', 'light', 390, 844, { selection: 'Default', pressed: true });
    await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    const providerDefault = await send('QA clear High through the native mobile Default choice and preserve that choice after reload.');
    await idle(sessionID);
    await assertSubmittedVariant(providerDefault, '');
    await ui.reload();
    await ui.waitExpression('mobile Default label restored after reload', `document.querySelector(${JSON.stringify(modelButton)})?.title==='Fixture model · Default'`);
    await openEfforts();
    await ui.waitExpression('mobile Default chip remains pressed after reload', `Boolean([...document.querySelectorAll('#mobile-overlay-root button[aria-pressed="true"]')].find(e=>e.innerText.trim()==='Default'))`);
    await capture('fixture-mobile-default-restored', 'light', 390, 844, { selection: 'Default', pressed: true,
      userMessageID: providerDefault.messageID, canonicalVariant: providerDefault.model.variant });
    await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
    await choose('Low');
    evidence.mobileDefault = { highUserMessageID: high.messageID, highVariant: high.variant,
      defaultUserMessageID: providerDefault.messageID, defaultVariant: providerDefault.variant,
      defaultChipPressed: true, labelAndPressedStateRestoredAfterReload: true, restoredSceneSelection: 'Low',
      source: 'native mobile choices and actual canonical submissions before installing any managed-task read fixture' };
  });
  evidence.selectionResilience = {};
  await check('unsent Low survives desktop to mobile to desktop and the actual native send', async () => {
    await desktopViewport();
    await ui.waitExpression('desktop unsent Low before resize', `document.querySelector('.model-controls__variant-trigger')?.innerText.trim()==='Low'`);
    await screenshot('fixture-unsent-low-before-responsive-roundtrip');
    await mobileViewport();
    await ui.waitExpression('mobile unsent Low after resize', `document.querySelector(${JSON.stringify(modelButton)})?.title==='Fixture model · Low'`);
    await screenshot('fixture-unsent-low-mobile-roundtrip');
    await desktopViewport();await pause(600);
    await ui.waitExpression('desktop unsent Low after return', `document.querySelector('.model-controls__variant-trigger')?.innerText.trim()==='Low'`);
    await screenshot('fixture-unsent-low-after-responsive-roundtrip');
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    const submitted = await send('QA preserve the unsent Low choice through desktop, mobile, and desktop before this actual send.');
    await idle(sessionID);
    evidence.selectionResilience.responsive = { route: 'desktop to mobile to desktop', previousCanonicalVariant: '',
      ...await assertSubmittedVariant(submitted, 'low') };
  });
  await check('unsent Low survives session A to B to A and the actual native send', async () => {
    await mobileViewport();await choose('Default');
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    const baseline = await send('QA restore canonical Default before the independent unsent session-choice check.');
    await idle(sessionID);const canonicalBaseline = await assertSubmittedVariant(baseline, '');
    await pause(600);await choose('Low');
    await screenshot('fixture-unsent-low-before-session-roundtrip');
    await selectSession(PERF_PARENT_SESSION_ID);
    const otherRows = await api(`/api/session/${PERF_PARENT_SESSION_ID}/message?directory=${encodeURIComponent(directory)}`);
    const otherUser = otherRows.findLast(row => row.info.role === 'user');
    assert.ok(otherUser, 'Existing comparison session must have canonical user history');
    await ui.waitExpression('comparison session history mounted', `Boolean(document.querySelector(${JSON.stringify(row(otherUser.info.id))}))`);
    await screenshot('fixture-unsent-low-other-session');
    await selectSession(sessionID);
    await ui.waitExpression('original session canonical Default history mounted', `Boolean(document.querySelector(${JSON.stringify(row(baseline.messageID))}))`);
    await pause(600);
    await ui.waitExpression('mobile unsent Low after session return', `document.querySelector(${JSON.stringify(modelButton)})?.title==='Fixture model · Low'`);
    await screenshot('fixture-unsent-low-after-session-roundtrip');
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    const submitted = await send('QA preserve the unsent Low choice through another existing session and back before this actual send.');
    await idle(sessionID);
    evidence.selectionResilience.session = { route: 'session A to existing session B to A', width: 390, height: 844,
      otherSessionID: PERF_PARENT_SESSION_ID, canonicalBaseline, ...await assertSubmittedVariant(submitted, 'low') };
    await desktopViewport();
  });
  fixture.configureNextPrompt(sessionID, { reasoning: 'text', reasoningText: 'Keep the expanded reasoning readable while the follow-up stays queued.', hold: true });
  const held = await send('QA hold the responsive parent while canonical child cards remain visible.');
  await assertSubmittedVariant(held, 'low');
  const parentAssistant = await latestAssistant(sessionID);
  const reasoning = row(parentAssistant.info.id) + ' [data-reasoning-group] button';
  await ui.waitExpression('mobile parent reasoning', `Boolean(document.querySelector(${JSON.stringify(reasoning)}))`);
  await evaluate(cdp, `document.querySelector(${JSON.stringify(reasoning)}).focus()`);
  await ui.key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
  await ui.type('Queued mobile follow-up remains reachable.');await ui.key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
  await ui.waitExpression('mobile parent queue', 'Boolean(document.querySelector("button[aria-label=\\"Remove from Queue\\"]"))');
  const children = [];
  let interception;
  try {
    for (const [index, status] of ['running', 'completed'].entries()) {
      const child = await requests(`${fixture.origin}/session`, { parentID: sessionID, title: `QA ${status} canonical child` });
      const userMessageID = `msg_qa_mobile_child_${index + 1}_${sessionID}`;
      fixture.configureNextPrompt(child.id, { hold: status === 'running', reasoning: 'text',
        reasoningText: `The canonical ${status} child checks responsive task controls.`, chunks: 1, intervalMs: 10,
        responseText: `QA ${status} child response is stored in the exact child session.` });
      await requests(`${fixture.origin}/session/${child.id}/prompt_async`, { messageID: userMessageID, agent: 'build', variant: '',
        model: { providerID: 'fixture', modelID: 'fixture-model' }, parts: [{ type: 'text', text: `QA ${status} canonical child request.` }] });
      if (status === 'completed') await idle(child.id);
      const assistant = await latestAssistant(child.id);
      children.push({ sessionID: child.id, parentSessionID: sessionID, userMessageID, assistantMessageID: assistant.info.id, status, agent: 'build' });
    }
    const model = createQaManagedTaskReadModel({ transport: cell.transport, directory, rootSessionID: sessionID, children, agent: cell.agent });
    const origin = await evaluate(cdp, 'location.origin');
    interception = await installQaManagedTaskReadModel({ transport: cell.transport, cdp, origin, model });
    evidence.managedTasks = { source: model.source, records: model.records, interception: interception.evidence };
    for (const record of model.records) fixture.appendManagedTaskVisual({ sessionID, messageID: parentAssistant.info.id,
      task: record.task, resultEnvelope: record.resultEnvelope });
    fixture.disconnectEvents();
    // The host owns managed-task delivery separately from OpenCode SSE. A real
    // reload exercises its normal snapshot bootstrap through the scoped read
    // fixture, while the canonical tool parts come from ordinary message HTTP.
    await ui.reload();
    for (const record of model.records) {
      await ui.waitExpression('authoritative managed task row', `Boolean(document.querySelector('[data-managed-task-id="${record.task.taskId}"]'))`);
    }
    await ui.waitFor('actual managed snapshot fetch', async () => {
      await interception.readEvidence();
      return interception.evidence.requests.some(request => request.accepted && new URL(request.url).pathname === '/api/orchestration/snapshot');
    });
    assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-managed-task-fallback-id]"))'), false);
    await ui.waitExpression('reloaded parent reasoning', `Boolean(document.querySelector(${JSON.stringify(reasoning)}))`);
    if (await evaluate(cdp, `document.querySelector(${JSON.stringify(reasoning)}).getAttribute('aria-expanded')`) !== 'true') {
      await evaluate(cdp, `document.querySelector(${JSON.stringify(reasoning)}).focus()`);
      await ui.key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    // A long genuine session title makes action/title crowding measurable.
    await api(`/api/session/${sessionID}?directory=${encodeURIComponent(directory)}`, { method: 'PATCH',
      body: JSON.stringify({ title: 'QA responsive review of task ordering and persistence' }) });
    for (const theme of ['light', 'dark']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      for (const [width, height] of [[390, 844], [844, 390], [768, 1024]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });await pause(300);
        const prefix = `fixture-rich-${theme}-${width}x${height}`;
        await check(`mobile rich states ${theme} ${width}x${height}`, async () => {
          await interception.assertHealthy();
          await ui.reveal(reasoning, undefined, { scrollContainer: chat, direction: 'down' });
          assert.equal(await evaluate(cdp, `document.querySelector(${JSON.stringify(reasoning)})?.getAttribute('aria-expanded')`), 'true');
          await ui.revealText('Keep the expanded reasoning readable', row(parentAssistant.info.id), { scrollContainer: chat, direction: 'down' });
          await capture(prefix + '-reasoning-queue', theme, width, height);
          await ui.reveal(row(toolAssistant.info.id), undefined, { scrollContainer: chat, direction: 'up' });
          await revealQaFixtureTool({ cdp, ui, assistant: toolAssistant, expectedText: 'Fixture tests passed.' });
          await capture(prefix + '-tool-expanded', theme, width, height);
          await ui.reveal(planSelector, undefined, { scrollContainer: chat, direction: 'up' });
          await ui.revealText('QA mobile saved plan', planSelector, { scrollContainer: chat, direction: 'up' });
          await ui.reveal(planSelector+' button', 'Implement Plan', { scrollContainer: chat, direction: 'down', allowDisabled:true, fullyVisible:true });
          const planActionVisibility=await ui.waitExpression('saved Plan approval action is fully visible', `(() => {
            const e=[...document.querySelectorAll(${JSON.stringify(planSelector+' button')})].find(e=>e.innerText.trim()==='Implement Plan');
            if(!e)return false;const r=e.getBoundingClientRect();
            const s=document.querySelector(${JSON.stringify(chat)})?.getBoundingClientRect();if(!s)return false;
            const clip={top:Math.max(0,s.top),bottom:Math.min(innerHeight,s.bottom),left:Math.max(0,s.left),right:Math.min(innerWidth,s.right)};
            if(r.width<=0||r.height<=0||r.top<clip.top||r.bottom>clip.bottom||r.left<clip.left||r.right>clip.right)return false;
            const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            if(!hit||!(e.contains(hit)||(e.disabled&&getComputedStyle(e).pointerEvents==='none'&&hit===e.parentElement)))return false;
            return {disabled:e.disabled,title:e.title,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip,centerHitOwned:true,
              hitTarget:e.contains(hit)?'button':'immediate-footer-parent'};
          })()`);
          const planState = await evaluate(cdp, `(() => {const e=document.querySelector(${JSON.stringify(planSelector)});return [...e.querySelectorAll('button')].map(button=>({text:button.innerText,disabled:button.disabled,title:button.title}));})()`);
          await capture(prefix + '-saved-plan', theme, width, height, { sourceMessageID: planAssistant.info.id, planState, planActionVisibility });
          for (const record of model.records) {
            const selector = `[data-managed-task-id="${record.task.taskId}"]`;
            await ui.reveal(selector, undefined, { scrollContainer: chat, direction: 'down' });
            const displayedLabel = await evaluate(cdp, `document.querySelector(${JSON.stringify(selector + ' h4')})?.innerText`);
            assert.equal(displayedLabel?.toLowerCase(), record.task.label.toLowerCase());
            await ui.revealText(displayedLabel, selector, { scrollContainer: chat, direction: 'down' });
            await capture(prefix + `-task-${record.task.status}`, theme, width, height, { taskId: record.task.taskId, childSessionID: record.child.sessionID });
          }
          const navigated = model.records[0];
          await ui.reveal(`[data-managed-task-id="${navigated.task.taskId}"] button`, 'Open Subtask', { scrollContainer: chat, direction: 'up' });
          await ui.click({ selector: `[data-managed-task-id="${navigated.task.taskId}"] button`, text: 'Open Subtask', touch: true });
          await ui.waitFor('exact canonical child navigation', async () => await evaluate(cdp, "new URL(location.href).searchParams.get('session')") === navigated.child.sessionID);
          await ui.waitVisibleText('QA running canonical child request.');
          await capture(prefix + '-child-open', theme, width, height, { taskId: navigated.task.taskId, selectedSessionID: navigated.child.sessionID });
          evidence.childNavigation.push({ theme, width, height, taskId: navigated.task.taskId, childSessionID: navigated.child.sessionID });
          await selectSession(sessionID);
          await ui.waitExpression('root queue survives child navigation', 'Boolean(document.querySelector("button[aria-label=\\"Remove from Queue\\"]"))');
          if (width === 844) {
            const coarse = await captureSidebarTargets({ cdp, ui, sessionID, pointer: 'coarse' });
            evidence.landscapeCoarse ??= [];evidence.landscapeCoarse.push({ theme, ...coarse });
            await capture(prefix + '-sidebar-coarse', theme, width, height, { coarse });
            assertSidebarTargets(coarse, 36);
          }
          evidence.projectHeaders ??= [];
          const headerEvidence = { theme, width, height };evidence.projectHeaders.push(headerEvidence);
          await verifyQaFixtureProjectHeader({ cdp, ui, screenshot, prefix, drawer: width !== 844, outputEvidence: headerEvidence });
          const mobileControls = await evaluate(cdp, `Boolean(document.querySelector('[data-chat-input-footer] button[title^="Fixture model"]'))`);
          const selectionExpression = mobileControls
            ? `({agent:[...document.querySelectorAll('[data-chat-input-footer] button[title]')].find(e=>['Builder','Orchestrator'].includes(e.title))?.title,model:document.querySelector('[data-chat-input-footer] button[title^="Fixture model"]')?.title})`
            : `({agent:document.querySelector('.model-controls__agent-label')?.innerText,model:document.querySelector('.model-controls__model-trigger')?.innerText,effort:document.querySelector('.model-controls__variant-trigger')?.innerText})`;
          const selectionBeforeMenus = await evaluate(cdp, selectionExpression);
          for (const [name, selector] of [['model', 'button.model-controls__model-trigger'], ['agent', 'button:has(.model-controls__agent-label)'], ['effort', 'button.model-controls__variant-trigger']]) {
            if (mobileControls) {
              await ui.click({ selector: name === 'agent'
                ? `[data-chat-input-footer] button[title="${cell.agent === 'builder' ? 'Builder' : 'Orchestrator'}"]`
                : '[data-chat-input-footer] button[title^="Fixture model"]', touch: true });
              if (name === 'effort') {
                await ui.waitExpression('model overlay open', `Boolean(document.querySelector('#mobile-overlay-root [role="dialog"]'))`);
                if (await evaluate(cdp, `Boolean(document.querySelector('#mobile-overlay-root button[aria-label="Show Thinking Modes"]'))`)) {
                  await ui.click({ label: 'Show Thinking Modes', touch: true });
                }
                for (const label of ['Default', 'Low', 'High']) await ui.waitVisibleText(label, '#mobile-overlay-root');
              }
            } else await ui.click({ selector, touch: true });
            const panel = mobileControls ? '#mobile-overlay-root .pwa-overlay-panel' : '[role="menu"]';
            const menu = await ui.waitExpression('responsive selector settled and visible', `(() => {const e=[...document.querySelectorAll(${JSON.stringify(panel)})].find(e=>e.getBoundingClientRect().width>0);if(!e||e.getAnimations({subtree:true}).some(a=>a.playState==='running'))return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
            assert.ok(menu.left >= -1 && menu.right <= width + 1 && menu.top >= -1 && menu.bottom <= height + 1, `${name} menu must fit the viewport`);
            let tabSteps = 0;
            if (mobileControls) {
              while (!await evaluate(cdp, `Boolean(document.activeElement?.closest(${JSON.stringify(panel)}))`) && tabSteps < 12) {
                await ui.key('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 });tabSteps += 1;
              }
            } else await ui.key('ArrowDown', { code: 'ArrowDown', windowsVirtualKeyCode: 40 });
            const focused = await evaluate(cdp, `Boolean(document.activeElement?.closest(${JSON.stringify(panel)}))`);
            assert.equal(focused, true, `${name} menu must accept keyboard focus`);
            await capture(prefix + '-' + name + '-menu', theme, width, height, { menu, keyboardFocusInside: focused,
              surface: mobileControls ? 'native mobile overlay' : 'native dropdown', tabSteps, selectionBeforeMenus });
            await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
            await ui.waitExpression('responsive selector closes on Escape', `![...document.querySelectorAll(${JSON.stringify(panel)})].some(e=>e.getBoundingClientRect().width>0)`);
            assert.deepEqual(await evaluate(cdp, selectionExpression), selectionBeforeMenus,
              `Opening and closing the ${name} selector must preserve the chosen agent/model/thinking selection`);
          }
          const permissionID = fixture.askPermission(sessionID);
          await ui.waitVisibleText('Deny');
          await capture(prefix + '-permission', theme, width, height, { permissionID });
          await ui.click({ text: 'Allow Once', touch: true });
          await ui.waitFor('exact mobile permission acknowledgement', () => fixture.getState().replies.some(reply => reply.requestID === permissionID && reply.reply === 'once'));
          evidence.permissions.push({ theme, width, height, permissionID, reply: 'once' });
          if (width === 844) {
            const hover = await captureQaFixtureLandscapeHover({ cdp, ui, sessionID });
            evidence.landscapeHover ??= [];evidence.landscapeHover.push({ theme, ...hover });
            await capture(prefix + '-sidebar-hover', theme, width, height, { hover });
            assertSidebarTargets(hover, 20);
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
          }
        });
      }
    }
    await interception.assertHealthy();
    evidence.planSourceMessageID = planAssistant.info.id;
    evidence.toolAssistantMessageID = toolAssistant.info.id;
    evidence.parentAssistantMessageID = parentAssistant.info.id;
  } catch (error) {
    evidence.failure = error.message;
    evidence.failureControls = await ui.inspectControls();
    await screenshot('fixture-rich-failure-active-viewport');
    throw error;
  } finally {
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      if (interception) {
        for (const record of evidence.managedTasks.records) fixture.removeManagedTaskVisual(record.task);
        await interception.close();
      }
      const mounted = await evaluate(cdp, "Boolean(document.querySelector('textarea'))");
      if (mounted) {
        if (await evaluate(cdp, "new URL(location.href).searchParams.get('session')") !== sessionID) await selectSession(sessionID);
        if (await evaluate(cdp, 'Boolean(document.querySelector("button[aria-label=\\"Remove from Queue\\"]"))')) await ui.click({ label: 'Remove from Queue' });
      }
      if (mounted && await evaluate(cdp, 'Boolean(document.querySelector("button[aria-label=\\"Stop Generating\\"]"))')) {
        await ui.click({ label: 'Stop Generating' });await idle(sessionID);
      } else {
        evidence.cleanupUsedFixtureAbort = true;
        await requests(`${fixture.origin}/session/${sessionID}/abort`, {});
      }
      for (const child of children) {
        if (child.status === 'running') await requests(`${fixture.origin}/session/${child.sessionID}/abort`, {});
      }
    } catch (error) {
      evidence.cleanupError = error.message;
      if (!evidence.failure) throw error;
    }
  }
  return evidence;
}
