// Scenarios for the fake candidate (BH2 self-test only): every step kind, over
// the fake's toy store (toy/fake-candidate.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { PRINCIPALS, defineScenario, rawBody, step } from '../scenario.mjs';

const principals = { 'local-admin': PRINCIPALS['local-admin'], 'managed-developer': PRINCIPALS['managed-developer'] };
const as = (principal = 'local-admin') => ({ principal });

/** Every step kind once, in an order whose calls the self-test knows exactly. */
export const ALL_KINDS = defineScenario({
  id: 'fake.all-kinds', group: 'fake', description: 'every step kind against the fake candidate', principals,
  fixture: (root) => { fs.writeFileSync(path.join(root, 'seed'), 'seed\n'); },
  steps: (values) => {
    const text = values.text('note', 'hello fake');
    return [
      step.exchange('put', { method: 'PUT', target: '/f/note', headers: [['Content-Type', 'text/plain']], body: rawBody(text), ...as() }),
      step.exchange('get-managed', { method: 'GET', target: '/f/note', ...as('managed-developer') }),
      step.concurrent('both', [['a', { method: 'PUT', target: '/f/a', body: rawBody('A'), ...as() }], ['b', { method: 'PUT', target: '/f/b', body: rawBody('B'), ...as() }]]),
      step.external('edit', { op: 'write', path: 'note', data: Buffer.from('edited') }),
      step.restart('restart'),
      step.killAfter('kill', 'response-end', { method: 'PUT', target: '/f/k', body: rawBody('K'), ...as() }),
      step.streamOpen('open', 'events', { method: 'GET', target: '/sse?n=2&end=1', ...as() }),
      step.streamBarrier('barrier', 'events', 2),
      step.streamClose('end', 'events', 'server'),
      step.quiesce('quiet'),
      step.snapshot('look'),
    ];
  },
});

/** One PUT then one GET: the smallest scenario a misbehaviour shows in. */
export const PUT_GET = defineScenario({
  id: 'fake.put-get', group: 'fake', principals,
  fixture: () => {},
  steps: () => [
    step.exchange('put', { method: 'PUT', target: '/f/x', body: rawBody('x'), ...as() }),
    step.exchange('get', { method: 'GET', target: '/f/x', ...as() }),
  ],
});

/** A restart only (a process that survives it is caught). */
export const RESTART = defineScenario({
  id: 'fake.restart', group: 'fake', principals, fixture: () => {},
  steps: () => [step.exchange('get', { method: 'GET', target: '/f/none', ...as() }), step.restart('restart')],
});

/** A stream closed by the client after a barrier that is not at its end. */
export const TRAILING = defineScenario({
  id: 'fake.trailing', group: 'fake', principals, fixture: () => {},
  steps: () => [step.streamOpen('open', 's', { method: 'GET', target: '/sse?n=2&extra=2', ...as() }), step.streamBarrier('barrier', 's', 2), step.streamClose('close', 's', 'client')],
});

/** A stream the arm never ends, waited for by its end. */
export const ENDLESS = defineScenario({
  id: 'fake.endless', group: 'fake', principals, fixture: () => {},
  steps: () => [step.streamOpen('open', 's', { method: 'GET', target: '/sse?n=1', ...as() }), step.streamBarrier('barrier', 's', 1), step.streamClose('end', 's', 'server')],
});

/** A request that is never answered (for deadlines and teardown). */
export const HANG = defineScenario({
  id: 'fake.hang', group: 'fake', principals, fixture: () => {},
  steps: () => [step.exchange('put', { method: 'PUT', target: '/f/h', body: rawBody('h'), ...as() }), step.exchange('hang', { method: 'GET', target: '/hang', ...as() })],
});

/** A kill as soon as a request is written whose answer never comes (the kill must land before any answer). */
export const KILL_HANG = defineScenario({
  id: 'fake.kill-hang', group: 'fake', principals, fixture: () => {},
  steps: () => [step.killAfter('kill', 'request-sent', { method: 'GET', target: '/hang', ...as() }), step.exchange('after', { method: 'GET', target: '/f/none', ...as() })],
});

/** A kill after a write's answer, then a read: what the arm had not written by then is lost (SIGKILL, not a stop). */
export const KILL_LOSES = defineScenario({
  id: 'fake.kill-loses', group: 'fake', principals, fixture: () => {},
  steps: () => [step.killAfter('kill', 'response-end', { method: 'PUT', target: '/f/k', body: rawBody('K'), ...as() }), step.exchange('get', { method: 'GET', target: '/f/k', ...as() })],
});

/** A barrier on an item the stream never sends (the barrier must wait for it, not release one early). */
export const SHORT_STREAM = defineScenario({
  id: 'fake.short-stream', group: 'fake', principals, fixture: () => {},
  steps: () => [step.streamOpen('open', 's', { method: 'GET', target: '/sse?n=1', ...as() }), step.streamBarrier('barrier', 's', 2), step.streamClose('close', 's', 'client')],
});

/** A stream the arm cuts off (no terminating chunk) after its items: closed by the client, and awaited to its end. */
export const CUT_CLIENT = defineScenario({
  id: 'fake.cut-client', group: 'fake', principals, fixture: () => {},
  steps: () => [step.streamOpen('open', 's', { method: 'GET', target: '/sse?n=2&cut=1', ...as() }), step.streamBarrier('barrier', 's', 2), step.streamClose('close', 's', 'client')],
});
export const CUT_SERVER = defineScenario({
  id: 'fake.cut-server', group: 'fake', principals, fixture: () => {},
  steps: () => [step.streamOpen('open', 's', { method: 'GET', target: '/sse?n=2&cut=1', ...as() }), step.streamBarrier('barrier', 's', 2), step.streamClose('end', 's', 'server')],
});

/** A restart between two reads (the teardown test kills the harness while the restarted arm is frozen). */
export const RESTART_HOLD = defineScenario({
  id: 'fake.restart-hold', group: 'fake', principals, fixture: () => {},
  steps: () => [step.exchange('put', { method: 'PUT', target: '/f/r', body: rawBody('r'), ...as() }), step.restart('restart'), step.exchange('get', { method: 'GET', target: '/f/r', ...as() })],
});

/** An external change the tree does not allow (the file is not there): a problem of that step, and the run goes on. */
export const EXTERNAL_MISSING = defineScenario({
  id: 'fake.external-missing', group: 'fake', principals, fixture: () => {},
  steps: () => [step.external('gone', { op: 'delete', path: 'nothing' }), step.exchange('get', { method: 'GET', target: '/f/none', ...as() })],
});
