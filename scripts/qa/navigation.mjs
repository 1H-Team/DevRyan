import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CdpConnection, evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { PERF_PARENT_SESSION_ID, PERF_CHILD_SESSION_IDS } from '../perf/fixture-session-seeds.mjs';

/** Disposable fixture diagnosis. CPU profiles contain fixture code/data only. */
export async function runNavigationQa({ cdp, fixture, profilePort, output, check, screenshot }) {
  const timings = [], clicks = [], health = [];
  const requests = new Map();
  const origin = await evaluate(cdp, 'location.origin');
  const offRequest = cdp.on('Network.requestWillBeSent', ({ requestId, request, timestamp, wallTime, initiator }) => {
    if (!request.url.includes('/session-retention/selection')) return;
    requests.set(requestId, { timestamp, wallTime, requestID: request.headers['x-devryan-selection-request'],
      initiator: initiator.type, frames: initiator.stack?.callFrames?.slice(0, 8).map(frame => ({ functionName: frame.functionName, lineNumber: frame.lineNumber })) });
  });
  const offResponse = cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (!requests.has(requestId)) return;
    const request = requests.get(requestId);
    const timing = response.timing;
    timings.push({ ...request, status: response.status, timing,
      // Keep raw CDP phases; pre-send includes socket/connection work.
      preSendMs: timing?.sendStart ?? null,
      queueBeforeRequestMs: timing ? Math.max(0, (timing.requestTime - request.timestamp) * 1000) : null,
      waitMs: timing ? timing.receiveHeadersStart - timing.sendEnd : null });
  });
  const targets = await fetch(`http://127.0.0.1:${profilePort}/json/list`).then(response => response.json());
  const profiler = await CdpConnection.connect(targets[0].webSocketDebuggerUrl);
  await profiler.send('Profiler.enable');
  await profiler.send('Profiler.start');
  const initialized = await profiler.send('Runtime.evaluate', { expression: `globalThis.__navigationDelay = process.getBuiltinModule('perf_hooks').monitorEventLoopDelay({resolution:20}); __navigationDelay.enable();` });
  if (initialized.exceptionDetails) { profiler.close(); offRequest(); offResponse(); throw new Error('Could not start isolated event-loop monitor'); }
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    const started = performance.now();
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
      health.push({ at: new Date().toISOString(), ms: performance.now() - started, status: response.status });
    } catch { health.push({ at: new Date().toISOString(), ms: performance.now() - started, status: 'failed' }); }
    finally { sampling = false; }
  }, 250);
  const ui = createQaUiDriver(cdp);
  const select = async id => {
    if (id !== PERF_PARENT_SESSION_ID) {
      await ui.waitFor('expanded child session row', async () => {
        if (await evaluate(cdp, `Boolean(document.querySelector('[data-session-row="${id}"]'))`)) return true;
        const label = await evaluate(cdp, `(() => { const row=document.querySelector('[data-session-row="${PERF_PARENT_SESSION_ID}"]'); return [...(row?.querySelectorAll('button') ?? [])].map(b=>b.getAttribute('aria-label')).find(label=>label?.toLowerCase().includes('expand')); })()`);
        if (label) await ui.click({ selector: `[data-session-row="${PERF_PARENT_SESSION_ID}"] button`, label });
        return false;
      });
    }
    clicks.push({ at: new Date().toISOString(), id });
    const started = performance.now();
    await ui.click({ selector: `[data-session-row="${id}"] [data-session-select]` });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(cdp, `new URL(location.href).searchParams.get('session') === ${JSON.stringify(id)} && !document.querySelector('[data-session-row="${id}"] [aria-busy="true"]') && Boolean(document.querySelector('[data-message-id="msg_user_${id}"]'))`)) {
        clicks.at(-1).appliedMs = performance.now() - started;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Session did not apply within the fixture observation window');
  };
  try {
    // Exercise real hot paths with large, bounded history and simultaneous SSE.
    for (const id of PERF_CHILD_SESSION_IDS) fixture.seedHistory(id, { turns: 200, textBytes: 8192 });
    await check('navigation with concurrent streams and cold history', async () => {
      fixture.startScenario('four-stream');
      await ui.waitExpression('sidebar parent row after stream start', `Boolean(document.querySelector('[data-session-row="${PERF_PARENT_SESSION_ID}"]'))`);
      const until = performance.now() + 60_000;
      do {
        for (const id of [...PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID, PERF_CHILD_SESSION_IDS[0]]) {
          await select(id);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } while (performance.now() < until);
      fixture.stopScenario();
    });
    await screenshot('navigation-complete');
  } finally {
    clearInterval(timer); offRequest(); offResponse();
    const delay = await profiler.send('Runtime.evaluate', { expression: '({maxMs:__navigationDelay.max/1e6,meanMs:__navigationDelay.mean/1e6})', returnByValue: true });
    const { profile } = await profiler.send('Profiler.stop');
    await writeFile(path.join(output, 'navigation.cpuprofile'), JSON.stringify(profile));
    profiler.close();
    await writeFile(path.join(output, 'navigation-timings.json'), JSON.stringify({ clicks, timings, health, eventLoopDelay: delay.result.value }, null, 2));
  }
  return { clicks, timings, health, profile: 'navigation.cpuprofile' };
}
