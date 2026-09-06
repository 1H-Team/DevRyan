import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

export const QA_COMPACTION_COMPOSER = 'textarea[data-chat-input="true"]';
export const QA_QUEUE_MODE_CONTROL = '[role="checkbox"][aria-label="Queue Messages by Default"]';
export const QA_QUEUE_MODE_STATE = `(() => {
  const controls=[...document.querySelectorAll(${JSON.stringify(QA_QUEUE_MODE_CONTROL)})];
  if(controls.length!==1)return null;
  const checkbox=controls[0], group=checkbox.closest('[role="button"][aria-pressed]');
  const checked=checkbox.getAttribute('aria-checked'), pressed=group?.getAttribute('aria-pressed');
  if(!['true','false'].includes(checked)||checked!==pressed)return null;
  return {enabled:checked==='true',checked,pressed};
})()`;

// This reads the mounted React control; persisted preferences are not live state.
export async function readQaManualCompactionQueueMode({ cdp, ui }) {
  await ui.click({ label: 'Settings' });
  try {
    await ui.click({ selector: '[data-settings-view] button', text: 'Appearance' });
    const state = await ui.waitExpression('authoritative Queue Messages by Default control', QA_QUEUE_MODE_STATE);
    return { source: 'rendered-settings-control', observedAt: Date.now(), origin: await evaluate(cdp, 'location.origin'), ...state };
  } finally {
    await ui.click({ selector: '[data-settings-view] button', label: 'Back' });
    await ui.waitExpression('chat restored after queue preference observation',
      `!document.querySelector('[data-settings-view]') && Boolean(document.querySelector(${JSON.stringify(QA_COMPACTION_COMPOSER)}))`);
  }
}

export function qaManualCompactionKey(queueModeEnabled) {
  assert.equal(typeof queueModeEnabled, 'boolean', 'The actual queue mode must be observed before submission');
  return { key: 'Enter', code: 'Enter', modifiers: queueModeEnabled ? 2 : 0, windowsVirtualKeyCode: 13 };
}

// Retain only exact-session request identity and bounded response/failure metadata.
// Network must already be enabled by the owned runner. No request/response bodies,
// headers, query parameters, redirects or unrelated traffic enter the receipt.
export function observeQaManualCompactionRequest({ cdp, origin, sessionID, deadline, receipt }) {
  const expectedOrigin = new URL(origin).origin;
  assert.match(sessionID, /^ses_[a-zA-Z0-9]{1,160}$/);
  assert.ok(Number.isFinite(deadline) && deadline > Date.now(), 'The existing QA deadline has expired');
  const expectedPath = `/api/session/${sessionID}/summarize`;
  const matches = raw => {
    try { const url = new URL(raw); return url.origin === expectedOrigin && url.pathname === expectedPath; }
    catch { return false; }
  };
  const identity = raw => typeof raw === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(raw) ? raw : null;
  const timestamp = value => Number.isFinite(value) ? value : null;
  let armed = false, closed = false, requestTimer, resolveAcknowledgement;
  const acknowledgement = new Promise(resolve => { resolveAcknowledgement = resolve; });
  const wake = () => resolveAcknowledgement();
  const fail = reason => { receipt.failure = reason; receipt.outcome = 'failed'; wake(); };
  const failMissingRequest = () => {
    if (receipt.matchingRequestCount || receipt.failure) return;
    receipt.requestFailureObservedAt = Date.now();
    fail('summarize-request-unobserved-at-request-deadline');
  };
  receipt.requests = [];
  receipt.matchingRequestCount = 0;
  receipt.outcome = 'not-submitted';
  const unsubscribers = [
    cdp.on('Network.requestWillBeSent', event => {
      if (!armed || event.request?.method !== 'POST' || !matches(event.request?.url)) return;
      receipt.matchingRequestCount = Math.min(3, receipt.matchingRequestCount + 1);
      if (receipt.matchingRequestCount === 1) clearTimeout(requestTimer);
      if (receipt.matchingRequestCount > 1) fail('duplicate-summarize-request');
      if (receipt.requests.length >= 2) return;
      const requestId = identity(event.requestId);
      receipt.requests.push({ requestId, method: 'POST', path: expectedPath,
        observedAt: Date.now(), timestamp: timestamp(event.timestamp) });
      if (!requestId) fail('invalid-request-identity');
      else if (!receipt.failure) receipt.outcome = 'request-observed';
    }),
    cdp.on('Network.responseReceived', event => {
      const request = receipt.requests.find(item => item.requestId === event.requestId);
      if (!request) return;
      if (!matches(event.response?.url)) { fail('response-origin-or-session-mismatch'); return; }
      const status = event.response?.status;
      request.response = { observedAt: Date.now(), timestamp: timestamp(event.timestamp),
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
      if (request.response.status === null) fail('invalid-response-status');
      else if (status < 200 || status >= 300) fail('summarize-http-rejected');
      else if (!receipt.failure) { receipt.outcome = 'http-accepted'; wake(); }
    }),
    cdp.on('Network.loadingFailed', event => {
      const request = receipt.requests.find(item => item.requestId === event.requestId);
      if (!request) return;
      request.failure = { observedAt: Date.now(), timestamp: timestamp(event.timestamp), canceled: event.canceled === true,
        code: typeof event.errorText === 'string' && /^net::ERR_[A-Z0-9_]{1,80}$/.test(event.errorText) ? event.errorText : 'network-failure' };
      fail('summarize-network-failed');
    }),
  ];
  const timer = setTimeout(() => {
    if (receipt.outcome !== 'http-accepted' && !receipt.failure) {
      if (armed && !receipt.matchingRequestCount) failMissingRequest();
      else fail(receipt.matchingRequestCount ? 'summarize-response-unobserved-at-deadline' : 'summarize-request-unobserved-at-deadline');
    }
  }, Math.max(1, deadline - Date.now()));
  const assertHealthy = () => { assert.equal(receipt.failure, undefined, `Manual compaction submission failed: ${receipt.failure}`); };
  return {
    arm: () => {
      assert.ok(!armed && !closed, 'A manual attempt can only be armed once');
      armed = true; receipt.outcome = 'awaiting-request';
      receipt.requestArmedAt = Date.now();
      receipt.requestObservationBudgetMs = 30_000;
      receipt.requestDeadline = Math.min(deadline, receipt.requestArmedAt + receipt.requestObservationBudgetMs);
      requestTimer = setTimeout(failMissingRequest, Math.max(1, receipt.requestDeadline - Date.now()));
    },
    assertHealthy,
    waitForAcknowledgement: async () => { await acknowledgement; assertHealthy(); assert.equal(receipt.outcome, 'http-accepted'); },
    close: () => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(requestTimer); unsubscribers.forEach(unsubscribe => unsubscribe());
      receipt.closedAt = Date.now();
      if (!['http-accepted','failed'].includes(receipt.outcome)) {
        receipt.outcome = 'failed';
        receipt.failure = armed ? 'submission-observation-interrupted' : 'submission-not-attempted';
      }
      wake();
    },
  };
}

