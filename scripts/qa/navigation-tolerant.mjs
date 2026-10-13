import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { assertReleaseNavigationPhase } from './release-startup-contract.mjs';

/** Only callers that own a read-only expression may use this retry path. */
export async function readThroughNavigation(cdp, expression, { deadline, check = () => {} }) {
  for (;;) {
    check();
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, 'Read-only probe deadline expired');
    try {
      const value = await evaluate(cdp, expression, { timeoutMs: remaining });
      check();
      assert.ok(performance.now() < deadline, 'Read-only probe deadline expired');
      return value;
    } catch (error) {
      if (error.message !== 'Inspected target navigated or closed') throw error;
      check();
      assert.ok(performance.now() < deadline, 'Read-only probe deadline expired');
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))));
    }
  }
}

/** Count committed top-level documents, not provisional requests or subframes. */
export function observeReleaseNavigation(cdp, initialUrl, { terminal = false, initialLoaderId = null } = {}) {
  const phases = [];
  let phase, authentication, authenticationUsed = false;
  let currentUrl = initialUrl;
  const begin = (name, limit, initial = false) => {
    check();
    phase = { name, limit, documents: initial && initialLoaderId ? [{ url: sanitizeUrl(initialUrl), loaderId: initialLoaderId }] : [] };
    phases.push(phase);
  };
  const check = () => {
    if (phase) assertReleaseNavigationPhase(phase);
  };
  begin(terminal ? 'terminal-startup' : 'startup', terminal ? 2 : 3, true);
  const initialized = ({ storageId, key, newValue, oldValue }, added) => {
    if (phase.name !== 'startup' || authenticationUsed || authentication) return;
    let origin;
    try { origin = new URL(currentUrl).origin; } catch { return; }
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
      || storageId?.isLocalStorage !== true || storageId.securityOrigin !== origin
      || key !== 'devryan.auth.principalId' || newValue !== 'local-admin'
      || (!added && oldValue !== 'anonymous')) return;
    authentication = { origin, previousPrincipal: added ? 'missing' : 'anonymous', principal: 'local-admin',
      sourceLoaderId: phase.documents.at(-1)?.loaderId ?? null };
  };
  const removers = [
    cdp.on('DOMStorage.domStorageItemAdded', event => initialized(event, true)),
    cdp.on('DOMStorage.domStorageItemUpdated', event => initialized(event, false)),
  ];
  removers.push(cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame || frame.parentId) return;
    if (frame.loaderId && phase.documents.some(row => row.loaderId === frame.loaderId)) return;
    const document = { url: sanitizeUrl(frame.url), loaderId: frame.loaderId ?? null };
    if (phase.name === 'startup' && authentication && !authenticationUsed
      && document.loaderId && document.loaderId !== authentication.sourceLoaderId
      && document.url.startsWith(`${authentication.origin}/`)) {
      document.authenticationReload = authentication;
      authenticationUsed = true;
    }
    authentication = null;
    currentUrl = frame.url;
    // Retain the first excess document, including after the one evidenced authentication reload.
    const ordinaryCount = phase.documents.filter(row => !row.authenticationReload).length;
    if (ordinaryCount <= phase.limit) phase.documents.push(document);
  }));
  return { phases, check, handoff: name => { begin(name, 1); authentication = null; }, complete: () => removers.forEach(remove => remove()) };
}


function sanitizeUrl(raw) {
  try { const url = new URL(raw); return url.protocol === 'data:' ? 'data:startup-document' : `${url.origin}${url.pathname}`; }
  catch { return 'unavailable'; }
}
