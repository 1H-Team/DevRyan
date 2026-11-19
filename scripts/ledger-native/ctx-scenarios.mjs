// Shared scenarios of the execution context, the I/O pool and the stall
// clock (plan package L3d), run on the JavaScript under Node's own timers on
// a virtual clock and on the Rust probe's virtual clock, which drives the
// binary's event loop; their event logs must be equal, times
// included. A scenario that restates a test of those three JavaScript
// modules names it in `source`, and its `expect` holds the original test's
// assertions over the JavaScript's events.
//
// Task scenarios: `tasks` start at time 0 in order, each in a remote
// context (`context`, as the worker receives it) running a stub program;
// `timeline` acts at `at` ms: `abort` a task with `reason`, `open` or `fail`
// a gate with `value`, set `env`. Stall scenarios (`kind: 'stall'`) drive
// one clock by hand, as its tests do.

const METERED = { deadline: null, cancellable: true, reporting: true, metered: true, summary: null, observeOnly: false };
const REPORTING = { ...METERED, metered: false };
const error = (message, rest = {}) => ({ $stub: 'error', message, ...rest });
const regs = { op: 'return', value: { $stub: 'regs' } };
const log = (value) => ({ op: 'log', value });
const repeat = (count, ops) => Array.from({ length: count }, () => ops).flat();

const of = (events, key) => events.filter((event) => event[key] !== undefined);
const resultOf = (events, task) => events.find((event) => event.task === task && event.result)?.result;
const reports = (events, task) => events.filter((event) => event.task === task && event.report).map((event) => `${event.report.phase}:${event.report.state}`);
const answers = (events) => of(events, 'query').map((event) => event.answer);

/** The most tasks inside one pool at once, and the order they entered, from `start`/`end` logs. */
const concurrency = (events) => {
  let active = 0, peak = 0;
  const order = [];
  for (const event of events) {
    if (event.log === 'start') { active += 1; peak = Math.max(peak, active); order.push(event.task); }
    if (event.log === 'end') active -= 1;
  }
  return { peak, order };
};

const poolTasks = (count, root, extra = {}) => Array.from({ length: count }, (_, index) => ({
  name: `t${index}`, context: REPORTING,
  program: [{ op: 'io', root, body: [log('start'), { op: 'await', gate: `g${index}` }, log('end')] }, { op: 'return', value: index }],
  ...extra,
}));
const openInOrder = (count, from = 10) => Array.from({ length: count }, (_, index) => ({ at: from + index, open: `g${index}`, value: index }));

