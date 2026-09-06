import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { assertQaProjectFixtureOwned } from './project-fixture.mjs';

// Run the agent-edited application as a black box and interact with its real
// controls. Independent backend graders run separately from this browser check.
export async function reviewQaProjectBrowser({ fixture, check, sanitize = String, checkAlive = () => {} }) {
  assertQaProjectFixtureOwned(fixture);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const output = path.join(fixture.evidenceDirectory, 'project-browser');
  const browserProfile = path.join(output, 'chromium');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const child = startOwnedProcess(process.execPath, ['src/server.mjs'], { cwd: fixture.fixtureRoot,
    env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', PORT: String(port), TMPDIR: output } });
  const evidence = { origin, outcome: 'failed', screenshots: [], consoleErrors: [], visualReview: 'pending' };
  let cdp, browser;
  const alive = () => { checkAlive(); child.check(); };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      alive();
      if (await fetch(`${origin}/api/tasks`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) break;
      if (Date.now() >= deadline) throw new Error('Edited project HTTP server did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Electron does not implement CDP Target.createTarget. A separate owned
    // Chromium shell provides a real browser without navigating the QA app away.
    const browserPort = await reservePort();
    const browserEnvironment = { ...process.env, DEVRYAN_QA_ORIGIN: origin };
    delete browserEnvironment.ELECTRON_RUN_AS_NODE;
    const require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
    browser = startOwnedProcess(require('electron'), [`--remote-debugging-port=${browserPort}`, `--user-data-dir=${browserProfile}`,
      fileURLToPath(new URL('./browser-shell.cjs', import.meta.url))], { env: browserEnvironment });
    cdp = await CdpConnection.connect((await discoverPageTarget(browserPort)).webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    cdp.on('Runtime.exceptionThrown', event => { if (evidence.consoleErrors.length < 30) evidence.consoleErrors.push(sanitize(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text)); });
    cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error' && evidence.consoleErrors.length < 30) evidence.consoleErrors.push(sanitize(event.args.map(arg=>arg.value ?? arg.description ?? '').join(' '))); });
    await cdp.send('Page.navigate', { url: origin });
    const ui = createQaUiDriver(cdp, { checkAlive: alive });
    await ui.waitExpression('task board form', "Boolean(document.querySelector('#new-task input'))");
    const screenshot = async name => {
      await evaluate(cdp, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
      evidence.screenshots.push(`${name}.png`);
    };
    const selectByLabel = async (kind, label) => {
      await ui.waitExpression(`${kind} select`, `(() => {
        const e=[...document.querySelectorAll('select')].find(e=>{const label=[...(e.labels||[])].map(l=>l.textContent).join(' ')+' '+(e.getAttribute('aria-label')||'');return /priority/i.test(label)&&${kind === 'filter' ? '/filter/i.test(label)' : '!/filter/i.test(label)'};});
        if(!e)return null; const options=[...e.options];const index=options.findIndex(o=>o.textContent.trim().toLowerCase()===${JSON.stringify(label.toLowerCase())});
        if(index<0)return null;e.focus();return{index,optionCount:options.length};
      })()`);
      // Native macOS select menus do not consume renderer-injected arrow keys.
      // Closed-select typeahead is normal keyboard input and stays in the page.
      const letter = label[0].toLowerCase();
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: letter, code: `Key${letter.toUpperCase()}`,
        text: letter, unmodifiedText: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) });
      await ui.key('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 });
      await ui.waitExpression('selected priority option', `[...document.querySelectorAll('select')].some(e=>{const labels=[...(e.labels||[])].map(l=>l.textContent).join(' ')+' '+(e.getAttribute('aria-label')||'');return /priority/i.test(labels)&&${kind === 'filter' ? '/filter/i.test(labels)' : '!/filter/i.test(labels)'}&&e.selectedOptions?.[0]?.textContent.trim().toLowerCase()===${JSON.stringify(label.toLowerCase())};})`);
    };
    const names = ['QA low first', 'QA high second', 'QA normal third'];
    await check('edited application creates persisted priorities through its UI', async () => {
      for (const [index, priority] of ['Low', 'High', 'Normal'].entries()) {
        await ui.type(names[index], '#new-task input');
        await selectByLabel('creation', priority);
        await ui.click({ selector: '#new-task button', text: 'Add task' });
        await ui.waitVisibleText(names[index], '#tasks');
      }
      const tasks = await fetch(`${origin}/api/tasks`).then(response => response.json());
      evidence.createdTasks = names.map(title => tasks.find(task => task.title === title)).map(task => ({ id: task?.id, title: task?.title, priority: task?.priority }));
      assert.deepEqual(evidence.createdTasks.map(task => task.priority), ['low', 'high', 'normal']);
      const order = await evaluate(cdp, `document.querySelector('#tasks').innerText`);
      assert.ok(order.indexOf(names[0]) >= 0 && order.indexOf(names[0]) < order.indexOf(names[1]) && order.indexOf(names[1]) < order.indexOf(names[2]), 'Default task list must preserve creation order');
      await screenshot('creation-order-and-priorities');
    });
    await check('priority filter preserves all-active summary and restores creation order', async () => {
      const summaryBefore = await evaluate(cdp, "document.querySelector('#summary').innerText");
      await selectByLabel('filter', 'High');
      await ui.waitVisibleText(names[1], '#tasks');
      await ui.waitExpression('priority filter applied to the rendered list', `(()=>{const text=document.querySelector('#tasks').innerText;return !text.includes(${JSON.stringify(names[0])})&&!text.includes(${JSON.stringify(names[2])});})()`);
      const filtered = await evaluate(cdp, "document.querySelector('#tasks').innerText");
      assert.equal(filtered.includes(names[0]), false); assert.equal(filtered.includes(names[2]), false);
      assert.equal(await evaluate(cdp, "document.querySelector('#summary').innerText"), summaryBefore);
      await screenshot('high-filter');
      await selectByLabel('filter', 'All');
      await ui.waitVisibleText(names[0], '#tasks');
      const order = await evaluate(cdp, "document.querySelector('#tasks').innerText");
      assert.ok(order.indexOf(names[0]) < order.indexOf(names[1]) && order.indexOf(names[1]) < order.indexOf(names[2]));
    });
    await check('priority colors retain visible words from the reference attachment', async () => {
      evidence.priorityStyles = await evaluate(cdp, `['High','Normal','Low'].map(label=>({label,styles:[...document.querySelectorAll('#tasks *')].filter(e=>e.textContent.trim().toLowerCase()===label.toLowerCase()).map(e=>{const s=getComputedStyle(e);return[s.color,s.backgroundColor,s.borderColor];}).flat()}))`);
      const colors = { High: 'rgb(185, 28, 28)', Normal: 'rgb(161, 98, 7)', Low: 'rgb(37, 99, 235)' };
      for (const row of evidence.priorityStyles) assert.ok(row.styles.includes(colors[row.label]), `${row.label} must retain its visible reference color`);
    });
    await check('edited project mobile overflow and keyboard focus', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await ui.type('Keyboard focus probe', '#new-task input');
      await ui.key('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 });
      evidence.mobile = await evaluate(cdp, `(()=>{const e=document.activeElement;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,focusTag:e.tagName,outline:s.outlineStyle,outlineWidth:s.outlineWidth,focusedVisible:r.width>0&&r.height>0&&r.bottom<=innerHeight&&r.x>=0&&r.right<=innerWidth};})()`);
      assert.ok(evidence.mobile.scrollWidth <= evidence.mobile.width + 1 && evidence.mobile.focusedVisible);
      assert.notEqual(evidence.mobile.outline, 'none'); assert.notEqual(evidence.mobile.outlineWidth, '0px');
      await screenshot('mobile-keyboard-focus');
    });
    assert.deepEqual(evidence.consoleErrors, []);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = sanitize(error.message);
    if (cdp) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (capture) { await writeFile(path.join(output, 'failure.png'), Buffer.from(capture.data, 'base64')); evidence.screenshots.push('failure.png'); }
    }
    throw error;
  } finally {
    cdp?.close();
    const cleanupErrors = [];
    let browserStopped = true;
    await browser?.stop().catch(error => { browserStopped = false; cleanupErrors.push(sanitize(error.message)); });
    await child.stop().catch(error => { cleanupErrors.push(sanitize(error.message)); });
    if (browserStopped) await rm(browserProfile, { recursive: true, force: true }).catch(error => { cleanupErrors.push(sanitize(error.message)); });
    if (cleanupErrors.length) evidence.cleanupError = cleanupErrors.join('; ');
    await writeFile(path.join(output, 'server.log'), sanitize(child.getLog()), { mode: 0o600 });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    if (evidence.cleanupError) throw new Error(evidence.cleanupError);
  }
  return evidence;
}
