// Opt-in actual CLI/CDP acceptance. Run through upgrade-run.mjs, never the app profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionExecutionProfile, verifySessionExecutionLauncher } from '../../../harness-runtime/lib/session-execution.js';
import { app, BrowserWindow, session } from 'electron';
import { WebSocketServer } from 'ws';
import { createBrowserCdpBridge } from '../../browser-cdp-bridge.mjs';
import { createBrowserSurfaceManager } from '../../browser-surface-manager.mjs';
import { DevRyanBrowserPlugin } from '../../../web/server/default-config/plugins/devryan-browser.mjs';

const root = process.env.DEVRYAN_BROWSER_UPGRADE_ROOT;
assert.ok(root && path.isAbsolute(root));
const installRoot = process.env.DEVRYAN_BROWSER_UPGRADE_INSTALL;
assert.ok(installRoot && path.isAbsolute(installRoot));
app.setName('DevRyan Browser Upgrade Fixture');
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, path.join(root, key));
app.on('window-all-closed', () => {});
const evidence = { status: 'failed', versions: {}, checks: [], results: [], leaseIds: [] };
let window, surfaces, bridge, http, plugin;
let active;
const token = crypto.randomBytes(32).toString('hex');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Browser upgrade fixture</title>
<style>body{background:#fff;color:#123;font:20px sans-serif}button,input{margin:16px;padding:12px}#box,#drop{width:120px;height:80px;background:#28a}#drop{background:#ddd;margin-top:12px}</style></head>
<body><h1>Browser upgrade fixture</h1><label>Name<input id="name"></label><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button>
<p id="result">Initial</p><div id="box" draggable="true">Drag target</div><div id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('#result').textContent='Dropped'">Drop here</div><script>window.events=[];for(const type of ["pointerdown","pointerup","click"])document.addEventListener(type,e=>events.push({type,x:e.clientX,y:e.clientY,target:e.target.id}));</script></body></html>`;
const context = { sessionID: 'fixture-session', messageID: 'fixture-turn', directory: root, agent: 'fixture' };

async function run() {
  try {
    await app.whenReady();
    app.dock?.hide();
    const partition = session.fromPartition('browser-upgrade', { cache: false });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.webRequest.onBeforeRequest((_details, callback) => {
      const url = new URL(_details.url);
      callback({ cancel: !['about:', 'data:'].includes(url.protocol) && url.hostname !== '127.0.0.1' });
    });
    window = new BrowserWindow({ width: 800, height: 600, show: false,
      webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL('about:blank');

    surfaces = createBrowserSurfaceManager({ createPopoutWindow: () => { throw new Error('Unexpected popup'); },
      emitToWindow() {}, getWindowById: id => id === window.id ? window : null,
      getManualBrowserContext: () => ({ contextKey: 'fixture', partition: 'browser-upgrade' }) });
    bridge = createBrowserCdpBridge({ crypto, createWebSocketServer: options => {
        return new WebSocketServer(options);
      },
      onAgentInput: input => surfaces.showAgentInput(input.leaseId, input),
      onBeforeCommand: async ({ leaseId, method }) => {
        if (method === 'Input.dispatchMouseEvent') return surfaces.prepareAgentInput(leaseId);
        if (['Page.captureScreenshot', 'DevRyan.captureAttached'].includes(method)) return surfaces.setAgentCursorSuppressed(leaseId, true);
      },
      onAfterCommand: ({ leaseId, method }) => {
        if (['Page.captureScreenshot', 'DevRyan.captureDetached'].includes(method)) return surfaces.setAgentCursorSuppressed(leaseId, false);
      },
    });
    http = createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/fixture')) { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        let body = ''; for await (const chunk of req) body += chunk;
        assert.ok(body.length < 8192);
        const scope = JSON.parse(body);
        assert.deepEqual(scope, { opencodeSessionID: context.sessionID, messageID: context.messageID, directory: root, agent: context.agent });
        let result;
        if (req.url.endsWith('/resolve')) result = { previewUrl: `${origin}/fixture` };
        else if (req.method === 'DELETE') {
          bridge.closeLease(active.leaseId);
          active = null;
          result = { ok: true };
        } else if (req.url.endsWith('/touch')) result = bridge.touchLease(active.leaseId);
        else {
          if (!active || !bridge.getLeaseStatus(active.leaseId).ok) {
            const leaseId = `fx_${crypto.randomBytes(4).toString('hex')}`;
            evidence.leaseIds.push(leaseId);
            const surface = surfaces.createLeaseSurface(window, { leaseId, browserPartition: 'browser-upgrade' });
            await surface.webContents.loadURL('about:blank');
            surfaces.layout(window, { surfaceId: surface.snapshot.surfaceId, visible: true, bounds: { x: 0, y: 0, width: 640, height: 480 } });
            surfaces.layout(window, { surfaceId: surface.snapshot.surfaceId, visible: false });
            active = await bridge.createLease({ leaseId, onClosed: detail => { console.log('Lease closed', JSON.stringify(detail)); surfaces.releaseLease(leaseId, 'fixture'); } });
            assert.equal(bridge.bindLeaseGuest(leaseId, surface.webContents).ok, true);
            active.previewUrl = `${origin}/fixture`;
          }
          result = active;
        }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${http.address().port}`;
    process.env.DEVRYAN_BROWSER_CDP_DISCOVERY_URL = `${origin}/api/desktop/browser-cdp`;
    process.env.DEVRYAN_BROWSER_CDP_TOKEN = token;
    process.env.DEVRYAN_AGENT_BROWSER_BIN = path.join(installRoot, 'node_modules/agent-browser/bin', `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
    plugin = await DevRyanBrowserPlugin();
    const call = async input => {
      console.log('Checking', input.command, input.args?.[0] || '');
      const result = await plugin.tool.devryan_browser.execute(input, { ...context, abort: new AbortController().signal });

      evidence.results.push({ input, result, page: active && await surfaces.surfaceForLease(active.leaseId)?.view.webContents.executeJavaScript('({url:location.href,text:document.querySelector("#result")?.textContent,value:document.querySelector("#name")?.value,events:window.events})') });
      return result;
    };
    evidence.versions.agentBrowser = JSON.parse(await fs.readFile(path.join(installRoot, 'node_modules/agent-browser/package.json'))).version;
    evidence.versions.electron = process.versions.electron;
    evidence.versions.chromium = process.versions.chrome;
    const common = [
      { command: 'open', args: [`${origin}/fixture`] }, { command: 'snapshot', args: ['-i'] },
      { command: 'fill', args: ['#name', 'Verified'] }, { command: 'click', args: ['#save'] },
      { command: 'inspect', selector: '#result', styles: ['color'] },
      { command: 'eval', args: ['document.querySelector("#result").textContent'] },
      { command: 'screenshot', args: [path.join(root, 'common.png')] },
    ];
    for (const input of common) await call(input);
    assert.match(evidence.results.find(row => row.input.command === 'eval').result, /Verified/);
    assert.ok((await fs.stat(path.join(root, 'common.png'))).size > 100);
    evidence.checks.push('actual CLI navigation, interactive snapshot, fill/click, inspect/eval, hidden screenshot');
    surfaces.layout(window, { surfaceId: surfaces.surfaceForLease(active.leaseId).surfaceId, visible: false });
    if (evidence.versions.agentBrowser === '0.38.1') {
      const compare = JSON.parse(await call({ command: 'sequence', timeout_ms: 120000, steps: [
        { command: 'snapshot', args: ['-i', '--delta'] }, { command: 'snapshot', args: ['-i', '--delta'] },
        { command: 'eval', args: ['document.querySelector("#save").textContent="Save updated"'] },
        { command: 'snapshot', args: ['-i', '--delta'] },
        { command: 'screenshot', args: ['--if-changed', path.join(root, 'changed.png')] },
        { command: 'screenshot', args: ['--if-changed', '--threshold', '0.01', path.join(root, 'unchanged.png')] },
        { command: 'click', args: ['#save', '--human'] },
      ] }));
      assert.match(compare.results[1].output, /unchanged/i);
      assert.match(compare.results[3].output, /Save updated/);
      assert.match(compare.results[5].output, /Screenshot unchanged/);
      assert.equal(await fs.stat(path.join(root, 'unchanged.png')).then(() => true, () => false), false);
      const originalRef = /button "Save" \[ref=(e\d+)\]/.exec(compare.results[0].output)?.[1];
      assert.ok(originalRef);
      assert.ok(compare.results[3].output.includes(`[ref=${originalRef}]`), 'Same node keeps its ref after a text change');
      const replacement = JSON.parse(await call({ command: 'sequence', steps: [
        { command: 'eval', args: ['document.querySelector("#save").outerHTML=document.querySelector("#save").outerHTML'] },
        { command: 'snapshot', args: ['-i', '--delta', '--full'] },
      ] }));
      const replacementRef = /button "Save updated" \[ref=(e\d+)\]/.exec(replacement.results[1].output)?.[1];
      assert.ok(replacementRef && replacementRef !== originalRef);
      await assert.rejects(call({ command: 'get', args: ['text', `@${originalRef}`] }));
      await call({ command: 'open', args: [`${origin}/fixture?navigation`] });
      await assert.rejects(call({ command: 'get', args: ['text', `@${replacementRef}`] }));
      await call({ command: 'snapshot', args: ['-i', '--delta'] });
      evidence.checks.push('persistent refs survive same-node updates, invalidate after replacement/navigation, full baseline refresh');
      evidence.checks.push('snapshot delta baseline/unchanged/change; conditional screenshot skip; human pointer click');
      // The user observation path captures the same hidden surface during recording.
      let observationFrames = 0;
      const stopObservation = surfaces.subscribeLeaseFrames(active.leaseId, {
        onFrame: frame => { if (frame.length > 0) observationFrames++; },
      });
      try {
        for (const extension of ['webm', 'mp4']) {
          const recording = JSON.parse(await call({ command: 'sequence', timeout_ms: 120000, steps: [
            { command: 'record', args: ['start', path.join(root, `recording-${extension}.${extension}`), '--fps', '10', '--cursor', '--contact-sheet'] },
            { command: 'open', args: [`${origin}/fixture?record=${extension}`] },
            { command: 'drag', args: ['#box', '#drop', '--human'] },
            { command: 'eval', args: ['document.querySelector("#result").textContent'] },
            { command: 'fill', args: ['#name', extension] }, { command: 'click', args: ['#save', '--human'] },
            { command: 'wait', args: ['1000'] }, { command: 'record', args: ['stop'] },
            { command: 'inspect', selector: '#result' },
          ] }));
          assert.match(recording.results[3].output, /Dropped/);
          assert.equal(evidence.results.at(-1).page.text, extension);
          assert.ok((await fs.stat(path.join(root, `recording-${extension}.${extension}`))).size > 100);
        }
      } finally { stopObservation(); }
      assert.ok(observationFrames > 0);
      evidence.checks.push('WebM/MP4 recording, cursor/contact sheets, simultaneous observation, interaction after capture detach');
    }
    await call({ command: 'close' });
    assert.equal(bridge.status().leaseCount, 0);
    evidence.checks.push('explicit close releases bridge and hidden surface');
    if (evidence.versions.agentBrowser === '0.38.1') {
      const launcher = fileURLToPath(new URL(`../../../web/runtime/${process.platform}-${process.arch}/DevRyan-execution-${process.platform}-${process.arch}`, import.meta.url));
      assert.equal(process.platform, 'darwin', 'Native fixture currently requires macOS');
      assert.equal(await verifySessionExecutionLauncher({ launcher }), true);
      for (const cancelled of [false, true]) {
        const profile = path.join(root, `worker-${cancelled}.sb`);
        const receipt = path.join(root, `termination-${cancelled}.json`);
        await fs.mkdir(path.join(installRoot, 'agent-browser'), { recursive: true });
        await fs.writeFile(profile, sessionExecutionProfile({ viewDirectory: root, scratchDirectory: path.join(root, 'home'), socketDirectory: root }));
        const file = path.join(root, `confined-${cancelled}.webm`);
        const env = { ...process.env, TMPDIR: path.join(root, 'home'), DEVRYAN_EXECUTION_CACHE: root, DEVRYAN_EXECUTION_WORKER: '1',
          DEVRYAN_EXECUTION_BROWSER_SCOPE: JSON.stringify({ opencodeSessionID: context.sessionID, messageID: context.messageID, directory: root, agent: context.agent }),
          DYLD_INSERT_LIBRARIES: `${launcher}-spawn.dylib` };
        const child = spawn(launcher, [root, path.join(root, 'home'), profile, receipt, '--',
          process.env.DEVRYAN_BROWSER_UPGRADE_NODE, fileURLToPath(new URL('./upgrade-worker.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
        child.stdin.end(JSON.stringify({ context, protectedFile: path.join(installRoot, 'worker-must-not-write'), cancelAfterMs: cancelled ? 2500 : null,
          invocation: { command: 'sequence', timeout_ms: 20000, steps: [
            { command: 'open', args: [`${origin}/fixture`] },
            { command: 'record', args: ['start', file, '--cursor', '--contact-sheet', '--fps', '10'] },
            { command: 'fill', args: ['#name', 'confined'] }, { command: 'click', args: ['#save', '--human'] },
            { command: 'eval', args: ['document.querySelector("#result").textContent'] },
            { command: 'wait', args: [cancelled ? '10000' : '1000'] }, { command: 'record', args: ['stop'] },
          ] } }));
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert.equal(code, 0, errors);
        const termination = JSON.parse(await fs.readFile(receipt));
        assert.equal(termination.confined, true); assert.equal(termination.terminated, true);
        assert.ok((await fs.stat(file)).size > 100);
        evidence.results.push({ confined: true, cancelled, result: JSON.parse(output), termination });
        // The native supervisor has ended the daemon; its socket disconnect closes the lease.
        for (let attempt = 0; bridge.status().leaseCount && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(bridge.status().leaseCount, 0);
      }
      evidence.checks.push('native confined sequence and cancellation finalize recordings; write isolation; supervisor termination; lease cleanup');
    }
    evidence.status = 'passed';
  } catch (error) { evidence.error = error.stack; }
  finally {
    if (active && plugin && bridge.getLeaseStatus(active.leaseId).ok) await plugin.tool.devryan_browser.execute({ command: 'close', timeout_ms: 3000 }, { ...context, abort: AbortSignal.timeout(3000) }).catch(() => {});
    bridge?.closeAll(); surfaces?.closeAll(); window?.destroy();
    if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify({ status: evidence.status, checks: evidence.checks, error: evidence.error }) + '\n');
    if (evidence.status === 'passed') app.quit();
    else app.exit(1);
  }
}
void run().catch(error => { console.error(error); app.exit(1); });