export const TASK_SCENARIOS = [
  {
    name: 'local HTTP and lock deadlines do not masquerade as provider timeouts',
    source: 'local HTTP and lock deadlines do not masquerade as provider timeouts',
    tasks: [{ name: 'a', context: METERED, program: [
      { op: 'try', body: [{ op: 'phase', name: 'admission', body: [{ op: 'throw', value: error('expired', { name: 'TimeoutError' }) }] }], as: 'http' },
      { op: 'try', body: [{ op: 'phase', name: 'admission', body: [{ op: 'throw', value: error('lock', { fields: { code: 'LOCK_TIMEOUT' } }) }] }], as: 'lock' },
      regs,
    ] }],
    expect: (events) => {
      const value = resultOf(events, 'a').value;
      return value.http.caught.code === 'local_execution_timeout' && value.http.caught.cause.name === 'TimeoutError'
        && value.lock.caught.code === 'local_execution_timeout' && value.lock.caught.cause.code === 'LOCK_TIMEOUT';
    },
  },
  {
    name: 'shared preparation: joiners follow the producer\'s progress, a cancelled joiner leaves, a healthy one gets the result',
    source: 'shared preparation reports real progress across copied contexts while joiners keep their own deadlines',
    tasks: [
      { name: 'producer', context: METERED, program: [
        { op: 'nameMeter', as: 'producer' },
        { op: 'noDeadline', body: [{ op: 'signal', as: 'inner' }, ...repeat(20, [{ op: 'sleep', ms: 10 }, { op: 'progress' }])] },
        { op: 'open', gate: 'prepared', value: 'ready' },
        { op: 'signal', as: 'outer' }, log({ $stub: 'regs' }),
        { op: 'return', value: 'ready' },
      ] },
      { name: 'cancelled', context: METERED, progressMs: 50, program: [{ op: 'queue', gate: 'prepared', follow: 'producer' }] },
      { name: 'healthy', context: METERED, progressMs: 50, program: [{ op: 'queue', gate: 'prepared', follow: 'producer', as: 'v' }, { op: 'return', value: { $stub: 'reg', name: 'v' } }] },
    ],
    timeline: [{ at: 1, abort: 'cancelled', reason: error('cancelled') }],
    expect: (events) => resultOf(events, 'cancelled').error.message === 'cancelled' && resultOf(events, 'healthy').value === 'ready'
      && resultOf(events, 'producer').value === 'ready' && events.filter((event) => event.task === 'healthy' && event.progress === false).length > 2,
  },
  {
    name: 'quiet phases journal only failures and slow completions',
    source: 'quiet phases journal only failures and slow completions',
    tasks: [{ name: 'q', context: REPORTING, program: [
      { op: 'quiet', name: 'ledger_open', body: [] },
      { op: 'quiet', name: 'ledger_commit', slowMs: 20, body: [{ op: 'sleep', ms: 30 }] },
      { op: 'try', body: [{ op: 'quiet', name: 'ledger_transaction', body: [{ op: 'throw', value: error('busy', { fields: { code: 'LOCK_TIMEOUT' } }) }] }], as: 'e' },
      regs,
    ] }],
    expect: (events) => reports(events, 'q').join() === 'ledger_commit:completed,ledger_transaction:failed'
      && events.find((event) => event.report?.phase === 'ledger_commit').report.slow === true
      && resultOf(events, 'q').value.e.caught.code === 'local_execution_timeout',
  },
  {
    name: 'a caller leaving a long queue is credited with progress before its own work',
    source: 'a caller leaving a long queue is credited with progress before its own work',
    tasks: [
      { name: 'holder', context: METERED, program: [{ op: 'nameMeter', as: 'holder' }, ...repeat(40, [{ op: 'sleep', ms: 10 }, { op: 'progress' }]), { op: 'open', gate: 'queue-done' }] },
      { name: 'queued', context: METERED, progressMs: 120, program: [
        { op: 'queue', gate: 'queue-done', follow: 'holder' },
        { op: 'meterState', exact: true, as: 'after' }, log({ $stub: 'reg', name: 'after' }),
        { op: 'sleep', ms: 40 }, { op: 'return', value: 'completed' },
      ] },
    ],
    expect: (events) => resultOf(events, 'queued').value === 'completed'
      && events.find((event) => event.task === 'queued' && event.log).log.progress === events.find((event) => event.task === 'queued' && event.log).t,
  },
  {
    name: 'a summary carries per-phase steps; fast work journals nothing',
    source: 'a summarized admission journals one record with per-phase steps, and nothing when fast',
    tasks: [{ name: 's', context: { ...REPORTING, summary: { minMs: 0 } }, program: [
      { op: 'phase', name: 'identity_lookup', body: [] }, { op: 'phase', name: 'lease_lookup', body: [] },
      { op: 'phase', name: 'lease_lookup', body: [] }, { op: 'quiet', name: 'ledger_transaction', body: [] },
    ] }],
    expect: (events) => reports(events, 's').length === 0
      && resultOf(events, 's').steps.map(([phase, step]) => `${phase}:${step.count}`).join() === 'identity_lookup:1,lease_lookup:2,ledger_transaction:1',
  },
  {
    name: 'a slow phase is journaled as it happens, once, under a summary',
    source: 'a preparation is its own summary root, so its time is journaled once, not as admission plus preparation',
    tasks: [{ name: 'p', context: { ...REPORTING, summary: { minMs: 0, slowMs: 40 } }, program: [
      { op: 'phase', name: 'reconciliation', body: [] }, { op: 'phase', name: 'view_files', body: [{ op: 'sleep', ms: 60 }] },
    ] }],
    expect: (events) => reports(events, 'p').join() === 'view_files:started,view_files:completed'
      && resultOf(events, 'p').steps.map(([phase]) => phase).join() === 'reconciliation,view_files',
  },
  {
    name: 'a summary still journals failed and slow phases as they happen',
    source: 'a summarized admission still journals failed and slow phases as they happen',
    tasks: [{ name: 'f', context: { ...REPORTING, summary: { minMs: 60_000, slowMs: 40 } }, program: [
      { op: 'phase', name: 'reconciliation', body: [{ op: 'sleep', ms: 80 }] },
      { op: 'phase', name: 'execution_claim', body: [{ op: 'throw', value: error('boom', { fields: { code: 'workspace_changing' } }) }] },
    ] }],
    expect: (events) => reports(events, 'f').join() === 'reconciliation:started,reconciliation:completed,execution_claim:failed'
      && events.filter((event) => event.report)[0].report.slow === true && events.filter((event) => event.report)[2].report.code === 'workspace_changing'
      && resultOf(events, 'f').error.code === 'workspace_changing',
  },
  {
    name: 'a summary without cancellation, deadline or meter only observes',
    source: 'an execution summary observes without adding cancellation, a deadline or a meter',
    tasks: [{ name: 'o', context: { deadline: null, cancellable: false, reporting: true, metered: false, summary: { minMs: 10 }, observeOnly: false }, program: [
      { op: 'signal', as: 'signal' }, { op: 'remaining', exact: true, as: 'remaining' }, { op: 'meterState', as: 'meter' },
      { op: 'step', name: 'tool_execution', elapsedMs: 12 },
      { op: 'phase', name: 'direct_receipt', body: [{ op: 'sleep', ms: 30 }] },
      { op: 'timed', name: 'changes_transaction', body: [{ op: 'return', value: 'settled' }], as: 'value' },
      regs,
    ] }],
    expect: (events) => {
      const { value, steps } = resultOf(events, 'o');
      return value.signal === 'none' && value.remaining === Infinity && value.meter === null && value.value === 'settled'
        && steps.map(([phase, step]) => `${phase}:${step.count}/${phase === 'tool_execution' ? step.elapsedMs : ''}`).join() === 'tool_execution:1/12,direct_receipt:1/,changes_transaction:1/';
    },
  },
  {
    name: 'summary steps are no-ops outside a summary and never check an aborted signal',
    source: 'summary steps are no-ops outside a summary and never check an aborted admission',
    tasks: [
      { name: 'plain', context: null, program: [{ op: 'step', name: 'changes_queue_wait', elapsedMs: 5 }, { op: 'timed', name: 'changes_transaction', body: [{ op: 'return', value: 'plain' }], as: 'v' }, regs] },
      { name: 'aborted', context: { ...REPORTING, summary: { minMs: 0 } }, program: [
        { op: 'sleep', ms: 10 }, { op: 'timed', name: 'changes_transaction', body: [{ op: 'return', value: 'kept' }], as: 'v' },
        { op: 'step', name: 'changes_queue_wait', elapsedMs: 1 }, { op: 'signal', as: 'signal' }, regs,
      ] },
    ],
    timeline: [{ at: 5, abort: 'aborted', reason: error('cancelled') }],
    expect: (events) => resultOf(events, 'plain').value.v === 'plain' && resultOf(events, 'plain').steps.length === 0
      && resultOf(events, 'aborted').value.v === 'kept' && resultOf(events, 'aborted').value.signal === 'aborted',
  },
  {
    name: 'observation only keeps a lock timeout; an ordinary context rewraps it',
    source: 'an observation of context-free work journals its summary but keeps the original failure and code',
    tasks: [true, false].map((observeOnly) => ({ name: observeOnly ? 'observed' : 'admitted', context: { ...REPORTING, observeOnly, summary: { minMs: 0 } }, program: [
      { op: 'phase', name: 'identity_lookup', body: [] },
      { op: 'phase', name: 'direct_receipt', body: [{ op: 'throw', value: error('lock', { fields: { code: 'LOCK_TIMEOUT' } }) }] },
    ] })),
    expect: (events) => resultOf(events, 'observed').error.code === 'LOCK_TIMEOUT' && resultOf(events, 'admitted').error.code === 'local_execution_timeout',
  },
  {
    name: 'progress is forwarded on change at every tick and once more when the call settles',
    tasks: [
      { name: 'waits', context: METERED, program: [{ op: 'slotWait', body: [{ op: 'sleep', ms: 600 }] }, { op: 'sleep', ms: 100 }] },
      { name: 'works', context: METERED, progressMs: 100, program: repeat(5, [{ op: 'sleep', ms: 70 }, { op: 'progress' }]) },
      { name: 'idle', context: METERED, program: [{ op: 'sleep', ms: 900 }] },
      { name: 'unmetered', context: REPORTING, program: [{ op: 'sleep', ms: 300 }] },
    ],
  },
  {
    name: 'deadlines: remaining time, none without a deadline, and odd deadlines',
    tasks: [
      { name: 'future', context: { ...REPORTING, deadline: 1_000_500 }, program: [
        { op: 'remaining', exact: true, as: 'start' }, { op: 'sleep', ms: 200 }, { op: 'remaining', exact: true, as: 'later' },
        { op: 'noDeadline', body: [{ op: 'remaining', exact: true, as: 'none' }, { op: 'signal', as: 'signal' }] }, { op: 'sleep', ms: 400 }, { op: 'remaining', exact: true, as: 'past' }, regs,
      ] },
      { name: 'odd', context: { ...REPORTING, deadline: 'abc' }, program: [{ op: 'remaining', exact: true, as: 'nan' }, regs] },
      { name: 'string', context: { ...REPORTING, deadline: '1000100' }, program: [{ op: 'remaining', exact: true, as: 'coerced' }, regs] },
    ],
  },
  {
    name: 'cleanup: its own timeout, its wall-clock cap, and work that finishes',
    tasks: [
      { name: 'timeout', context: REPORTING, program: [{ op: 'cleanup', timeoutMs: 30, body: [{ op: 'queue', gate: 'never' }] }] },
      { name: 'cap', context: REPORTING, program: [{ op: 'cleanup', timeoutMs: 1_000, capMs: 300, body: [{ op: 'queue', gate: 'never' }] }] },
      { name: 'finishes', context: REPORTING, program: [{ op: 'cleanup', body: [{ op: 'sleep', ms: 100 }, { op: 'return', value: 'clean' }], as: 'v' }, regs] },
      { name: 'contextless', context: null, program: [{ op: 'cleanup', timeoutMs: 0, body: [{ op: 'sleep', ms: 5 }, { op: 'check' }] }] },
    ],
  },
  {
    name: 'meters: slot waits count, a meter is added only where none is, cycles of followed meters end',
    tasks: [
      { name: 'waits', context: METERED, program: [{ op: 'slotWait', body: [{ op: 'meterState', as: 'one' }, { op: 'slotWait', body: [{ op: 'meterState', as: 'two' }] }] }, { op: 'meterState', as: 'none' }, regs] },
      { name: 'added', context: REPORTING, program: [{ op: 'meter', body: [{ op: 'meterState', as: 'inner' }, { op: 'progress' }] }, { op: 'meterState', as: 'outer' }, regs] },
      { name: 'a', context: METERED, progressMs: 50, program: [{ op: 'nameMeter', as: 'a' }, { op: 'await', gate: 'start-a' }, { op: 'queue', gate: 'ga', follow: 'b' }] },
      { name: 'b', context: METERED, progressMs: 50, program: [{ op: 'nameMeter', as: 'b' }, { op: 'queue', gate: 'gb', follow: 'a' }, { op: 'sleep', ms: 30 }, { op: 'progress' }] },
    ],
    timeline: [{ at: 10, open: 'start-a' }, { at: 120, open: 'ga', value: 'a' }, { at: 160, open: 'gb', value: 'b' }],
  },
  {
    name: 'queue waits: without a signal, aborted before, aborted during, and failing',
    tasks: [
      { name: 'unsignalled', context: null, program: [{ op: 'queue', gate: 'g1', as: 'v' }, regs] },
      { name: 'early', context: REPORTING, program: [{ op: 'sleep', ms: 5 }, { op: 'queue', gate: 'g1' }] },
      { name: 'during', context: REPORTING, program: [{ op: 'queue', gate: 'g2' }] },
      { name: 'failing', context: REPORTING, program: [{ op: 'try', body: [{ op: 'queue', gate: 'g3' }], as: 'e' }, regs] },
    ],
    timeline: [{ at: 1, abort: 'early', reason: error('early') }, { at: 20, abort: 'during', reason: 'not an error' }, { at: 30, fail: 'g3', value: error('queue failed', { fields: { code: 'q' } }) }, { at: 50, open: 'g1', value: 'v1' }],
  },
  {
    name: 'an abort lands only where the work checks, after the action settles',
    tasks: [{ name: 'p', context: REPORTING, program: [{ op: 'phase', name: 'held', body: [{ op: 'sleep', ms: 100 }] }] }],
    timeline: [{ at: 50, abort: 'p', reason: error('stop', { fields: { code: 'local_execution_timeout', status: 503 } }) }],
  },
  {
    name: 'per-project I/O runs eight operations at a time by default and queues the rest in order',
    source: 'per-project I/O runs eight operations at a time by default, queues the rest in order, and honours the override',
    tasks: poolTasks(20, '/project-a'),
    timeline: openInOrder(20),
    expect: (events) => { const { peak, order } = concurrency(events); return peak === 8 && order.join() === Array.from({ length: 20 }, (_, index) => `t${index}`).join(); },
  },
  {
    name: 'DEVRYAN_EXECUTION_IO_CAP=2 is honoured',
    source: 'per-project I/O runs eight operations at a time by default, queues the rest in order, and honours the override',
    env: { DEVRYAN_EXECUTION_IO_CAP: '2' },
    tasks: poolTasks(6, '/project-b'),
    timeline: openInOrder(6),
    expect: (events) => concurrency(events).peak === 2,
  },
  ...['0', '65', 'x', '1.5', '', ' 3 '].map((cap) => ({
    name: `DEVRYAN_EXECUTION_IO_CAP=${JSON.stringify(cap)}`,
    source: ['0', '65', 'x', '1.5'].includes(cap) ? 'per-project I/O runs eight operations at a time by default, queues the rest in order, and honours the override' : undefined,
    env: { DEVRYAN_EXECUTION_IO_CAP: cap },
    tasks: poolTasks(10, '/project-c'),
    timeline: openInOrder(10),
    expect: ['0', '65', 'x', '1.5'].includes(cap) ? (events) => concurrency(events).peak === 8 : undefined,
  })),
  {
    name: 'an aborted waiter leaves the pool without taking a slot',
    env: { DEVRYAN_EXECUTION_IO_CAP: '1' },
    tasks: poolTasks(3, '/project-d'),
    timeline: [{ at: 5, abort: 't1', reason: error('gave up') }, ...openInOrder(3)],
  },
  {
    name: 'an abort of a running operation lands only at its checks',
    env: { DEVRYAN_EXECUTION_IO_CAP: '1' },
    tasks: [
      { name: 'running', context: REPORTING, program: [{ op: 'io', root: '/p', body: [{ op: 'await', gate: 'g' }, { op: 'check' }] }] },
      { name: 'next', context: REPORTING, program: [{ op: 'io', root: '/p', body: [log('next runs')] }] },
    ],
    timeline: [{ at: 5, abort: 'running', reason: error('stop') }, { at: 10, open: 'g' }],
  },
  {
    name: 'roots are independent pools; a raised cap admits new callers past the queue',
    env: { DEVRYAN_EXECUTION_IO_CAP: '1' },
    tasks: [
      ...poolTasks(2, '/one'),
      { name: 'other', context: REPORTING, program: [{ op: 'io', root: '/two', body: [log('start'), log('end')] }] },
      { name: 'late', context: REPORTING, program: [{ op: 'sleep', ms: 6 }, { op: 'io', root: '/one', body: [log('start'), log('end')] }] },
    ],
    timeline: [{ at: 5, env: { DEVRYAN_EXECUTION_IO_CAP: '3' } }, ...openInOrder(2, 20)],
  },
  {
    name: 'a queued I/O caller is waiting; it forwards waiting, then progress when it runs',
    env: { DEVRYAN_EXECUTION_IO_CAP: '1' },
    tasks: [
      { name: 'holder', context: REPORTING, program: [{ op: 'io', root: '/w', body: [{ op: 'sleep', ms: 600 }] }] },
      { name: 'waiter', context: METERED, program: [{ op: 'io', root: '/w', body: [{ op: 'meterState', as: 'inside' }, { op: 'sleep', ms: 300 }] }, regs] },
    ],
  },
  {
    // The slot wait (260 to 310 ms) ends between two ticks; its end stamps
    // the meter, so the tick at 500 ms forwards progress although nothing
    // else moved it.
    name: 'a short slot wait between two ticks stamps the meter when it ends',
    env: { DEVRYAN_EXECUTION_IO_CAP: '1' },
    tasks: [
      { name: 'holder', context: REPORTING, program: [{ op: 'io', root: '/s', body: [{ op: 'sleep', ms: 310 }] }] },
      { name: 'waiter', context: METERED, program: [{ op: 'sleep', ms: 260 }, { op: 'io', root: '/s', body: [] }, { op: 'sleep', ms: 400 }, { op: 'meterState', as: 'after', exact: true }, regs] },
    ],
    expect: (events) => events.filter((event) => event.task === 'waiter' && event.progress === false).map((event) => event.t).join() === '250,500',
  },
  // Named for the planted bugs of the third review that escaped (C01, C02,
  // C03, C06, C08, C13, I05).
  {
    name: 'a slot wait that fails gives its wait back to the meter and stamps it (C01)',
    tasks: [{ name: 'f', context: METERED, progressMs: 50, program: [
      { op: 'try', body: [{ op: 'slotWait', body: [{ op: 'await', gate: 'w' }] }], as: 'e' },
      { op: 'meterState', exact: true, as: 'after' }, { op: 'sleep', ms: 200 }, regs,
    ] }],
    timeline: [{ at: 30, fail: 'w', value: error('slot lost') }],
    expect: (events) => resultOf(events, 'f').value.after.waiters === 0,
  },
  {
    // `timedExecutionStep` without a summary returns what the action
    // returned (`return action()`): a plain value settles its promise at
    // once, where `return await` would take a job; for an action still
    // pending the two take the same jobs. The waiters' logs place both
    // among chains of one to six awaits.
    name: 'a timed step outside a summary returns the action\'s value, with no await of its own (C02)',
    tasks: [
      { name: 'opener', context: null, program: [{ op: 'open', gate: 'open', value: 1 }] },
      { name: 'timed', context: REPORTING, program: [{ op: 'timed', name: 'changes_transaction', body: [{ op: 'return', value: 'v' }] }, log('timed')] },
      { name: 'plain', context: REPORTING, program: [{ op: 'timed', name: 'changes_transaction', plain: 'v' }, log('plain')] },
      ...[1, 2, 3, 4, 5, 6].map((count) => ({ name: `w${count}`, context: REPORTING, program: [...repeat(count, [{ op: 'await', gate: 'open' }]), log(`w${count}`)] })),
    ],
  },
  {
    // The slow timer of a summarized phase is unrefed: cleared, its empty
    // list stays, so a later sleep of its duration joins that list and
    // re-arms after a list made meanwhile (a refed one would be deleted and
    // made anew before it).
    name: 'a summarized phase\'s slow timer is unrefed, so its cleared list is reused (C03)',
    tasks: [
      { name: 'p', context: { ...REPORTING, summary: { minMs: 0, slowMs: 40 } }, program: [
        { op: 'phase', name: 'view_files', body: [{ op: 'sleep', ms: 10 }] }, { op: 'sleep', ms: 40 }, log('p')] },
      { name: 'r', context: REPORTING, program: [{ op: 'sleep', ms: 25 }, { op: 'sleep', ms: 25 }, log('r')] },
    ],
  },
  {
    name: 'a summary keeps 32 steps and drops the 33rd (C06)',
    tasks: [{ name: 's', context: { ...REPORTING, summary: { minMs: 0 } }, program: [
      ...Array.from({ length: 33 }, (_, index) => ({ op: 'step', name: `step_${index}`, elapsedMs: 1 })), { op: 'return', value: 'done' },
    ] }],
    expect: (events) => resultOf(events, 's').steps.length === 32,
  },
  {
    // At 50 ms the meter is idle; a slot wait starts at 60 ms without
    // moving progress, so only `waiting` differs at the 100 ms tick.
    name: 'progress is forwarded when only waiting changed (C08)',
    tasks: [{ name: 'm', context: METERED, progressMs: 50, program: [
      { op: 'sleep', ms: 60 }, { op: 'slotWait', body: [{ op: 'await', gate: 'g' }] }, { op: 'sleep', ms: 100 },
    ] }],
    timeline: [{ at: 200, open: 'g' }],
    expect: (events) => events.filter((event) => event.task === 'm' && event.progress !== undefined).map((event) => `${event.t}:${event.progress}`).slice(0, 2).join() === '50:false,100:true',
  },
  {
    name: 'a summary whose slowMs is 0 uses the 2 s default (C13)',
    tasks: [{ name: 'z', context: { ...REPORTING, summary: { minMs: 0, slowMs: 0 } }, program: [
      { op: 'phase', name: 'view_files', body: [{ op: 'sleep', ms: 2_100 }] }, { op: 'return', value: 'done' },
    ] }],
    until: 5_000,
  },
  {
    name: 'DEVRYAN_EXECUTION_IO_CAP=64 is honoured (the largest cap) (I05)',
    env: { DEVRYAN_EXECUTION_IO_CAP: '64' },
    tasks: poolTasks(10, '/project-e'),
    timeline: openInOrder(10),
    expect: (events) => concurrency(events).peak === 10,
  },
];

