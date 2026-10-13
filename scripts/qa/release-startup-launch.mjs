import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { startOwnedProcess, reservePort } from './process.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { captureFirstDocumentStartup, observeStartupNavigation, parseStartupPhaseLogs } from '../perf/electron-lifecycle-benchmark.mjs';
import { observeNativeStartupSubscription, readNativeStartupLogs } from './native-startup-benchmark.mjs';
import { collectGapPaths, readRecordsFromPaths } from '../journal.mjs';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { prepareReleaseService } from './release-startup-service.mjs';
import { readThroughNavigation, observeReleaseNavigation } from './navigation-tolerant.mjs';

export const waitReleaseStartup = async (label, read, check = () => {}, timeoutMs = 120_000) => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    check(); const result = await read(deadline); check();
    assert.ok(performance.now() < deadline, `Timed out: ${label}`);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

/** Use the renderer's authenticated same-origin transport; never extract a cookie or bootstrap token. */
export async function releaseRendererRequest(cdp, pathname, init = {}, { deadline = performance.now() + 30_000, check } = {}) {
  assert.ok(pathname.startsWith('/api/') || pathname === '/health');
  const expression = `(async () => { const response = await fetch(${JSON.stringify(pathname)}, {
    ...${JSON.stringify(init)}, signal: AbortSignal.timeout(10000),
    headers: {'content-type':'application/json','X-DevRyan-CSRF':'1'} });
    return {status: response.status, body: await response.json()}; })()`;
  return !init.method || init.method === 'GET' ? readThroughNavigation(cdp, expression, { deadline, check }) : evaluate(cdp, expression);
}

export async function captureReleaseStartupScreenshot(launch, directory, name, identity) {
  assert.match(name, /^DevRyan-[a-z0-9.-]+\.png$/);
  const result = await launch.cdp.send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(result.data, 'base64');
  assert.ok(bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
  const { sourceCommit, dmgSha256, manifestSha256, appSha256 } = identity;
  return { name, sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit, dmgSha256, manifestSha256, appSha256 };
}

export async function assertReleaseRetainedSession(launch, profile, id) {
  const result = await launch.request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
  assert.equal(result.status, 200);
  const session = result.body.find(row => row.id === id);
  assert.ok(session, 'Saved history disappeared');
  const messages = await launch.request(`/api/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(profile.workspace)}`);
  assert.equal(messages.status, 200);
  assert.ok(messages.body.some(row => row.info?.role === 'assistant' && row.info?.time?.completed
    && row.parts?.some(part => part.type === 'text' && part.text?.includes('DevRyan live QA ready.'))), 'Completed fixture response disappeared');
  await launch.ui.click({ selector: `[data-session-row=${JSON.stringify(id)}] [data-session-select]` });
  await launch.ui.waitVisibleText('DevRyan live QA ready.');
}

/** Runs in the renderer; setup has no selected model or provider-dependent copy. */
export function readReleaseSetupInterfaceState() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (element.disabled || rect.width <= 0 || rect.height <= 0) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return false;
    }
    return true;
  };
  const available = selector => [...document.querySelectorAll(selector)].some(visible);
  return { documentReady: document.readyState === 'complete', documentVisible: document.visibilityState === 'visible',
    startupReady: window.__openchamberStartupReady === true,
    composer: available('textarea'), newChat: available('button[aria-label="New Chat"]'),
    modelPicker: available('.model-controls__model-trigger') };
}

