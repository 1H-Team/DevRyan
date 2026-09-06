import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createLoopbackOpenCodeFixture, PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runQa({ runtime = 'web', scenario = 'chat', outputRoot = path.join(root, '.cache/qa'), holdMs = 0 } = {}) {
  if (!Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > 300000) throw new Error('QA inspection hold must be 0–300000 milliseconds');
  if (!['web', 'electron'].includes(runtime)) throw new Error('QA runtime must be web or electron');
  if (!['chat', 'mobile'].includes(scenario) || (scenario === 'mobile' && runtime !== 'web')) throw new Error('QA scenario must be chat, or mobile on web');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(outputRoot, `${runtime}-${scenario}-`));
  const temporary = path.join(output, 'runtime');
  const data = path.join(temporary, 'data');
  const profile = path.join(temporary, 'profile');
  const workspace = path.join(temporary, 'workspace');
  await Promise.all([data, profile, workspace].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const evidence = { schemaVersion: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), runtime, scenario,
    startedAt: new Date().toISOString(), outcome: 'failed', checks: [], consoleErrors: [], screenshots: [],
    liveProvider: 'not-run', physicalDevice: 'not-run', visualReview: 'pending' };
  const owned = [];
  let fixture;
  let cdp;
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: temporary, placeholder: '<QA_RUNTIME>' }, { path: root, placeholder: '<REPOSITORY>' }] });
  const sanitize = (text) => sanitizer.sanitizeText(String(text));
  const waitFor = async (label, action, timeout = 30000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      if (interrupted) throw new Error('QA interrupted');
      for (const process of owned) process.check();
      if (await action()) return;
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const check = async (name, action) => {
    const start = performance.now();
    console.log(JSON.stringify({ check: name, state: 'started' }));
    try { await action(); evidence.checks.push({ name, outcome: 'passed', elapsedMs: performance.now() - start }); }
    catch (error) { evidence.checks.push({ name, outcome: 'failed', elapsedMs: performance.now() - start, error: sanitize(error.message) }); throw error; }
  };
  const screenshot = async (name) => {
    const file = `${name}.png`;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, file), Buffer.from(data, 'base64'));
    evidence.screenshots.push(file);
  };
  const activateButton = async (label, touch = false) => {
    let point;
    await waitFor(`enabled ${label} control`, async () => {
      point = await evaluate(cdp, `(() => {
        const e=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)} && !e.disabled && e.getBoundingClientRect().width>0);
        if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      return point;
    });
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
  };
  try {
    execFileSync('git', ['init', '--quiet', workspace]);
    await writeFile(path.join(data, 'settings.json'), JSON.stringify({ messageStreamTransport: 'sse', lastDirectory: workspace,
      projects: [{ id: 'qa-project', path: workspace, label: 'QA workspace' }], activeProjectId: 'qa-project',
      desktopWindowState: { width: 1280, height: 800, maximized: false } }));
    fixture = await createLoopbackOpenCodeFixture({ directory: workspace });
    const debugPort = await reservePort();
    const port = await reservePort();
    const env = { ...process.env, OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile,
      OPENCHAMBER_DIST_DIR: path.join(root, 'packages/web/dist'), OPENCHAMBER_PORT: String(port),
      OPENCODE_HOST: fixture.origin, OPENCODE_SKIP_START: 'true', OPENCHAMBER_SKIP_OPENCODE_START: 'true',
      OPENCHAMBER_ELECTRON_DEV: '1', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const start = (command, args, environment = env) => {
      const process = startOwnedProcess(command, args, { cwd: root, env: environment });
      owned.push(process);
      return process;
    };
    const origin = `http://127.0.0.1:${port}`;
    const browserFlags = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
    if (runtime === 'web') {
      start('node', ['packages/web/server/index.js', '--port', String(port)]);
      await waitFor('web readiness', async () => fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false), 60000);
      start(requireElectron('electron'), [...browserFlags, 'scripts/qa/browser-shell.cjs'],
        { ...env, DEVRYAN_QA_ORIGIN: origin });
    } else if (runtime === 'electron') {
      start(requireElectron('electron'), [...browserFlags, 'packages/electron/main.mjs']);
    }
    evidence.inspection = { cdp: `http://127.0.0.1:${debugPort}`, fixture: fixture.origin };
    console.log(JSON.stringify({ output, runtime, scenario, ...evidence.inspection }));
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      if (evidence.consoleErrors.length < 100) evidence.consoleErrors.push(sanitize(exceptionDetails.exception?.description ?? exceptionDetails.text));
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' && evidence.consoleErrors.length < 100) evidence.consoleErrors.push(sanitize(args.map((arg) => arg.value ?? arg.description ?? '').join(' ')));
    });
    let transportReady = false;
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
      try { if (JSON.parse(response.payloadData).type === 'ready') transportReady = true; } catch { /* Non-JSON native socket. */ }
    });
    cdp.on('Network.responseReceived', ({ response }) => {
      if (response.url.includes('/api/global/event') && response.mimeType === 'text/event-stream' && response.status === 200) transportReady = true;
    });
    // Match the isolated server's chosen workspace before shared stores mount.
    // Web has no desktop preload to provide its initial directory.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      for (const principal of ['anonymous', 'local-admin']) {
        localStorage.setItem('devryan.user.' + principal + ':lastDirectory', ${JSON.stringify(workspace)});
      }
    ` });
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    if (runtime === 'electron') {
      await waitFor('Electron loopback origin', async () => /^http:\/\/127\.0\.0\.1:\d+/.test(await evaluate(cdp, 'location.href')));
      const appOrigin = await evaluate(cdp, 'location.origin');
      await cdp.send('Page.navigate', { url: `${appOrigin}/?session=${PERF_PARENT_SESSION_ID}` });
    }
    evidence.inspection.app = await evaluate(cdp, 'location.origin');
    if (runtime === 'web') {
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.reload');
      await loaded;
    }
    await check('selected session and composer', async () => {
      await waitFor('session row', () => evaluate(cdp, `Boolean(document.body?.innerText.includes('Performance parent'))`), 60000);
      await delay(750);
      const point = await evaluate(cdp, `(() => { const e=[...document.querySelectorAll('[data-session-row="${PERF_PARENT_SESSION_ID}"] button')].find(e=>e.innerText.trim() === 'Performance parent'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      if (!point) throw new Error('Session row not found');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await waitFor('selected transcript and composer', () => evaluate(cdp,
        `Boolean(document.querySelector('textarea') && document.querySelector('[data-message-id="msg_user_${PERF_PARENT_SESSION_ID}"]')?.textContent.includes('Run the deterministic renderer performance fixture.'))`));
    });
    if (scenario === 'mobile') {
      for (const theme of ['light', 'dark']) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        for (const [width, height] of [[390, 844], [844, 390], [768, 1024]]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
          await delay(750);
          await check(`${theme} ${width}x${height} composer and overflow`, async () => {
            const bounds = await evaluate(cdp, `(() => { const r=document.querySelector('textarea').getBoundingClientRect(); return { width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth, composer:{x:r.x,y:r.y,width:r.width,height:r.height} }; })()`);
            if (bounds.scrollWidth > bounds.width + 1 || bounds.composer.x < 0 || bounds.composer.x + bounds.composer.width > bounds.width + 1 || bounds.composer.width <= 0 || bounds.composer.y < 0 || bounds.composer.y + bounds.composer.height > bounds.height + 1) throw new Error(`Layout bounds: ${JSON.stringify(bounds)}`);
          });
          if (width < 800) {
            await check(`${theme} ${width}x${height} touch drawer`, async () => {
              await activateButton('Open Sessions', true);
              await waitFor('open drawer', () => evaluate(cdp, `Boolean(document.querySelector('aside[aria-hidden="false"]'))`));
              await delay(500);
              if (width === 390) await screenshot(`${theme}-drawer-open`);
              await activateButton('Close Sessions', true);
              await waitFor('closed drawer outside viewport', () => evaluate(cdp, `[...document.querySelectorAll('aside[aria-hidden="true"]')].every(e=>{const r=e.getBoundingClientRect();return r.right<=1 || r.left>=innerWidth-1})`));
            });
          }
          await screenshot(`${theme}-${width}x${height}`);
        }
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await check('four-session stream reaches selected transcript', async () => {
      await waitFor('renderer event transport readiness', async () => transportReady);
      await delay(500);
      fixture.startScenario('four-stream');
      const appOrigin = await evaluate(cdp, 'location.origin');
      evidence.streamEvents = {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(`${appOrigin}/api/global/event`, { signal: controller.signal });
        const decoder = new TextDecoder();
        let pending = '';
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const envelope = JSON.parse(line.slice(5));
              const type = (envelope.payload ?? envelope).type;
              evidence.streamEvents[type] = (evidence.streamEvents[type] ?? 0) + 1;
              if (!evidence.streamSample && type === 'message.part.updated') evidence.streamSample = envelope;
            }
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
      finally { clearTimeout(timer); }
      await waitFor('stream text', () => evaluate(cdp, `document.querySelector('[data-message-id="msg_assistant_${PERF_PARENT_SESSION_ID}"]')?.textContent.includes('Renderer paint fixture parent.')`));
    });
    await check('typing survives background streaming', async () => {
      await evaluate(cdp, `document.querySelector('textarea').focus()`);
      await cdp.send('Input.insertText', { text: 'QA unsent draft' });
      await delay(500);
      if (!await evaluate(cdp, `document.querySelector('textarea').value === 'QA unsent draft'`)) throw new Error('Composer lost text');
    });
    fixture.stopScenario();
    await check('send and reconcile a real composer submission', async () => {
      await delay(300);
      await evaluate(cdp, `document.querySelector('textarea').focus()`);
      await activateButton('Send Message');
      await waitFor('provider receives composer submission', async () => fixture.getState().receivedPrompts.length === 1);
      await waitFor('canonical response', () => evaluate(cdp, `document.body?.textContent.includes('QA response chunk 1.')`));
      await waitFor('provider completes', async () => fixture.getState().activePrompts === 0);
      if (!await evaluate(cdp, `document.querySelector('textarea').value === ''`)) throw new Error('Submitted draft was not cleared');
    });
    await check('cancel an active composer submission', async () => {
      await evaluate(cdp, `document.querySelector('textarea').focus()`);
      await cdp.send('Input.insertText', { text: 'QA cancellation' });
      const before = fixture.getState().abortedPrompts;
      await activateButton('Send Message');
      await waitFor('second prompt starts', async () => fixture.getState().receivedPrompts.length === 2 && fixture.getState().activePrompts === 1);
      await activateButton('Stop Generating');
      await waitFor('provider cancellation', async () => fixture.getState().abortedPrompts === before + 1 && fixture.getState().activePrompts === 0);
    });
    await check('reconnect and reopen without duplicate user messages', async () => {
      fixture.disconnectEvents();
      await waitFor('SSE reconnect', async () => fixture.getState().sseClientCount > 0);
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.reload');
      await loaded;
      await waitFor('restored response', () => evaluate(cdp, `Boolean(document.body?.textContent.includes('QA response chunk 1.'))`));
      const ids = fixture.getState().receivedPrompts.map((prompt) => prompt.messageID);
      const counts = await evaluate(cdp, `${JSON.stringify(ids)}.map(id=>[...document.querySelectorAll('[data-message-id]')].filter(e=>e.dataset.messageId===id).length)`);
      if (ids.length !== 2 || new Set(ids).size !== 2 || counts.some((count) => count !== 1)) throw new Error('Reconnection lost or duplicated a submitted turn');
      const rows = await fetch(`${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message`).then((r) => r.json());
      for (const row of rows.filter((row) => row.info.parentID === ids[0])) {
        const expected = row.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim();
        const rendered = await evaluate(cdp, `[...document.querySelectorAll('[data-message-id]')].find(e=>e.dataset.messageId===${JSON.stringify(row.info.id)})?.textContent`);
        if (!expected || !rendered?.includes(expected)) throw new Error('Reopened response lost fixture text');
      }
    });
    await delay(750);
    await screenshot('chat-idle');
    evidence.diagnostics = await evaluate(cdp, `fetch('/api/diagnostics/status').then(async r=>({httpStatus:r.status,...(r.ok?await r.json():{})}))`);
    evidence.fixture = fixture.getState();
    if (evidence.consoleErrors.length) throw new Error('Renderer console errors captured; see result.json');
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = sanitize(error.message);
    if (cdp) await screenshot('failure').catch(() => {});
  } finally {
    const holdUntil = Date.now() + holdMs;
    if (holdMs) console.log(JSON.stringify({ inspectionHoldMs: holdMs, error: evidence.error }));
    while (!interrupted && Date.now() < holdUntil) await delay(100);
    if (fixture) evidence.fixture = fixture.getState();
    cdp?.close();
    evidence.cleanupErrors = [];
    for (const process of owned.toReversed()) {
      try { await process.stop(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    }
    try { await fixture?.close(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    const logs = owned.map((process, index) => ({ index, log: sanitize(process.getLog()) }));
    await writeFile(path.join(output, 'process-logs.json'), JSON.stringify(logs, null, 2));
    evidence.finishedAt = new Date().toISOString();
    try {
      await rename(path.join(data, 'harness/journal'), path.join(output, 'journal'));
      evidence.journalDirectory = 'journal';
    } catch (error) { if (error.code !== 'ENOENT') evidence.cleanupErrors.push(sanitize(error.message)); }
    if (!evidence.cleanupErrors.length) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    }
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...sanitizer.sanitizeExportValue(evidence), revision: evidence.revision }, null, 2));
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
  console.log(JSON.stringify({ output, outcome: evidence.outcome, error: evidence.error }));
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    const args = process.argv.slice(2);
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error('Usage: bun run qa [--config <matrix.json>]');
      const { runQaMatrix } = await import('./matrix-runner.mjs');
      return runQaMatrix(args[1]);
    }
    return runQa({ runtime: process.env.DEVRYAN_QA_RUNTIME, scenario: process.env.DEVRYAN_QA_SCENARIO, holdMs: Number(process.env.DEVRYAN_QA_HOLD_MS || 0) });
  };
  run()
    .then((result) => { process.exitCode = result.outcome === 'passed' ? 0 : 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
