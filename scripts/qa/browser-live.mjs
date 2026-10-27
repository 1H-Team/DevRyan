// Actual native tool/desktop integration, with deterministic local model decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { prepareRuntimeUiProfile, runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { waitForQaHostReady } from './host-readiness.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const [artifactRoot, installRoot] = process.argv.slice(2);
assert.ok(path.isAbsolute(artifactRoot ?? '') && path.isAbsolute(installRoot ?? ''), 'Pass native artifacts and managed browser install paths');
const require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'browser-live-', owner: 'browser-live', signals: 'exit' });
const root = run.dir, workspace = path.join(root, 'workspace'), runtimeRoot = path.join(root, 'runtime');
const sanitizer = createDiagnosticSanitizer({ homeDir: root });
const evidence = { status: 'failed', checks: [], screenshots: [], model: 'deterministic local HTTP fixture; actual native runtime and browser tool' };
let profile, owned, cdp, guestCdp;
const page = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><style>body{font:24px sans-serif;background:#f7fafc;padding:32px}button,input{font:inherit;padding:12px;margin:12px}#result{color:#2463eb}</style><h1>Live browser verification</h1><input id="name" aria-label="Name"><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result">Ready</p>');
});
const stop = async () => {
  guestCdp?.close(); cdp?.close();
  try { if (owned) await owned.stop(); }
  finally {
    try { await profile?.close(); }
    finally { page.closeAllConnections(); await new Promise(resolve => page.close(resolve)); }
  }
};
let interrupted = false;
const interrupt = () => { interrupted = true; void owned?.stop(); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  await fs.mkdir(workspace, { recursive: true });
  execFileSync('git', ['init', '--quiet', workspace]);
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const preview = `http://127.0.0.1:${page.address().port}`;
  profile = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace,
    targetGeneration: 2, artifactRoot, runScope: run.scope,
    fixtureResponder: request => {
      const toolNames = request.body.tools?.map(row => row.function?.name) ?? [];
      if (!toolNames.length) return { items: [{ type: 'textDelta', text: 'Browser live acceptance' }], reason: 'stop' };
      const completed = request.body.messages.some(row => row.role === 'tool' && row.tool_call_id === 'browser_live');
      if (completed) return { items: [{ type: 'textDelta', text: 'Live browser verification complete.' }], reason: 'stop' };
      assert.ok(request.body.tools?.some(row => row.function?.name === 'devryan_browser'), 'Actual browser tool must be advertised');
      return { items: [{ type: 'toolCall', index: 0, id: 'browser_live', name: 'devryan_browser', input: {
        command: 'sequence', timeout_ms: 120000, steps: [
          { command: 'open', args: [preview] },
          ...Array.from({ length: 8 }, (_, index) => [
            { command: 'fill', args: ['#name', `Verified ${index + 1}`] },
            { command: 'click', args: ['#save'] }, { command: 'wait', args: ['3000'] },
          ]).flat(), { command: 'close' },
        ],
      } }], reason: 'tool-calls' };
    } });
  const data = profile.env.DEVRYAN_DATA_DIR;
  await fs.mkdir(path.join(data, 'tools'), { recursive: true });
  const targetInstall = path.join(data, 'tools/agent-browser');
  await fs.mkdir(targetInstall);
  for (const file of ['node_modules', 'ffmpeg', 'package.json', 'devryan-agent-browser.json']) {
    await fs.cp(path.join(installRoot, file), path.join(targetInstall, file), { recursive: true });
  }
  const port = await reservePort(), debugPort = await reservePort();
  const settingsPath = path.join(data, 'settings.json');
  const settings = JSON.parse(await fs.readFile(settingsPath));
  await fs.writeFile(settingsPath, JSON.stringify({ ...settings, desktopLocalPort: port, agentBrowserControlEnabled: true }));
  const origin = `http://127.0.0.1:${port}`;
  const env = createQaHostLaunchEnvironment(profile.env, { DEVRYAN_QA_RUNTIME: 'electron', DEVRYAN_PORT: String(port),
    DEVRYAN_DIST_DIR: path.join(repository, 'packages/web/dist') });
  await profile.verifyInputs();
  owned = startOwnedProcess(require('electron'), [`--remote-debugging-port=${debugPort}`, 'scripts/qa/isolated-host.mjs'], { cwd: repository, env });
  console.log(JSON.stringify({ root, origin, debugPort }));
  await waitForQaHostReady({ origin, checkAlive: () => { assert.equal(interrupted, false); owned.check(); } });
  cdp = await CdpConnection.connect((await discoverPageTarget(debugPort)).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const ui = createQaUiDriver(cdp, { timeoutMs: 60000, checkAlive: () => owned.check() });
  await ui.waitExpression('initial composer', 'Boolean(document.querySelector("textarea"))');
  const api = async (route, body) => evaluate(cdp, `(async () => {
    const response = await fetch(${JSON.stringify(route + '?directory=' + encodeURIComponent(workspace))}, {
      method: ${JSON.stringify(body === undefined ? 'GET' : 'POST')}, headers: {'Content-Type':'application/json','X-DevRyan-CSRF':'1'},
      ${body === undefined ? '' : 'body:' + JSON.stringify(JSON.stringify(body))}
    }); if (!response.ok) throw new Error('QA API ' + response.status); return response.status === 204 ? null : response.json();
  })()`);
  const session = await api('/api/session', { title: 'Browser live acceptance' });
  evidence.sessionID = session.id;
  const otherSession = await api('/api/session', { title: 'Unrelated browser chat' });
  await cdp.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(session.id)}` });
  await ui.waitExpression('selected composer', 'Boolean(document.querySelector("textarea"))');
  assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-browser-lease-active]"))'), false);
  await api(`/api/session/${session.id}/prompt_async`, { agent: 'builder', model: { providerID: runtimeUiTuple.providerID, modelID: runtimeUiTuple.modelID }, variant: 'high', parts: [{ type: 'text', text: 'Run the deterministic browser live acceptance.' }] });
  await ui.waitExpression('blue activity dot', 'Boolean(document.querySelector("[data-browser-lease-active]"))');
  assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-browser-lease-pane]"))'), false, 'Preview must not open automatically');
  const screenshot = async name => {
    const { data: image } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(root, name + '.png'), Buffer.from(image, 'base64')); evidence.screenshots.push(name + '.png');
  };
  await screenshot('desktop-dot');
  let loaded = cdp.waitFor('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(otherSession.id)}` }); await loaded;
  await ui.waitExpression('unrelated chat ready', 'Boolean(document.querySelector("textarea"))');
  assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-browser-lease-active]"))'), false);
  loaded = cdp.waitFor('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(session.id)}` }); await loaded;
  await ui.waitExpression('original chat activity restored', 'Boolean(document.querySelector("[data-browser-lease-active]"))');
  evidence.checks.push('unrelated chat has no activity dot or browser lease');
  await ui.click({ selector: 'button:has([data-browser-lease-active])' });
  await ui.waitExpression('direct live panel', 'Boolean(document.querySelector("[data-browser-lease-pane]"))');
  await ui.waitExpression('navigated live panel', `Array.from(document.querySelectorAll('input')).some(input => input.value.includes(${JSON.stringify(preview)}))`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await screenshot('desktop-preview');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const guest = targets.find(target => target.type === 'page' && target.url.startsWith(preview));
  assert.ok(guest, 'Actual lease guest must be inspectable');
  guestCdp = await CdpConnection.connect(guest.webSocketDebuggerUrl);
  await ui.waitFor('actual guest click pulse', () => evaluate(guestCdp, 'Boolean(document.querySelector("#__devryan_agent_browser_cursor_pulse"))'));
  const { data: clickImage } = await guestCdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(root, 'native-click.png'), Buffer.from(clickImage, 'base64')); evidence.screenshots.push('native-click.png');
  await ui.click({ label: 'Close Panel' });
  assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-browser-lease-active]"))'), true);
  await ui.click({ selector: 'button:has([data-browser-lease-active])' });
  await ui.waitExpression('reopened live panel', 'Boolean(document.querySelector("[data-browser-lease-pane]"))');
  const handle = await evaluate(cdp, `(() => {const r=document.querySelector('[data-panel-resize-handle="browser-panel"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 80, y: handle.y, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x - 80, y: handle.y, button: 'left', clickCount: 1 });
  await screenshot('desktop-resized');
  evidence.checks.push('guest click pulse is visible; closing observation preserves the lease; single click reopens; panel resizes');
  evidence.checks.push('real native browser tool publishes dot; panel stays closed until clicked; single click opens preview');
  await ui.waitExpression('completed browser turn', 'document.body.innerText.includes("Live browser verification complete.")', 120000);
  await ui.waitExpression('dot cleared', '!document.querySelector("[data-browser-lease-active]")');
  evidence.checks.push('completion releases lease and removes activity dot');
  const journal = path.join(data, 'harness/journal');
  const summary = JSON.parse(execFileSync('bun', ['scripts/journal.mjs', 'summary', session.id, '--json', '--dir', journal], { cwd: repository, encoding: 'utf8' }));
  assert.equal(summary.gaps, 0);
  const gaps = execFileSync('bun', ['scripts/journal.mjs', 'gaps', '--verify', '--dir', journal], { cwd: repository, encoding: 'utf8' });
  assert.equal(gaps.trim(), '');
  await fs.writeFile(path.join(root, 'journal-summary.json'), JSON.stringify(summary, null, 2));
  evidence.checks.push('correlated native session journal has no verified gaps');
  evidence.status = 'passed';
} catch (error) { evidence.error = error.stack; process.exitCode = 1; }
finally {
  if (owned) await fs.writeFile(path.join(root, 'host.log'), sanitizer.sanitizeText(owned.getLog()), { mode: 0o600 });
  try { await stop(); } catch (error) { evidence.cleanupError = error.message; evidence.status = 'failed'; process.exitCode = 1; }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ root, ...evidence })); run.finish(evidence.status);
}