const stall = (name, steps, rest = {}) => ({ kind: 'stall', name, steps, ...rest });
export const STALL_SCENARIOS = [
  stall('ordinary scheduling delays are not stalls', [{ mark: 's' }, { run: 10_000 }, { block: 900 }, { run: 2_000 }, { query: 'stalledMsBetween', from: { mark: 's' } }, { query: 'activeMsSince', since: { mark: 's' } }],
    { source: 'ordinary scheduling delays are not stalls', expect: (events) => of(events, 'stall').length === 0 && answers(events)[0] === 0 && answers(events)[1] === 12_900 }),
  stall('a blocked loop is subtracted from the time a deadline counts', [
    { mark: 's' }, { run: 10_000 }, { block: 61_000 }, { run: 5_000 }, { query: 'activeMsSince', since: { mark: 's' } },
    { query: 'expired', since: { mark: 's' }, limit: 60_000, cap: 180_000 }, { run: 45_000 }, { query: 'expired', since: { mark: 's' }, limit: 60_000, cap: 180_000 }, { query: 'snapshot' },
  ], { source: 'a blocked loop is subtracted from the time a deadline counts', expect: (events) => {
    const [active, before, after, snapshot] = answers(events);
    return of(events, 'stall').length === 1 && events[0].stall.ms === 60_750 && active === 15_250 && before === false && after === true
      && snapshot.stalls === 1 && snapshot.stalledMs === 60_750 && snapshot.longestStallMs === 60_750;
  } }),
  stall('a deadline that starts or ends inside a stall counts only its overlap', [
    { run: 1_000 }, { mark: 'before' }, { block: 30_000 }, { mark: 'after' },
    { query: 'stalledMsBetween', from: { mark: 'before', plus: 10_250 }, to: { mark: 'after' } },
    { query: 'stalledMsBetween', from: { mark: 'before' }, to: { mark: 'before', plus: 5_250 } },
    { query: 'stalledMsBetween', from: { mark: 'after' }, to: { mark: 'after', plus: 10_000 } },
  ], { source: 'a deadline that starts or ends inside a stall counts only its overlap', expect: (events) => answers(events).join() === '19750,5000,0' }),
  stall('the first code to run after a stall already sees it', [
    { run: 1_000 }, { mark: 's' }, { advance: 110_000 }, { query: 'activeMsSince', since: { mark: 's' } }, { query: 'expired', since: { mark: 's' }, limit: 60_000, cap: 180_000 },
  ], { source: 'the first code to run after a stall already sees it', expect: (events) => answers(events).join() === '250,false' }),
  stall('the cap is a wall-clock limit that no stall can move', [
    { mark: 's' }, { block: 200_000 }, { query: 'activeMsSince', since: { mark: 's' } }, { query: 'expired', since: { mark: 's' }, limit: 60_000, cap: 180_000 }, { query: 'expired', since: { mark: 's' }, limit: 60_000 },
  ], { source: 'the cap is a wall-clock limit that no stall can move', expect: (events) => { const [active, capped, uncapped] = answers(events); return active < 1_000 && capped === true && uncapped === false; } }),
  stall('the kill switch restores wall-clock deadlines', [
    { mark: 's' }, { block: 61_000 }, { env: { DEVRYAN_STALL_AWARE_DEADLINES: '0' } }, { query: 'stalledMsBetween', from: { mark: 's' } }, { query: 'expired', since: { mark: 's' }, limit: 60_000, cap: 180_000 },
    { env: { DEVRYAN_STALL_AWARE_DEADLINES: '1' } }, { query: 'stalledMsBetween', from: { mark: 's' } },
  ], { source: 'the kill switch restores wall-clock deadlines', expect: (events) => answers(events).slice(0, 2).join() === '0,true' }),
  stall('keeps a bounded history', [...repeat(600, [{ block: 2_000 }, { run: 250 }]), { query: 'snapshot' }, { query: 'stalledMsBetween', from: { plus: -3_600_000 } }],
    { source: 'keeps a bounded history', expect: (events) => { const [snapshot, stalled] = answers(events); return snapshot.stalls === 600 && stalled <= 512 * 1_750; } }),
  stall('a tick exactly at the threshold is a stall; one millisecond under is not', [
    { mark: 's' }, { block: 1_249 }, { block: 1_250 }, { query: 'stalledMsBetween', from: { mark: 's' } }, { query: 'snapshot' },
  ]),
  stall('tuned ticks and stalls, as a worker\'s stallClock sets them', [
    { mark: 's' }, { run: 1_000 }, { block: 449 }, { block: 450 }, { block: 50 }, { query: 'activeMsSince', since: { mark: 's' } }, { query: 'snapshot' },
  ], { options: { tickMs: 50, stallMs: 400 } }),
  stall('old stalls are forgotten only when a new stall is kept', [
    { mark: 'first' }, { block: 2_000 }, { run: 31 * 60_000 }, { query: 'stalledMsBetween', from: { mark: 'first' } },
    { block: 2_000 }, { query: 'stalledMsBetween', from: { mark: 'first' } }, { query: 'snapshot' },
  ]),
  // A stall is kept while it ended at most 30 minutes before the newest:
  // exactly 30 minutes still counts, a millisecond more does not.
  stall('a stall exactly 30 minutes older than the newest is kept', [
    { mark: 'first' }, { block: 2_000 }, { run: 1_798_000 }, { block: 2_000 }, { query: 'stalledMsBetween', from: { mark: 'first' } }, { query: 'snapshot' },
  ], { expect: (events) => answers(events)[0] === 3_500 }),
  stall('a stall 30 minutes and 1 ms older than the newest is forgotten', [
    { mark: 'first' }, { block: 2_000 }, { run: 1_798_000 }, { block: 2_001 }, { query: 'stalledMsBetween', from: { mark: 'first' } }, { query: 'snapshot' },
  ], { expect: (events) => answers(events)[0] === 1_751 }),
  stall('odd timings: string ticks, a NaN stall threshold', [{ mark: 's' }, { block: 5_000 }, { query: 'stalledMsBetween', from: { mark: 's' } }, { query: 'snapshot' }], { options: { tickMs: '100', stallMs: 'never' } }),
];

export const SCENARIOS = [...TASK_SCENARIOS, ...STALL_SCENARIOS];

/** Tests of the JavaScript modules not restated here, and why. */
export const NOT_RESTATED = Object.freeze([
  { source: 'timing preserves inherited cancellation and original failures without checking its root', reason: 'withExecutionTiming is the host\'s (publication timing); the worker never calls it' },
  { source: 'an expired active operation retains ownership until it actually settles', reason: 'the admission timeout is withExecutionAdmission, which runs in the host; the worker gets the abort over the protocol' },
  { source: 'following a hung shared preparation does not disable the stall watchdog', reason: 'the preparation watchdog is withExecutionPreparation, which runs in the host' },
  { source: 'idle admission survives progressing work, expires idle work, and keeps an absolute cap', reason: 'idle expiry is withExecutionAdmission\'s timer in the host, fed by the forwarded progress' },
  { source: 'tool execution diagnostics whitelist origin, tier and fallback without tool input', reason: 'the identity of a record is added by the host\'s report (createReport); the worker forwards records as they are' },
]);
