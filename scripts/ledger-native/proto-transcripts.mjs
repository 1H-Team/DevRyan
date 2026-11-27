// Scripted host transcripts of the native ledger's protocol conformance
// suite. `STUB_TRANSCRIPTS` run against the product's worker with the stub
// runtime and against devryan-ledger built with test-hooks; `PRODUCT_TRANSCRIPTS`
// against the product's worker with its real runtime and the plain build
// (only what needs no ledger method). Every await names a message the
// ledger must send before the host goes on, so what is compared does not
// depend on timing. `exit` is the class the run must end in: `eof` (stdin
// closed, status 0), `refused` (init refused before ready) or `corrupt` (a
// line that is not a message). `never` matches messages neither run may send.
const fn = (id) => ({ __devryanFunction: id });
const error = (message, rest = {}) => ({ $stub: 'error', message, ...rest });
const call = (id, program, { context = null, fns = [], method = 'stubRun' } = {}) => ({ send: { type: 'call', id, method, input: [{ program, fns }], context } });
const echo = (id, input, context = null) => ({ send: { type: 'call', id, method: 'stubEcho', input, context } });
const result = (id) => ({ await: (message) => message?.type === 'result' && Object.is(message.id, id), label: `result ${String(id)}` });
const callback = (first) => ({ await: (message) => message?.type === 'callback' && message.args?.[0] === first, label: `callback ${first}` });
const observed = (test, label) => ({ await: (message) => message?.type === 'observe' && test(message), label });
const regs = { op: 'return', value: { $stub: 'regs' } };
const ret = (name) => ({ op: 'return', value: { $stub: 'reg', name } });
const deferNamed = (...names) => (message) => (names.includes(message.args?.[0]) ? { defer: message.args[0] } : { value: ['answer', ...message.args] });
const deep = (depth) => {
  let out = 'leaf';
  for (let level = 0; level < depth; level++) out = { c: out };
  return out;
};

const FULL = { deadline: null, cancellable: true, reporting: true, metered: true, summary: { minMs: 0, slowMs: 60_000 }, observeOnly: false };
const REPORTING = { deadline: null, cancellable: true, reporting: true, metered: false, summary: null, observeOnly: false };
// An hour before this module loaded, in epoch milliseconds.
const PAST_DEADLINE = Date.now() - 3_600_000;
const SUMMARIZED = { ...REPORTING, summary: { minMs: 0, slowMs: 60_000 } };
const init = (observers = {}, rest = {}) => ({ directory: '/tmp/ledger-native-conformance', observers, ...rest });

const chain = (depth) => {
  let out = error(`cause ${depth}`, { fields: { code: `c${depth}` } });
  for (let level = depth - 1; level >= 1; level--) out = error(`cause ${level}`, { cause: out });
  return out;
};
const wireChain = (depth) => {
  let out = { __devryanError: true, message: `wire ${depth}` };
  for (let level = depth - 1; level >= 0; level--) out = { __devryanError: true, message: `wire ${level}`, code: `w${level}`, cause: out };
  return out;
};

