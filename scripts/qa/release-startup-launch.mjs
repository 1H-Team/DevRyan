import assert from 'node:assert/strict';
import path from 'node:path';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { startOwnedProcess, reservePort } from './process.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { captureFirstDocumentStartup, observeStartupNavigation, parseStartupPhaseLogs } from '../perf/electron-lifecycle-benchmark.mjs';
import { observeNativeStartupSubscription, readNativeStartupLogs } from './native-startup-benchmark.mjs';
import { collectGapPaths, readRecordsFromPaths } from '../journal.mjs';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { prepareReleaseService } from './release-startup-service.mjs';

export const waitReleaseStartup = async (label, read, check = () => {}, timeoutMs = 120_000) => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    check(); const result = await read(); if (result) return result;
    assert.ok(performance.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

/** Use the renderer's authenticated same-origin transport; never extract a cookie or bootstrap token. */
export async function releaseRendererRequest(cdp, pathname, init = {}) {
  assert.ok(pathname.startsWith('/api/') || pathname === '/health');
  return evaluate(cdp, `(async () => { const response = await fetch(${JSON.stringify(pathname)}, {
    ...${JSON.stringify(init)}, signal: AbortSignal.timeout(10000),
    headers: {'content-type':'application/json','X-DevRyan-CSRF':'1'} });
    return {status: response.status, body: await response.json()}; })()`);
}

export async function launchReleaseStartup(artifact, profile, { setupOnly = false, serviceEnvironmentManaged = false } = {}) {
  // Released builds can automatically register a service before the renderer exists.
  requireDisposableMacRunner();
  const startedAt = performance.now(), debugPort = await reservePort();
  const logOffset = readNativeStartupLogs(null, profile.env.HOME).length;
  let app, serviceEnvironment, stopping, cdp, audit, subscription, exceptions = 0, removeErrors;
  const stop = () => stopping ??= (async () => {
    removeErrors?.(); audit?.complete(); subscription?.close(); cdp?.close();
    try {
      if (app) {
        await app.stop(); await app.auditStopped();
        assert.deepEqual(app.getCleanupEvidence().remainingProcessIds, []);
      }
    } finally { await serviceEnvironment?.cleanup(); }
  })();
  try {
    serviceEnvironment = serviceEnvironmentManaged ? null : await prepareReleaseService(profile);
    app = startOwnedProcess(artifact.binary, [`--remote-debugging-port=${debugPort}`, '--use-mock-keychain'],
      { cwd: profile.workspace, env: profile.env });
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    audit = observeStartupNavigation(cdp, startedAt, target.url);
    subscription = observeNativeStartupSubscription(cdp, startedAt);
    removeErrors = cdp.on('Runtime.exceptionThrown', () => { exceptions++; });
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
    const check = () => { app.check(); profile.check(); subscription.check(); };
    const origin = await waitReleaseStartup('production renderer', async () => {
      const href = await evaluate(cdp, 'location.href').catch(() => '');
      return /^http:\/\/127\.0\.0\.1:\d+\//.test(href) ? new URL(href).origin : null;
    }, check);
    const ui = createQaUiDriver(cdp, { checkAlive: check, timeoutMs: 60_000 });
    const request = (route, init) => releaseRendererRequest(cdp, route, init);
    let startup;
    if (setupOnly) {
      await waitReleaseStartup('empty-profile native health', async () => {
        const { body } = await request('/health');
        assert.notEqual(body.openCodeStartup?.state, 'failed', 'Empty-profile startup failed');
        return body.openCodeStartup?.state === 'ready';
      }, check);
      await ui.waitExpression('empty-profile setup interface', `document.readyState==='complete'
        && window.__openchamberStartupReady===true && document.querySelector('textarea')
        && /connect|provider|model|welcome/i.test(document.body.innerText)`);
      startup = { outcome: 'passed', setupInterface: true, uiReadyMs: performance.now() - startedAt };
    } else {
      startup = await captureFirstDocumentStartup({ cdp, origin, startedAt, checkAlive: check, navigationAudit: audit,
        runtimeUiTuple: { providerId: runtimeUiTuple.providerID, modelId: runtimeUiTuple.modelID, agent: 'builder' },
        isEventStreamReady: subscription.isReady,
        fetchCatalog: async () => { const result = await request('/api/provider'); return new Response(JSON.stringify(result.body), { status: result.status }); },
        readStartupPhases: () => parseStartupPhaseLogs(readNativeStartupLogs(app, profile.env.HOME, logOffset)) });
      assert.equal(startup.outcome, 'passed', startup.error);
      assert.ok(startup.healthObservations.every(row => row.state !== 'failed'), 'A failed startup attempt cannot be erased by recovery');
      assert.ok(new Set(startup.healthObservations.filter(row => row.attempt > 0).map(row => row.attempt)).size <= 1,
        'Qualification cannot retry a failed startup attempt');
      const sessions = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
      assert.equal(sessions.status, 200); assert.ok(Array.isArray(sessions.body));
    }
    assert.equal(exceptions, 0, 'Renderer exception during production startup');
    return { cdp, app, ui, check, request, startup, subscription: subscription.evidence, stop,
      submit: async () => {
        const before = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
        assert.equal(before.status, 200);
        const beforeIds = new Set(before.body.map(row => row.id));
        await ui.click({ label: 'New Chat' });
        const calls = profile.provider.observations.length;
        await ui.send('DevRyan live QA ready.');
        await ui.waitVisibleText('DevRyan live QA ready.');
        const sessionID = await waitReleaseStartup('fixture completion and persisted session', async () => {
          if (profile.provider.observations.length <= calls) return null;
          const result = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
          assert.equal(result.status, 200);
          const session = result.body.find(row => !beforeIds.has(row.id));
          if (!session) return null;
          const messages = await request(`/api/session/${encodeURIComponent(session.id)}/message?directory=${encodeURIComponent(profile.workspace)}`);
          assert.equal(messages.status, 200);
          return messages.body.some(row => row.info?.role === 'assistant' && row.info?.time?.completed
            && row.parts?.some(part => part.type === 'text' && part.text.includes('DevRyan live QA ready.'))) ? session.id : null;
        }, check);
        assert.equal(exceptions, 0);
        return sessionID;
      } };
  } catch (error) { await stop(); throw error; }
}

export async function verifyReleaseJournal(profile) {
  const directory = path.join(profile.binding().descriptor.launch.webDataDirectory, 'harness/journal');
  const paths = await collectGapPaths(directory, { verify: true });
  assert.ok(paths.length, 'Release startup journal is missing');
  let records = 0, gaps = 0;
  for await (const row of readRecordsFromPaths(paths)) { records++; if (row.type === 'gap') gaps++; }
  assert.ok(records > 0); assert.equal(gaps, 0, 'Release startup journal has gaps');
  return gaps;
}