// One completed command and one keyboard submission. The caller observes native
// boundaries concurrently with HTTP events; HTTP acceptance is never a boundary.
export async function withQaManualCompactionSubmission({ cdp, ui, origin, sessionID, queueModeEnabled,
  deadline, receipt, persist = async () => {}, beforeKey }, observeBoundary) {
  const key = qaManualCompactionKey(queueModeEnabled);
  Object.assign(receipt, { sessionID, origin: new URL(origin).origin, queueModeEnabled, startedAt: Date.now(),
    command: '/compact ', key, deadline });
  let observer;
  try {
    observer = observeQaManualCompactionRequest({ cdp, origin, sessionID, deadline, receipt });
    await ui.waitExpression('empty exact manual compaction composer and queue', `(() => {
      const e=document.querySelector(${JSON.stringify(QA_COMPACTION_COMPOSER)});
      return location.origin===${JSON.stringify(new URL(origin).origin)} && new URL(location.href).searchParams.get('session')===${JSON.stringify(sessionID)}
        && Boolean(e && !e.disabled && e.value==='' && !document.querySelector('button[aria-label="Remove from Queue"]'));
    })()`);
    await ui.type('/compact ', QA_COMPACTION_COMPOSER);
    receipt.typedAt = Date.now();
    if (beforeKey) await beforeKey();
    assert.equal(await evaluate(cdp, `location.origin===${JSON.stringify(new URL(origin).origin)} && new URL(location.href).searchParams.get('session')===${JSON.stringify(sessionID)}
      && document.activeElement===document.querySelector(${JSON.stringify(QA_COMPACTION_COMPOSER)}) && document.activeElement.value==='/compact '
      && !document.querySelector('button[aria-label="Remove from Queue"]')`),
      true, 'Manual command lost its exact focused composer');
    assert.ok(Date.now() < deadline, 'The existing QA deadline expired before manual submission');
    observer.arm();
    receipt.keyStartedAt = Date.now();
    await ui.key(key.key, key);
    receipt.keyAcknowledgedAt = Date.now();
    const result = await observeBoundary(observer);
    await observer.waitForAcknowledgement();
    observer.assertHealthy();
    return result;
  } catch (error) {
    receipt.attemptError = receipt.failure ?? 'submission-or-boundary-observation-failed';
    throw error;
  } finally {
    observer?.close();
    await persist();
  }
}