export const STUB_TRANSCRIPTS = [
  { name: 'ready lists every method and the process ends when stdin closes', init: init(), steps: [], exit: 'eof' },
  {
    name: 'echo keeps every value the seam carries',
    init: init(),
    steps: [
      echo(1, [undefined, null, true, NaN, -0, Infinity, -Infinity, 1e21, 5e-324, 0.1, 'a \ud800\u0000"\\',
        Buffer.from([0, 1, 255]), { 2: 'b', 1: 'a', z: 1, $dr: 'kept' }, [undefined, [[]]], { __devryanStream: 4 },
        { __devryanFunction: 'x' }, { __proto__: null, k: 'null prototype' }]),
      result(1),
      echo(2, [{ __devryanError: true, name: 'E', message: 'm', code: 'c', status: 1, committed: true, rollbackFailed: false, retryable: true, reason: 'r', extra: 'dropped', stack: 'host stack' }]),
      result(2),
      echo(3, [{ nested: { __devryanError: true, errors: [{ __devryanError: true, message: 'a' }, 'plain', null], cause: wireChain(6) } }]),
      result(3),
      echo(4, [{ __devryanError: true, message: null, code: { not: 'primitive' }, status: null }, { __devryanError: true, message: 12 }, { __devryanError: true, message: [1, 2] }, { __devryanError: true, errors: [] }]),
      result(4),
    ],
    exit: 'eof',
  },
  {
    name: 'input functions call back; a function in a result is refused',
    init: init(),
    steps: [
      call(1, [{ op: 'call', fn: 0, args: ['first', 1, Buffer.from('b')], as: 'r' }, ret('r')], { fns: [fn(7)] }),
      result(1),
      echo(2, [fn(3)]),
      result(2),
      call(3, [{ op: 'return', value: { $stub: 'fnarg', index: 0 } }], { fns: [fn(4)] }),
      result(3),
      call(4, [{ op: 'return', value: [{ $stub: 'fn' }] }]),
      result(4),
      call(5, [{ op: 'call', fn: 0, args: [{ __devryanFunction: 1 }], as: 'marker' }, ret('marker')], { fns: [fn(-0)] }),
      result(5),
    ],
    exit: 'eof',
  },
  {
    name: 'a callback whose arguments cannot be encoded consumes its id',
    init: init(),
    steps: [
      call(1, [
        { op: 'try', body: [{ op: 'call', fn: 0, args: [{ $stub: 'fn' }] }], as: 'function' },
        { op: 'try', body: [{ op: 'call', fn: 0, args: [{ $stub: 'stream', name: 'never', chunks: [] }] }], as: 'stream' },
        { op: 'call', fn: 0, args: ['second', error('in arguments', { name: 'ArgError', fields: { code: 'arg', status: 400 } })], as: 'ok' },
        { op: 'try', body: [{ op: 'call', fn: 5 }], as: 'missing' },
        regs,
      ], { fns: [fn(1)] }),
      result(1),
    ],
    exit: 'eof',
  },
  {
    name: 'host answers: values, failures, aggregate errors, decoded markers, unknown and repeated ids',
    init: init(),
    answer: (message) => {
      switch (message.args?.[0]) {
        case 'fail': return { error: { __devryanError: true, name: 'HostError', message: 'no', code: 'host', status: 409, committed: true, stack: 'x' } };
        case 'aggregate': return { error: { __devryanError: true, message: 'many', errors: [{ __devryanError: true, message: 'one', code: 'e1' }, 7], cause: { __devryanError: true, message: 'why' } } };
        case 'marker': return { value: { wrapped: { __devryanError: true, message: 'as a value', code: 'v' }, fn: { __devryanFunction: 9 }, stream: { __devryanStream: 2 } } };
        case 'truthy': return { failed: 1, error: { message: 'failed is 1' } };
        case 'empty': return { failed: 0, value: undefined };
        default: return { value: ['answer', ...message.args] };
      }
    },
    steps: [
      call(1, [
        { op: 'try', body: [{ op: 'call', fn: 0, args: ['fail'] }], as: 'fail' },
        { op: 'try', body: [{ op: 'call', fn: 0, args: ['aggregate'] }], as: 'aggregate' },
        { op: 'call', fn: 0, args: ['marker'], as: 'marker' },
        { op: 'try', body: [{ op: 'call', fn: 0, args: ['truthy'] }], as: 'truthy' },
        { op: 'call', fn: 0, args: ['empty'], as: 'empty' },
        regs,
      ], { fns: [fn(1)] }),
      result(1),
      { send: { type: 'callback-result', id: 1, failed: false, value: 'late' } },
      { send: { type: 'callback-result', id: 99, failed: true, error: { message: 'stray' } } },
      { send: { type: 'callback-result', id: '2', failed: false, value: 'string id' } },
      echo(2, ['still serving']),
      result(2),
    ],
    exit: 'eof',
  },
  {
    name: 'nested callbacks: a call made while the host holds another answer, and two callbacks at once',
    init: init(),
    answer: deferNamed('outer', 'a'),
    steps: [
      call(1, [{ op: 'call', fn: 0, args: ['outer'], as: 'outer' }, ret('outer')], { fns: [fn(1)] }),
      callback('outer'),
      call(2, [{ op: 'call', fn: 0, args: ['inner'], as: 'inner' }, ret('inner')], { fns: [fn(2)] }),
      result(2),
      { answer: 'outer', value: 'outer answered last' },
      result(1),
      call(3, [
        { op: 'start', fn: 0, args: ['a'], gate: 'ga' },
        { op: 'start', fn: 0, args: ['b'], gate: 'gb' },
        { op: 'await', gate: 'gb', as: 'b' },
        { op: 'await', gate: 'ga', as: 'a' },
        regs,
      ], { fns: [fn(3)] }),
      callback('b'),
      { answer: 'a', value: 'a answered after b' },
      result(3),
    ],
    exit: 'eof',
  },
  {
    name: 'observers: callbacks and observations carry the call that caused them',
    init: init({ onChange: true, onDiagnostic: true, onLockTiming: true, onMaterialize: false }),
    steps: [
      call(1, [
        { op: 'emit', observer: 'onChange', payload: { p: 1 }, as: 'change' },
        { op: 'emit', observer: 'onMaterialize', payload: { p: 2 }, as: 'materialize' },
        { op: 'observe', observer: 'onDiagnostic', payload: { d: 1, list: [undefined, NaN] } },
        { op: 'observe', observer: 'onLockTiming', payload: { waitMs: 3 } },
        { op: 'try', body: [{ op: 'observe', observer: 'onDiagnostic', payload: { f: { $stub: 'fn' } } }], as: 'unencodable' },
        { op: 'emit', observer: 'onChange', payload: 'not awaited' },
        regs,
      ]),
      result(1),
      { await: (message) => message?.type === 'callback' && message.args?.[0] === 'not awaited', label: 'the second onChange' },
      echo(2, ['after']),
      result(2),
    ],
    exit: 'eof',
  },
  {
    name: 'calls: unknown methods, odd ids and a repeated id',
    init: init(),
    steps: [
      { send: { type: 'call', id: 1, method: 'nope', input: [], context: null } },
      { send: { type: 'call', id: 'text', method: 5, input: [], context: null } },
      { send: { type: 'call', id: 2, method: 'constructor', input: [], context: null } },
      { send: { type: 'call', method: 'stubEcho', input: ['no id'], context: null } },
      { await: (message) => message?.type === 'result' && message.id === undefined, label: 'result of the call without an id' },
      { send: { type: 'call', id: { o: 1 }, method: 'stubEcho', input: ['object id'], context: null } },
      { await: (message) => message?.type === 'result' && message.id?.o === 1, label: 'result of the object id' },
      { send: { type: 'call', id: 3, method: 'warm', input: [{}], context: FULL } },
      result(3),
      { send: { type: 'call', id: 4.5, method: 'stubEcho', input: [], context: null } },
      result(4.5),
      call(4, [{ op: 'queue', gate: 'first' }], { context: REPORTING }),
      call(4, [{ op: 'queue', gate: 'second' }], { context: REPORTING }),
      { send: { type: 'abort', id: 4, reason: { __devryanError: true, message: 'aborts the later call' } } },
      result(4),
      call(5, [{ op: 'open', gate: 'first', value: 'the earlier call' }]),
      result(5),
      { await: (message) => message?.type === 'result' && message.id === 4 && message.failed === false, label: 'the earlier call 4' },
      { send: { type: 'abort', id: 4, reason: { message: 'after both' } } },
      echo(6, []),
      result(6),
    ],
    exit: 'eof',
  },
  {
    name: 'input that is not an array spreads as JavaScript spreads it',
    init: init(),
    steps: [
      { send: { type: 'call', id: 1, method: 'stubEcho', context: null } },
      result(1),
      { send: { type: 'call', id: 2, method: 'stubEcho', input: null, context: null } },
      result(2),
      { send: { type: 'call', id: 3, method: 'stubEcho', input: 5, context: null } },
      result(3),
      { send: { type: 'call', id: 4, method: 'stubEcho', input: { 0: 'a' }, context: null } },
      result(4),
      { send: { type: 'call', id: 5, method: 'stubEcho', input: 'ab😀\ud800', context: null } },
      result(5),
      { send: { type: 'call', id: 6, method: 'stubEcho', input: Buffer.from([1, 2]), context: null } },
      result(6),
      { send: { type: 'call', id: 7, method: 'stubEcho', input: true, context: FULL } },
      result(7),
    ],
    exit: 'eof',
  },
  {
    name: 'contexts: none, truthy primitives and every field',
    init: init(),
    steps: [
      [null, true, 'x', 0, {}, '__deadline__', { deadline: 'abc' }, { deadline: 1 }, { summary: true },
        { summary: { minMs: -5, slowMs: 'x' }, reporting: true }, { observeOnly: true, reporting: true }, { cancellable: 1, metered: 'yes' }, [1]]
        .flatMap((context, index) => [{
          send: () => ({ type: 'call', id: index + 1, method: 'stubRun', context: context === '__deadline__' ? { ...FULL, deadline: Date.now() + 1e9 } : context,
            input: [{ program: [{ op: 'reporting', as: 'reporting' }, { op: 'signal', as: 'signal' }, { op: 'remaining', as: 'remaining' },
              { op: 'meterState', as: 'meter' }, { op: 'phase', name: 'p', body: [] }, regs] }] }),
        }, result(index + 1)]),
    ].flat(),
    exit: 'eof',
  },
  {
    name: 'phases, quiet phases, timed steps, summaries and timeouts',
    init: init(),
    steps: [REPORTING, SUMMARIZED, { ...SUMMARIZED, observeOnly: true }, { summary: { minMs: 0 }, metered: true }].flatMap((context, index) => [call(index + 1, [
      { op: 'phase', name: 'a', body: [{ op: 'step', name: 'inner', elapsedMs: 5, count: 3 }] },
      { op: 'quiet', name: 'q', body: [] },
      { op: 'timed', name: 't', body: [] },
      { op: 'step', name: 'x', elapsedMs: 2 },
      { op: 'step', name: 'y', elapsedMs: 1, count: -1 },
      { op: 'step', name: 'z', elapsedMs: 1, count: 1.5 },
      { op: 'try', body: [{ op: 'phase', name: 'fails', body: [{ op: 'throw', value: error('changing', { fields: { code: 'workspace_changing' } }) }] }], as: 'changing' },
      { op: 'try', body: [{ op: 'phase', name: 'lock', body: [{ op: 'throw', value: error('lock', { fields: { code: 'LOCK_TIMEOUT' } }) }] }], as: 'lock' },
      { op: 'try', body: [{ op: 'quiet', name: 'quietTimeout', body: [{ op: 'throw', value: error('http', { name: 'TimeoutError' }) }] }], as: 'timeout' },
      { op: 'try', body: [{ op: 'phase', name: 'plain', body: [{ op: 'throw', value: 'text' }] }], as: 'plain' },
      { op: 'try', body: [{ op: 'timed', name: 'timedFails', body: [{ op: 'throw', value: error('timed', { fields: { code: 'capture_timeout' } }) }] }], as: 'timed' },
      { op: 'diagnostic', record: { custom: 1, nested: { list: [1, undefined] } } },
      regs,
    ], { context }), result(index + 1)]),
    exit: 'eof',
  },
  {
    name: 'a summary keeps 32 steps; a slow phase is journaled while it runs',
    init: init(),
    answer: deferNamed('slow', 'slow-plain'),
    steps: [
      call(1, [...Array.from({ length: 40 }, (_, index) => ({ op: 'step', name: `s${index}`, elapsedMs: index })), { op: 'step', name: 's3', elapsedMs: 1, count: 2 }], { context: SUMMARIZED }),
      result(1),
      call(2, [{ op: 'phase', name: 'slow', body: [{ op: 'call', fn: 0, args: ['slow'] }] }, { op: 'return', value: 'done' }], { context: { ...REPORTING, summary: { minMs: 0, slowMs: 1 } }, fns: [fn(1)] }),
      callback('slow'),
      { await: (message) => message?.type === 'report' && message.id === 2 && message.record?.slow === true, label: 'the slow report' },
      { answer: 'slow', value: 'late' },
      result(2),
      call(3, [{ op: 'phase', name: 'unsummarized', body: [{ op: 'call', fn: 0, args: ['slow-plain'] }] }], { context: REPORTING, fns: [fn(1)] }),
      callback('slow-plain'),
      { answer: 'slow-plain', value: 'x' },
      result(3),
    ],
    exit: 'eof',
  },
  {
    name: 'aborts before, during and after a call, and on calls that cannot be cancelled',
    init: init(),
    answer: deferNamed('hold', 'hold2', 'hold3'),
    steps: [
      { send: { type: 'abort', id: 1, reason: { __devryanError: true, message: 'too early' } } },
      call(1, [{ op: 'check' }, { op: 'return', value: 'ran' }], { context: REPORTING }),
      result(1),
      call(2, [{ op: 'call', fn: 0, args: ['hold'] }, { op: 'check' }, { op: 'return', value: 'unreached' }], { context: REPORTING, fns: [fn(1)] }),
      callback('hold'),
      { send: { type: 'abort', id: 2, reason: { __devryanError: true, name: 'AbortError', message: 'stopped', code: 'cancelled', status: 499, errors: [{ __devryanError: true, message: 'part' }], cause: wireChain(5) } } },
      { answer: 'hold', value: 'answered anyway' },
      result(2),
      call(3, [{ op: 'queue', gate: 'never' }], { context: REPORTING }),
      { send: { type: 'abort', id: 3, reason: { __devryanError: true, message: 'left the queue' } } },
      result(3),
      call(4, [{ op: 'call', fn: 0, args: ['hold2'] }, { op: 'check' }, { op: 'return', value: 'not cancellable' }], { context: { ...REPORTING, cancellable: false }, fns: [fn(1)] }),
      callback('hold2'),
      { send: { type: 'abort', id: 4, reason: { message: 'ignored' } } },
      { answer: 'hold2', value: 'x' },
      result(4),
      call(5, [{ op: 'call', fn: 0, args: ['hold3'] }, { op: 'phase', name: 'after', body: [] }], { context: REPORTING, fns: [fn(1)] }),
      callback('hold3'),
      { send: { type: 'abort', id: 5 } },
      { send: { type: 'abort', id: 5, reason: { message: 'second abort' } } },
      { answer: 'hold3', value: 'x' },
      result(5),
      { send: { type: 'abort', id: 5, reason: { message: 'after the result' } } },
      call(6, [{ op: 'queue', gate: 'never' }], { context: REPORTING }),
      { send: { type: 'abort', id: 6, reason: { errors: 'not an array', cause: 'text', name: 7 } } },
      result(6),
    ],
    exit: 'eof',
  },
  {
    name: 'an abort takes a waiting caller out of the I/O pool without its slot',
    init: init(),
    steps: [
      ...Array.from({ length: 8 }, (_, index) => call(10 + index, [{ op: 'io', root: '/project', body: [{ op: 'await', gate: 'release' }] }, { op: 'return', value: `held ${index}` }], { context: REPORTING })),
      call(18, [{ op: 'io', root: '/project', body: [{ op: 'return', value: 'never' }] }], { context: REPORTING }),
      { send: { type: 'abort', id: 18, reason: { __devryanError: true, message: 'gave up waiting' } } },
      result(18),
      call(19, [{ op: 'io', root: '/project', body: [{ op: 'return', value: 'queued behind eight' }], as: 'v' }, ret('v')], { context: REPORTING }),
      call(20, [{ op: 'open', gate: 'release' }]),
      ...Array.from({ length: 8 }, (_, index) => result(10 + index)),
      result(19),
    ],
    exit: 'eof',
  },
  {
    name: 'streams: pulls, early returns, failures, waits and pulls that overlap',
    init: init({ onDiagnostic: true }),
    answer: deferNamed('seven', 'eight'),
    steps: [
      call(1, [{ op: 'return', value: { s: { $stub: 'stream', name: 'one', chunks: ['a', Buffer.from([9]), { x: undefined }] } } }]),
      result(1),
      ...[1, 2, 3, 4].flatMap(() => [{ send: { type: 'pull', stream: 1 } }, { await: (message) => message?.type === 'chunk' && message.stream === 1, label: 'chunk of one' }]),
      { send: { type: 'pull', stream: 1 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 1 && !('value' in message), label: 'one is gone' },
      call(2, [{ op: 'return', value: { $stub: 'stream', name: 'two', chunks: ['x', 'y'] } }]),
      result(2),
      { send: { type: 'pull', stream: 2 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 2, label: 'chunk of two' },
      { send: { type: 'stream-return', stream: 2 } },
      observed((message) => message.payload?.stream === 'two', 'two closed'),
      { send: { type: 'pull', stream: 2 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 2 && message.done, label: 'two is gone' },
      call(3, [{ op: 'return', value: { $stub: 'stream', name: 'three', chunks: ['never pulled'] } }]),
      result(3),
      { send: { type: 'stream-return', stream: 3 } },
      { send: { type: 'pull', stream: 3 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 3, label: 'three is gone' },
      call(4, [{ op: 'return', value: { $stub: 'stream', name: 'four', chunks: ['z'], fail: error('broke', { fields: { code: 'stream_broke' } }) } }]),
      result(4),
      { send: { type: 'pull', stream: 4 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 4, label: 'chunk of four' },
      { send: { type: 'pull', stream: 4 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 4 && message.error, label: 'four failed' },
      call(5, [{ op: 'return', value: { $stub: 'stream', name: 'five', chunks: ['w'], wait: 0 } }], { fns: [fn(1)] }),
      result(5),
      { send: { type: 'pull', stream: 5 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 5, label: 'chunk of five' },
      { send: { type: 'pull', stream: 5 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 5 && message.done, label: 'five done' },
      call(6, [{ op: 'return', value: [{ $stub: 'stream', name: 'six-a', chunks: ['6a'] }, { $stub: 'stream', name: 'six-b', chunks: ['6b'] }, { $stub: 'fn' }] }]),
      result(6),
      { send: { type: 'pull', stream: 7 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 7, label: 'six-b still pulls' },
      call(7, [{ op: 'return', value: { $stub: 'stream', name: 'seven', chunks: ['p'], wait: 0 } }], { fns: [fn(2)] }),
      result(7),
      { send: { type: 'pull', stream: 8 } },
      { send: { type: 'pull', stream: 8 } },
      callback('seven'),
      { answer: 'seven', value: 'go' },
      { await: (message) => message?.type === 'chunk' && message.stream === 8 && message.done, label: 'seven done' },
      call(8, [{ op: 'return', value: { $stub: 'stream', name: 'eight', chunks: ['q', 'r'], wait: 0 } }], { fns: [fn(3)] }),
      result(8),
      { send: { type: 'pull', stream: 9 } },
      callback('eight'),
      { send: { type: 'stream-return', stream: 9 } },
      { answer: 'eight', value: 'go' },
      observed((message) => message.payload?.stream === 'eight', 'eight closed'),
      { send: { type: 'pull', stream: 9 } },
      { await: (message) => message?.type === 'chunk' && message.stream === 9 && message.done, label: 'eight is gone' },
      { send: { type: 'pull', stream: 'nine' } },
      { await: (message) => message?.type === 'chunk' && message.stream === 'nine', label: 'an unknown stream' },
    ],
    exit: 'eof',
  },
  {
    name: 'progress: a queue wait is forwarded as waiting, and settling forwards once more',
    init: init(),
    answer: deferNamed('wait'),
    steps: [
      call(1, [{ op: 'slotWait', body: [{ op: 'call', fn: 0, args: ['wait'] }] }, { op: 'return', value: 'ok' }], { context: FULL, fns: [fn(1)] }),
      callback('wait'),
      { await: (message) => message?.type === 'progress' && message.id === 1 && message.waiting === true, label: 'progress waiting' },
      { answer: 'wait', value: 'x' },
      result(1),
      call(2, [{ op: 'progress' }, { op: 'return', value: 'fast' }], { context: FULL }),
      result(2),
      call(3, [{ op: 'progress' }], { context: REPORTING }),
      result(3),
      call(4, [{ op: 'meter', body: [{ op: 'meterState', as: 'inner' }] }, { op: 'meterState', as: 'outer' }, regs], { context: REPORTING }),
      result(4),
    ],
    exit: 'eof',
  },
  {
    name: 'background work keeps its call after the result; unhandled rejections are reported',
    init: init({ onDiagnostic: true }),
    steps: [
      call(1, [{ op: 'background', body: [{ op: 'await', gate: 'bg' }, { op: 'observe', observer: 'onDiagnostic', payload: { late: true } }] }, { op: 'return', value: 'early' }]),
      result(1),
      call(2, [{ op: 'open', gate: 'bg' }]),
      observed((message) => message.payload?.late === true, 'the late observation'),
      call(3, [{ op: 'background', unhandled: true, body: [{ op: 'await', gate: 'bg2' }, { op: 'throw', value: error('background', { fields: { code: 'bg_code' } }) }] }, { op: 'return', value: 'r3' }]),
      result(3),
      call(4, [{ op: 'open', gate: 'bg2' }]),
      observed((message) => message.payload?.code === 'bg_code', 'the unhandled background failure'),
      call(5, [{ op: 'unhandled', value: 'not an error' }, { op: 'return', value: 'r5' }]),
      observed((message) => message.payload?.code === 'unhandled_rejection', 'the unhandled value'),
      result(5),
    ],
    exit: 'eof',
  },
  {
    name: 'errors of every field shape, aggregate errors and causes four deep',
    init: init(),
    steps: [
      error('custom', { name: 'Custom', message: 5, fields: { code: 'c', status: 500, committed: true, rollbackFailed: false, retryable: true, reason: 'r' } }),
      error('odd fields', { fields: { code: { x: 1 }, status: null, reason: [1], retryable: undefined } }),
      { $stub: 'error', errors: [error('one', { fields: { code: 'e1' } }), 'text', 5, null, error('with cause', { cause: error('inner') })] },
      chain(6),
      error('null cause', { cause: null }),
      error('text cause', { cause: 'just text' }),
      error('undefined cause', { cause: undefined }),
      { $stub: 'error', message: 'nested aggregate', errors: [{ $stub: 'error', message: 'level 1', errors: [{ $stub: 'error', message: 'level 2', errors: [{ $stub: 'error', message: 'level 3', errors: [{ $stub: 'error', message: 'level 4', errors: [error('level 5')] }] }] }] }] },
      'thrown text', 42, undefined, null, { plain: 'object' }, [1, [2, null]], true,
    ].flatMap((thrown, index) => [call(index + 1, [{ op: 'throw', value: thrown }], { context: SUMMARIZED }), result(index + 1)]),
    exit: 'eof',
  },
  {
    name: 'values at the depth limit',
    init: init(),
    steps: [
      call(1, [{ op: 'return', value: { $stub: 'deep', depth: 64, leaf: 'x' } }]), result(1),
      call(2, [{ op: 'return', value: { $stub: 'deep', depth: 65, leaf: 'x' } }], { context: SUMMARIZED }), result(2),
      call(3, [{ op: 'return', value: { $stub: 'deep', depth: 64, leaf: [] } }]), result(3),
      call(4, [{ op: 'return', value: { $stub: 'deep', depth: 65, leaf: [] } }]), result(4),
      echo(5, [deep(63)]), result(5),
      echo(6, [deep(64)]), result(6),
      call(7, [{ op: 'return', value: { $stub: 'deep', depth: 70, leaf: error('deep error') } }]), result(7),
    ],
    exit: 'eof',
  },
  {
    name: 'unknown and odd messages are ignored; blank and CRLF lines are read',
    init: init(),
    steps: [
      { send: { type: 'nonsense' } },
      { raw: '5\n"text"\nnull\n[]\n{}\n\n\n' },
      { send: { type: 'init', workerData: init() } },
      { send: { type: 'pull' } },
      { await: (message) => message?.type === 'chunk', label: 'a pull of no stream' },
      { raw: '{"type":"call","id":1,"method":"stubEcho","input":["crlf"],"context":null}\r\n' },
      result(1),
      { raw: Buffer.concat([Buffer.from('{"type":"call","id":2,"method":"stubEcho","input":["'), Buffer.from([0xff, 0xc3]), Buffer.from('"],"context":null}\n')]) },
      result(2),
    ],
    exit: 'eof',
  },
  {
    name: 'a line that is not JSON ends the process after what came before',
    init: init(),
    steps: [echo(1, ['before']), result(1), { raw: 'not json\n' }, { pause: 200 }],
    exit: 'corrupt',
  },
  {
    name: 'an unknown tag ends the process',
    init: init(),
    steps: [echo(1, ['before']), result(1), { raw: '{"type":"call","id":2,"method":"stubEcho","input":[{"$dr":"weird"}]}\n' }, { pause: 200 }],
    exit: 'corrupt',
  },
  {
    name: 'stdin closing mid-call ends the process at once and nothing is written after',
    init: init({ onDiagnostic: true }),
    answer: deferNamed('never answered'),
    never: (message) => ['unreached', 'after the close'].includes(message?.payload) || (message?.type === 'result' && [1, 2].includes(message.id)),
    steps: [
      call(1, [{ op: 'call', fn: 0, args: ['never answered'] }, { op: 'observe', observer: 'onDiagnostic', payload: 'unreached' }], { fns: [fn(1)], context: FULL }),
      callback('never answered'),
      call(2, [{ op: 'sleep', ms: 100 }, { op: 'observe', observer: 'onDiagnostic', payload: 'after the close' }]),
      { close: true },
      { pause: 400 },
    ],
    exit: 'eof',
  },
  {
    name: 'a blocked event loop is observed as a worker stall',
    init: init({ onWorkerStall: true }, { stallClock: { tickMs: 50, stallMs: 400 } }),
    steps: [
      call(1, [{ op: 'block', ms: 900 }, { op: 'return', value: 'blocked' }]),
      result(1),
      { await: (message) => message?.type === 'observe' && message.observer === 'onWorkerStall', label: 'the stall' },
    ],
    exit: 'eof',
  },
  {
    name: 'cleanup ends its own work after its timeout',
    init: init(),
    steps: [
      call(1, [{ op: 'try', body: [{ op: 'cleanup', timeoutMs: 30, body: [{ op: 'queue', gate: 'never' }] }], as: 'expired' },
        { op: 'cleanup', body: [{ op: 'signal', as: 'signal' }, { op: 'return', value: 'clean' }], as: 'ran' }, regs], { context: REPORTING }),
      result(1),
      call(2, [{ op: 'cleanup', timeoutMs: 0, capMs: 0, body: [{ op: 'sleep', ms: 20 }, { op: 'check' }] }]),
      result(2),
    ],
    exit: 'eof',
  },
  // Orders the JavaScript fixes, compared strictly (`ordered`: the messages
  // whose order must be equal on every arm, the worker on a real thread
  // included). Each line is one message to the worker, and every
  // continuation it made runnable runs before the next one.
  {
    name: 'within one call, a continuation a timer made runnable runs before the next timer',
    init: init(),
    steps: [
      call(1, [
        { op: 'background', body: [{ op: 'sleep', ms: 30 }, { op: 'diagnostic', record: { r: 'a1' } }, { op: 'open', gate: 'g' }] },
        { op: 'background', body: [{ op: 'sleep', ms: 30 }, { op: 'diagnostic', record: { r: 'b' } }] },
        { op: 'await', gate: 'g' },
        { op: 'diagnostic', record: { r: 'a2' } },
        { op: 'sleep', ms: 60 },
      ], { context: REPORTING }),
      result(1),
    ],
    ordered: (message) => message?.type === 'report' || message?.type === 'result',
    exit: 'eof',
  },
  {
    name: 'a call runs to its first suspension before a later line of the same write is handled',
    init: init(),
    steps: [
      { await: (message) => message?.type === 'ready', label: 'ready' },
      { raw: [
        { type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'diagnostic', record: { r: 'sync' } }, { op: 'sleep', ms: 20 }], fns: [] }], context: REPORTING },
        { type: 'call', id: 2, method: 'unknownMethod', input: [], context: null },
        { type: 'call', id: 3, method: 'stubRun', input: [{ program: [{ op: 'call', fn: 0, args: ['sync callback'] }, { op: 'diagnostic', record: { r: 'after the answer' } }], fns: [fn(3)] }], context: REPORTING },
        { type: 'call', id: 4, method: 'stubEcho', input: ['at once'], context: null },
      ].map((message) => `${JSON.stringify(message)}\n`).join('') },
      result(1), result(2), result(3), result(4),
    ],
    // Call 1's result waits for its 20 ms timer, so where it falls among the
    // other calls' messages is wall time, not order: it is left out (S1b).
    ordered: (message) => ['report', 'callback'].includes(message?.type) || (message?.type === 'result' && message.id !== 1),
    exit: 'eof',
  },
  {
    name: 'an answer and an abort in one write: the call resumes before the abort lands; an abort right behind the call lands at its next check',
    init: init(),
    answer: (message) => (message.args?.[0] === 'hold' ? { defer: `h${message.target.call}` } : { value: 1 }),
    steps: [
      { await: (message) => message?.type === 'ready', label: 'ready' },
      { raw: `${JSON.stringify({ type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'check' }, { op: 'phase', name: 'p', body: [{ op: 'call', fn: 0, args: ['hold'] }] }, { op: 'return', value: 'done' }], fns: [fn(1)] }], context: REPORTING })}\n`
        + `${JSON.stringify({ type: 'abort', id: 1, reason: { __devryanError: true, message: 'same write as the call', code: 'x' } })}\n` },
      { await: (message) => message?.type === 'callback' && message.target?.call === 1, label: 'callback 1' },
      { answer: 'h1', value: 'answer 1' },
      result(1),
      call(2, [{ op: 'check' }, { op: 'phase', name: 'p', body: [{ op: 'call', fn: 0, args: ['hold'] }] }, { op: 'return', value: 'done' }], { context: REPORTING, fns: [fn(2)] }),
      { await: (message) => message?.type === 'callback' && message.target?.call === 2, label: 'callback 2' },
      { raw: `${JSON.stringify({ type: 'callback-result', id: 2, failed: false, value: 'ok' })}\n${JSON.stringify({ type: 'abort', id: 2, reason: { __devryanError: true, message: 'racing' } })}\n` },
      result(2),
      call(3, [{ op: 'phase', name: 'q', body: [{ op: 'call', fn: 0, args: ['hold'] }] }, { op: 'return', value: 'unchecked' }], { context: REPORTING, fns: [fn(3)] }),
      { raw: `${JSON.stringify({ type: 'abort', id: 3, reason: { __devryanError: true, message: 'while the host holds the answer' } })}\n` },
      { await: (message) => message?.type === 'callback' && message.target?.call === 3, label: 'callback 3' },
      { answer: 'h3', value: 'answer 3' },
      result(3),
    ],
    ordered: (message) => message?.type === 'result' || message?.type === 'report',
    exit: 'eof',
  },
  {
    // Node truncates a delay to whole milliseconds: 10.9 ms is the 10 ms
    // list, which fires in creation order.
    name: 'a fractional delay is truncated: 10.9 ms and 10 ms timers share one list',
    init: init(),
    steps: [
      call(1, [
        ...[1, 2, 3].flatMap((round) => [
          { op: 'background', body: [{ op: 'sleep', ms: 10.9 }, { op: 'diagnostic', record: { r: `fractional ${round}` } }] },
          { op: 'background', body: [{ op: 'sleep', ms: 10 }, { op: 'diagnostic', record: { r: `whole ${round}` } }] },
          { op: 'sleep', ms: 40 },
        ]),
      ], { context: REPORTING }),
      result(1),
    ],
    ordered: (message) => message?.type === 'report',
    exit: 'eof',
  },
  {
    name: 'a deadline in the past leaves exactly nothing: the clock is epoch milliseconds',
    init: init(),
    steps: [
      call(1, [{ op: 'remaining', exact: true, as: 'ms' }, regs], { context: { ...REPORTING, deadline: PAST_DEADLINE } }),
      result(1),
    ],
    exit: 'eof',
  },
  // JavaScript's job order inside one call (B2 of the second review): every
  // await takes a job, even of a settled promise, and a phase is an async
  // function of its own. Each call's messages are compared in order.
  {
    name: 'an await of a gate already open still yields to the code after the background start',
    init: init(),
    steps: [
      call(1, [
        { op: 'open', gate: 'hop-g', value: 1 },
        { op: 'background', body: [{ op: 'await', gate: 'hop-g' }, { op: 'diagnostic', record: { r: 'x' } }] },
        { op: 'diagnostic', record: { r: 'y' } },
        { op: 'sleep', ms: 5 },
      ], { context: REPORTING }),
      result(1),
    ],
    ordered: (message) => message?.type === 'report' || message?.type === 'result',
    exit: 'eof',
  },
  {
    name: 'two background chains of settled awaits finish in the order of their job counts',
    init: init(),
    steps: [
      call(1, [
        { op: 'open', gate: 'hop-h', value: 1 },
        { op: 'background', body: [{ op: 'await', gate: 'hop-h' }, { op: 'await', gate: 'hop-h' }, { op: 'await', gate: 'hop-h' }, { op: 'diagnostic', record: { r: 'three' } }] },
        { op: 'background', body: [{ op: 'await', gate: 'hop-h' }, { op: 'diagnostic', record: { r: 'one' } }] },
        { op: 'sleep', ms: 5 },
      ], { context: REPORTING }),
      result(1),
    ],
    ordered: (message) => message?.type === 'report' || message?.type === 'result',
    exit: 'eof',
  },
  {
    name: 'a phase with an empty body completes after the code that follows its start',
    init: init(),
    steps: [
      call(1, [
        { op: 'background', body: [{ op: 'phase', name: 'bg', body: [] }] },
        { op: 'diagnostic', record: { r: 'main' } },
        { op: 'sleep', ms: 5 },
      ], { context: REPORTING }),
      result(1),
    ],
    ordered: (message) => message?.type === 'report' || message?.type === 'result',
    exit: 'eof',
  },
];

const PRODUCT_INIT = init();
export const PRODUCT_TRANSCRIPTS = [
  {
    name: 'the product worker and the native build list the same methods and answer what needs none',
    init: { ...PRODUCT_INIT, observers: { onDiagnostic: true, onChange: true } },
    steps: [
      { send: { type: 'call', id: 1, method: 'nope', input: [], context: FULL } },
      result(1),
      { send: { type: 'pull', stream: 5 } },
      { await: (message) => message?.type === 'chunk', label: 'the pull' },
      { send: { type: 'abort', id: 9, reason: { message: 'none' } } },
      { send: { type: 'callback-result', id: 3, failed: false, value: 1 } },
      { send: { type: 'stream-return', stream: 2 } },
      { send: { type: 'unknown' } },
      { send: { type: 'call', id: 2, method: 'stubEcho', input: [], context: null } },
      result(2),
    ],
    exit: 'eof',
  },
  { name: 'init with protocol 1 is accepted', init: PRODUCT_INIT, protocol: 1, steps: [], exit: 'eof' },
  { name: 'init without workerData is refused', init: { line: '{"type":"init"}\n' }, steps: [], exit: 'refused' },
  { name: 'init with a relative directory is refused', init: { directory: 'relative', observers: {} }, steps: [], exit: 'refused' },
  { name: 'init with a directory that is not a string is refused', init: { directory: 5 }, steps: [], exit: 'refused' },
  { name: 'init with a zero install batch is refused', init: { ...PRODUCT_INIT, batching: { install: 0 } }, steps: [], exit: 'refused' },
  { name: 'init with a string install batch is refused', init: { ...PRODUCT_INIT, batching: { initialInstall: '64' } }, steps: [], exit: 'refused' },
  { name: 'init with valid batches is accepted', init: { ...PRODUCT_INIT, batching: { install: 64 } }, steps: [], exit: 'eof' },
  { name: 'init with a warning above its ceiling is refused', init: { ...PRODUCT_INIT, complexity: { warnEntries: 2_000_000 } }, steps: [], exit: 'refused' },
  { name: 'init with string complexity is refused', init: { ...PRODUCT_INIT, complexity: 'ab' }, steps: [], exit: 'refused' },
  { name: 'init with array complexity of positive integers is accepted', init: { ...PRODUCT_INIT, complexity: [5] }, steps: [], exit: 'eof' },
  { name: 'init with an extra complexity key that is not a number is refused', init: { ...PRODUCT_INIT, complexity: { extra: 'x' } }, steps: [], exit: 'refused' },
  { name: 'a stall clock with an injected clock is refused when stalls are observed', init: { ...PRODUCT_INIT, observers: { onWorkerStall: true }, stallClock: { now: 1 } }, steps: [], exit: 'refused' },
  { name: 'a stall clock with an injected clock is unused without the observer', init: { ...PRODUCT_INIT, stallClock: { now: 1 } }, steps: [], exit: 'eof' },
  { name: 'a stall clock with string timings is accepted', init: { ...PRODUCT_INIT, observers: { onWorkerStall: true }, stallClock: { tickMs: '50', stallMs: '5000' } }, steps: [], exit: 'eof' },
  { name: 'a first message that is not init ends the process', init: { line: '{"type":"call","id":1}\n' }, steps: [], exit: 'corrupt' },
  { name: 'a first line that is not JSON ends the process', init: { line: '{oops\n' }, steps: [], exit: 'corrupt' },
];

// Timed host scripts of the protocol under one virtual clock (the worker on
// Node's own timers, the Rust on the event loop the binary ships): every
// message is compared with its time, and the number of `progress` messages
// exactly. `steps` are `{ at, send }`; every callback is answered at once.
const vcall = (at, id, program, context = METERED_CONTEXT, fns = []) => ({ at, send: { type: 'call', id, method: 'stubRun', input: [{ program, fns }], context } });
const METERED_CONTEXT = { ...REPORTING, metered: true };
export const VIRTUAL_TRANSCRIPTS = [
  {
    name: 'progress: every tick that sees the meter moved forwards it, and only those',
    init: init({ onWorkerStall: true }),
    steps: [
      vcall(0, 1, [...Array.from({ length: 10 }, () => [{ op: 'progress' }, { op: 'sleep', ms: 100 }]).flat(), { op: 'sleep', ms: 700 }, { op: 'progress' }]),
      vcall(130, 2, [{ op: 'slotWait', body: [{ op: 'sleep', ms: 400 }] }, { op: 'sleep', ms: 300 }]),
    ],
    until: 3_000,
  },
  {
    name: 'each message starts its call at once, in arrival order, before the next message',
    init: init(),
    steps: [
      vcall(5, 1, [{ op: 'diagnostic', record: { r: 'sync' } }, { op: 'sleep', ms: 20 }, { op: 'diagnostic', record: { r: 'later' } }], REPORTING),
      { at: 5, send: { type: 'call', id: 2, method: 'unknownMethod', input: [], context: null } },
      vcall(5, 3, [{ op: 'call', fn: 0, args: ['sync'], as: 'a' }, { op: 'diagnostic', record: { r: 'answered' } }, { op: 'return', value: { $stub: 'reg', name: 'a' } }], REPORTING, [fn(3)]),
      { at: 5, send: { type: 'abort', id: 1, reason: { __devryanError: true, message: 'right behind' } } },
    ],
    until: 100,
  },
  {
    name: 'timers: truncated delays share lists, lists fire by expiry then id, continuations run between timers',
    init: init(),
    steps: [
      vcall(0, 1, [
        { op: 'background', body: [{ op: 'sleep', ms: 2.5 }, { op: 'diagnostic', record: { r: '2.5' } }] },
        { op: 'background', body: [{ op: 'sleep', ms: 2 }, { op: 'diagnostic', record: { r: '2' } }] },
        { op: 'background', body: [{ op: 'sleep', ms: 3 }, { op: 'diagnostic', record: { r: '3' } }] },
        { op: 'background', body: [{ op: 'sleep', ms: 0 }, { op: 'diagnostic', record: { r: '0 is 1' } }] },
        { op: 'background', body: [{ op: 'sleep', ms: 30 }, { op: 'diagnostic', record: { r: 'a1' } }, { op: 'open', gate: 'g' }] },
        { op: 'background', body: [{ op: 'sleep', ms: 30 }, { op: 'diagnostic', record: { r: 'b' } }] },
        { op: 'background', body: [{ op: 'await', gate: 'g' }, { op: 'diagnostic', record: { r: 'a2' } }] },
        { op: 'sleep', ms: 29 },
        { op: 'background', body: [{ op: 'sleep', ms: 1 }, { op: 'diagnostic', record: { r: 'list 1 again, behind 30' } }] },
        { op: 'sleep', ms: 50 },
      ], REPORTING),
    ],
    until: 200,
  },
  {
    // The slow-phase timer is unrefed: clearing it leaves its emptied 50 ms
    // list in place, so a 50 ms sleep made at 20 ms joins that list, which
    // re-arms at 50 ms with an id newer than the 30 ms list made at 40 ms.
    name: 'timers: a cleared unrefed timer leaves its list, which a later timer of that duration reuses',
    init: init(),
    steps: [
      vcall(0, 1, [
        { op: 'background', body: [{ op: 'sleep', ms: 20 }, { op: 'sleep', ms: 50 }, { op: 'diagnostic', record: { r: 'fifty' } }] },
        { op: 'background', body: [{ op: 'sleep', ms: 40 }, { op: 'sleep', ms: 30 }, { op: 'diagnostic', record: { r: 'thirty' } }] },
        { op: 'phase', name: 'p', body: [{ op: 'sleep', ms: 5 }] },
        { op: 'sleep', ms: 100 },
      ], { ...REPORTING, summary: { minMs: 0, slowMs: 50 } }),
    ],
    until: 200,
  },
  {
    name: 'summaries and cleanup on the virtual clock: slow phases and the cleanup ticker',
    init: init(),
    steps: [
      vcall(0, 1, [
        { op: 'phase', name: 'slow', body: [{ op: 'sleep', ms: 2_100 }] },
        { op: 'cleanup', timeoutMs: 600, body: [{ op: 'progress' }, { op: 'sleep', ms: 700 }] },
      ], { ...METERED_CONTEXT, summary: { minMs: 0, slowMs: 2_000 } }),
    ],
    until: 5_000,
  },
];
