import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const electron = createRequire(new URL('../../packages/electron/package.json', import.meta.url))('electron');

export async function verifyRevertUi({ mode, root, dataDirectory, directory, upstream, environment, request, invoke, shell, node, until }) {
  const packagedElectron = process.env.DEVRYAN_TEST_ELECTRON_BINARY;
  if (mode === 'electron' && !path.isAbsolute(packagedElectron ?? '')) {
    throw new Error('Set DEVRYAN_TEST_ELECTRON_BINARY to the isolated packaged QA application');
  }
  const a = await request('/session', { title: `UI Revert ${mode}` });
  const b = await request('/session', { title: `Unrelated writer ${mode}` });
  const file = `ui-${mode}.txt`, release = path.join(root, `release-${mode}`);
  await fs.writeFile(path.join(directory, file), 'a=1; b=2');
  await fs.chmod(path.join(directory, file), 0o600);
  const first = await invoke(a.id, 'write', { filePath: path.join(directory, file), content: 'a=3; b=2' });
  const held = shell(b.id, node(`const fs=require('node:fs'), base=fs.readFileSync('${file}','utf8');console.log('ui-writer-ready');
    const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);fs.writeFileSync('${file}',base.replace('b=2','b=4'))}},25)`));
  void held.catch(() => {});
  await until(async () => (await request(`/session/${b.id}/message`)).some((m) => m.parts.some((p) => p.type === 'tool' && JSON.stringify(p.state.metadata ?? p.state.output ?? "").includes('ui-writer-ready'))));
  await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ messageStreamTransport: 'sse', lastDirectory: directory,
    projects: [{ id: 'revert-fixture', path: directory, label: 'Revert fixture' }], activeProjectId: 'revert-fixture', productionBotsRuntimeMode: 'disabled' }));
  const port = await reservePort(), debugPort = await reservePort(), profile = path.join(root, `ui-profile-${mode}`);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...environment, OPENCHAMBER_DATA_DIR: dataDirectory, OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile,
    OPENCHAMBER_DIST_DIR: path.join(repository, 'packages/web/dist'), OPENCHAMBER_PORT: String(port),
    OPENCODE_HOST: upstream, OPENCODE_SKIP_START: 'true', OPENCHAMBER_SKIP_OPENCODE_START: 'true',
    OPENCHAMBER_ELECTRON_DEV: '1', DEVRYAN_EXECUTION_ARTIFACTS: process.env.DEVRYAN_EXECUTION_ARTIFACTS,
    DEVRYAN_QA_RUNTIME_ROOT: root, DEVRYAN_QA_HOME: environment.HOME, DEVRYAN_QA_RUNTIME: mode,
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
  const processes = [];
  const start = (binary, args, extra = {}) => { const child = startOwnedProcess(binary, args, { cwd: repository, env: { ...env, ...extra } }); processes.push(child); return child; };
  const flags = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
  let cdp;
  try {
    if (mode === 'web') {
      start(process.execPath, ['packages/web/server/index.js', '--port', String(port)]);
      await until(() => fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false));
      start(electron, [...flags, 'scripts/qa/browser-shell.cjs'], { DEVRYAN_QA_ORIGIN: origin });
    } else {
      // Exercise the shipped resource lookup, in-process server and preload.
      // The QA bootstrap isolates the OS keychain, home and protocol registry.
      delete env.DEVRYAN_EXECUTION_ARTIFACTS;
      start(packagedElectron, flags);
    }
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `for (const principal of ['anonymous','local-admin']) localStorage.setItem('devryan.user.'+principal+':lastDirectory', ${JSON.stringify(directory)});` });
    if (mode === 'electron') {
      await until(async () => /^http:\/\/127\.0\.0\.1:\d+/.test(await evaluate(cdp, 'location.href')));
    }
    await cdp.send('Page.reload');
    const ui = createQaUiDriver(cdp, { timeoutMs: 60000, checkAlive: () => processes.forEach((child) => child.check()) });
    const selector = `[data-message-id="${first.result.info.parentID}"]`;
    // Startup restores the previous selection while live activity can reorder
    // sidebar rows. Confirm navigation before exercising the destructive action.
    await ui.waitFor('selected fixture message rendered', async () => {
      if (await evaluate(cdp, `!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await ui.click({ selector: `[data-session-row="${a.id}"] button`, text: `UI Revert ${mode}` });
      return false;
    });
    // Hover exposes the same message action used by a person.
    const point = await evaluate(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    let revertResponse;
    const completed = new Set();
    cdp.on('Network.responseReceived', (event) => {
      if (new URL(event.response.url).pathname.endsWith(`/session/${a.id}/scoped-revert`)) revertResponse = event;
    });
    cdp.on('Network.loadingFinished', (event) => completed.add(event.requestId));
    await ui.click({ label: 'Revert to This Message' });
    // Conversation SSE is emitted before the file decision. Only the completed
    // route response attests that both halves of the transaction have settled.
    await until(async () => revertResponse && completed.has(revertResponse.requestId));
    assert.equal(revertResponse.response.status, 200);
    const response = await cdp.send('Network.getResponseBody', { requestId: revertResponse.requestId });
    assert.equal(JSON.parse(response.body).verification?.ok, true);
    assert.equal((await request(`/session/${a.id}`)).revert?.messageID, first.result.info.parentID);
    assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), 'a=1; b=2');
    await ui.waitExpression('composer restored', `Array.from(document.querySelectorAll('textarea')).some(e=>e.value.includes('DEVRYAN_FIXTURE_TOOL:'))`);
    assert.equal((await request('/session/status'))[b.id]?.type, 'busy');
    await fs.writeFile(release, 'go'); await held;
    assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), 'a=1; b=4');
    assert.equal((await fs.stat(path.join(directory, file))).mode & 0o777, 0o600);
    const output = path.join(repository, '.cache/concurrent-revert', `revert-${mode}.png`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(output, Buffer.from(screenshot.data, 'base64'));
    console.log(`PASS: ${mode} UI Revert, composer restoration, unrelated active command and late publication (${output})`);
  } catch (cause) {
    for (const child of processes) console.error(child.getLog());
    if (cdp) console.error(await evaluate(cdp, 'document.body.innerText').catch(() => 'UI unavailable'));
    throw cause;
  } finally {
    await fs.writeFile(release, 'go'); await held.catch(() => {});
    cdp?.close();
    for (const child of processes.reverse()) await child.stop();
  }
}