export async function launchReleaseStartup(artifact, profile, { setupOnly = false, serviceEnvironmentManaged = false, expectedFailure, onFailure, onStop } = {}) {
  // Released builds can automatically register a service before the renderer exists.
  requireDisposableMacRunner();
  const startedAt = performance.now(), debugPort = await reservePort();
  const logOffset = readNativeStartupLogs(null, profile.env.HOME).length;
  let app, serviceEnvironment, stopping, cdp, audit, navigation, subscription, startup, exceptions = 0, removeErrors;
  const stop = () => stopping ??= (async () => {
    removeErrors?.(); audit?.complete(); navigation?.complete(); subscription?.close(); cdp?.close();
    try {
      if (app) {
        await app.stop(); await app.auditStopped();
        assert.deepEqual(app.getCleanupEvidence().remainingProcessIds, []);
      }
    } finally {
      try { await serviceEnvironment?.cleanup(); }
      finally { await onStop?.({ app, navigation: navigation?.phases ?? [] }); }
    }
  })();
  try {
    serviceEnvironment = serviceEnvironmentManaged ? null : await prepareReleaseService(profile);
    app = startOwnedProcess(artifact.binary, [`--remote-debugging-port=${debugPort}`, '--use-mock-keychain'],
      { cwd: profile.workspace, env: profile.env });
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    audit = observeStartupNavigation(cdp, startedAt, target.url);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    navigation = observeReleaseNavigation(cdp, frameTree.frame.url, {
      terminal: Boolean(expectedFailure), initialLoaderId: frameTree.frame.loaderId,
    });
    subscription = observeNativeStartupSubscription(cdp, startedAt);
    removeErrors = cdp.on('Runtime.exceptionThrown', () => { exceptions++; });
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable'), cdp.send('DOMStorage.enable')]);
    const check = () => { app.check(); profile.check(); subscription.check(); navigation.check(); };
    const ui = createQaUiDriver(cdp, { checkAlive: check, timeoutMs: 60_000, navigationReads: true });
    if (expectedFailure) {
      await ui.waitVisibleText(expectedFailure);
      assert.equal(await readThroughNavigation(cdp, 'Boolean(document.querySelector("textarea"))', { deadline: performance.now() + 60_000, check }), false, 'Failed startup exposed a composer');
      assert.equal(exceptions, 0);
      return { cdp, app, ui, check, stop, navigation, startup: { outcome: 'failed', code: expectedFailure } };
    }
    const origin = await waitReleaseStartup('production renderer', async deadline => {
      const href = await readThroughNavigation(cdp, 'location.href', { deadline, check });
      return /^http:\/\/127\.0\.0\.1:\d+\//.test(href) ? new URL(href).origin : null;
    }, check);
    const request = (route, init, deadline) => releaseRendererRequest(cdp, route, init, { deadline, check });
    if (setupOnly) {
      await waitReleaseStartup('empty-profile native health', async deadline => {
        const { body } = await request('/health', undefined, deadline);
        assert.notEqual(body.openCodeStartup?.state, 'failed', 'Empty-profile startup failed');
        return body.openCodeStartup?.state === 'ready';
      }, check);
      await ui.waitReadExpression('empty-profile setup interface', `Object.values((${readReleaseSetupInterfaceState.toString()})()).every(Boolean)`);
      startup = { outcome: 'passed', setupInterface: true, uiReadyMs: performance.now() - startedAt };
    } else {
      startup = await captureFirstDocumentStartup({ cdp, origin, startedAt, checkAlive: check, navigationAudit: audit, navigationReads: true,
        runtimeUiTuple: { providerId: runtimeUiTuple.providerID, modelId: runtimeUiTuple.modelID, agent: 'builder' },
        isEventStreamReady: subscription.isReady,
        fetchCatalog: async () => { const result = await request('/api/provider'); return new Response(JSON.stringify(result.body), { status: result.status }); },
        readStartupPhases: () => parseStartupPhaseLogs(readNativeStartupLogs(app, profile.env.HOME, logOffset)) });
      if (startup.outcome !== 'passed' && startup.startupFailure?.state === 'failed' && startup.startupFailure.code) {
        throw Object.assign(Error(startup.error), { code: startup.startupFailure.code });
      }
      assert.equal(startup.outcome, 'passed', startup.error);
      assert.ok(startup.healthObservations.every(row => row.state !== 'failed'), 'A failed startup attempt cannot be erased by recovery');
      assert.ok(new Set(startup.healthObservations.filter(row => row.attempt > 0).map(row => row.attempt)).size <= 1,
        'Qualification cannot retry a failed startup attempt');
      const sessions = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
      assert.equal(sessions.status, 200); assert.ok(Array.isArray(sessions.body));
    }
    assert.equal(exceptions, 0, 'Renderer exception during production startup');
    return { cdp, app, ui, check, request, startup, navigation, subscription: subscription.evidence, stop,
      submit: async () => {
        const before = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
        assert.equal(before.status, 200);
        const beforeIds = new Set(before.body.map(row => row.id));
        await ui.click({ label: 'New Chat' });
        const calls = profile.provider.observations.length;
        await ui.send('DevRyan live QA ready.');
        await ui.waitVisibleText('DevRyan live QA ready.');
        const sessionID = await waitReleaseStartup('fixture completion and persisted session', async deadline => {
          if (profile.provider.observations.length <= calls) return null;
          const result = await request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50', undefined, deadline);
          assert.equal(result.status, 200);
          const session = result.body.find(row => !beforeIds.has(row.id));
          if (!session) return null;
          const messages = await request(`/api/session/${encodeURIComponent(session.id)}/message?directory=${encodeURIComponent(profile.workspace)}`, undefined, deadline);
          assert.equal(messages.status, 200);
          return messages.body.some(row => row.info?.role === 'assistant' && row.info?.time?.completed
            && row.parts?.some(part => part.type === 'text' && part.text.includes('DevRyan live QA ready.'))) ? session.id : null;
        }, check);
        assert.equal(exceptions, 0);
        return sessionID;
      } };
  } catch (error) {
    if (onFailure) {
      const interfaceState = cdp ? await evaluate(cdp, `(${readReleaseSetupInterfaceState.toString()})()`).catch(() => null) : null;
      try { await onFailure({ cdp, app, interfaceState, startupFailure: startup?.startupFailure,
        log: readNativeStartupLogs(app, profile.env.HOME, logOffset) }); }
      catch (evidenceError) { error.evidenceError = evidenceError; }
    }
    try { await stop(); }
    catch (cleanupError) { throw Object.assign(new Error('Failed launch cleanup', { cause: cleanupError }), { code: 'release_startup_cleanup_failed' }); }
    throw error;
  }
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
