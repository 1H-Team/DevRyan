import { randomUUID } from 'node:crypto';

const timings = new WeakMap();

/** Only opaque correlation and durations: never log a request body or session. */
export function selectionIngress(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/api/openchamber/session-retention/selection') return next();
  const supplied = req.headers['x-devryan-selection-request'];
  const requestID = typeof supplied === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(supplied) ? supplied : randomUUID();
  const trace = { requestID, at: new Date().toISOString(), started: performance.now(), phases: {} };
  timings.set(req, trace);
  res.setHeader('x-devryan-selection-request', requestID);
  console.info('[selection-timing]', JSON.stringify({ requestID, at: trace.at, phase: 'ingress' }));
  let finished = false;
  const complete = (phase) => {
    if (finished) return;
    finished = true;
    console.info('[selection-timing]', JSON.stringify({ requestID, at: new Date().toISOString(), phase,
      revision: trace.revision, committed: trace.committed, status: res.statusCode,
      elapsedMs: performance.now() - trace.started, ...trace.phases }));
    timings.delete(req);
  };
  res.once('finish', () => complete('finished'));
  res.once('close', () => complete('closed'));
  next();
}

export function markSelectionTiming(req, phase) {
  const trace = timings.get(req);
  if (!trace) return;
  trace.phases[phase] = performance.now() - trace.started;
  if (phase === 'gateStartMs') {
    trace.revision = Number.isSafeInteger(req.body?.revision) ? req.body.revision : undefined;
    trace.committed = req.body?.committed === true;
  }
}
