import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

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
  let phase;
  const begin = (name, limit, initial = false) => {
    check();
    phase = { name, limit, documents: initial && initialLoaderId ? [{ url: sanitizeUrl(initialUrl), loaderId: initialLoaderId }] : [] };
    phases.push(phase);
  };
  const check = () => {
    if (phase) assert.ok(phase.documents.length <= phase.limit, `Excess committed documents during ${phase.name}`);
  };
  begin(terminal ? 'terminal-startup' : 'startup', terminal ? 2 : 3, true);
  const remove = cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame || frame.parentId) return;
    if (frame.loaderId && phase.documents.some(row => row.loaderId === frame.loaderId)) return;
    // Bound retained evidence even when a renderer loops faster than the next probe.
    if (phase.documents.length <= phase.limit) phase.documents.push({ url: sanitizeUrl(frame.url), loaderId: frame.loaderId ?? null });
  });
  return { phases, check, handoff: name => begin(name, 1), complete: remove };
}

function sanitizeUrl(raw) {
  try { const url = new URL(raw); return url.protocol === 'data:' ? 'data:startup-document' : `${url.origin}${url.pathname}`; }
  catch { return 'unavailable'; }
}
