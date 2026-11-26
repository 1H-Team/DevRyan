// What the replayer of the client engine conformance harness needs from "an
// engine" (design file 29 §4.3, §6; package C0d), and the client side of it.
// The TypeScript engine (engine-ts.mjs, run by Bun) is its first
// implementation; a Rust runner is meant to implement the same protocol, so
// that the replayer, its comparison and its outcomes stay as they are and only
// the engine process changes (replay.mjs `--engine=` points it at another one).
//
// PROTOCOL 4 (package C0f; 3 was calls, timers, promise answers and state, 2
// synchronous calls only): transports, and inputs placed in their microtask
// drain. One engine process, one JSON request per line on
// its stdin, one JSON response per line on its stdout, each response carrying
// the `id` of its request. Values are codec trees (codec.mjs), never live
// objects. The engine is told what a real engine needs to run a step and
// nothing that names or locates a recorded case: no case id, test file, test
// name, container or recording path, no step number (steps are delivered in
// order; the engine numbers them 1, 2, ... itself), and none of the recorded
// outputs (returns, throws, after, changes, states, effect arguments). The
// mapping from what the engine is sent to the recorded case stays in the
// replayer. What the engine is told of a recorded output is only where an
// object it makes sits, so a later input can name it again (`bind`), and the
// recording's own names for its port calls, timers and handed-out engine code.
//
//   {id, op:"hello", protocol}                  -> {id, ok, engine, protocol}
//       The replayer refuses an engine whose `protocol` is not PROTOCOL.
//   {id, op:"open", unit, family, plants?, load?} -> {id, ok, exports}
//       `unit` is an opaque number of the run. A unit is one fresh module
//       instance of a family, all of whose module state starts as the module's
//       own load leaves it. Every case of the unit runs on it, in the order the
//       replayer sends them. `family` is {name, module, entries: [{export,
//       draft?}], injected: [{entry, member?, arg, key?, name}], ports:
//       [{module, export, name}], unordered: [port], store?, moduleState?:
//       {bindings}}, module paths absolute (what a TypeScript engine loads; a
//       Rust runner maps the family name to its module); `plants` is a list of
//       {module, source}: the engine loads `source` in place of that module's
//       file (a planted difference; never written). `load` (protocol 4) is
//       what the family's module graph took when it loaded, the same for every
//       case of the container: `portData`, a data port export's value by port
//       name (a client id the module drew), which the module must get instead
//       of what the engine's own load made. `family.wrapAnswers` names the ports
//       whose answers with behaviour are port objects a microtask later (and
//       every port named after one of them). A stateful family (`store`:
//       a zustand store export; `moduleState`: module bindings no export
//       exposes) has a state, `{store?: <the store's state>, module?:
//       {<binding>: <value>}}`; the engine subscribes a listener of its own to
//       the store before any case, so every notification is an effect.
//   {id, op:"case", unit}                       -> {id, ok, between}
//       Opens a case: a fresh identity scope, port-call, timer and handed-out
//       numbering and halt state. `between` lists what the unit noted while no
//       case was open since its previous case ended (an effect, an uncaught
//       error): the replayer charges it to that previous case (check `outside`).
//   {id, op:"seed", unit, state, bind?, strings?} -> {id, ok, seeded}
//       Before a stateful case's first step: brings the family's state to the
//       recorded `state` tree (its `const` containers in place, its `let`
//       bindings assigned, the store's state replaced with its actions kept),
//       none of it an effect. Sent for a case alone, and in file order where the
//       recording says the state moved since the case before ended (the case
//       before was not judged, or code no step holds moved it). The entry state
//       the engine then holds is reported (`entry`) and compared.
//   {id, op:"step", unit, step}                 -> {id, ok, halted}
//       `step` is {input, env, bind, during?, late?, hold?, entryBind?, strings?}.
//       `input` is one of: {kind:"call"|"new"|"get", entry, args, now} (an
//       export of the module; `<store>.<action>`, `<store>.setState`,
//       `<store>.subscribe`; or engine code a step handed the test,
//       `<entry>#<n>`, and members read from it, the last one the method or
//       getter); {kind:"timer", id, now} (a timer this case set fires: `id` is
//       the recording's name of it, which `bind` gave the engine when it set
//       the timer; one it never set, cleared, or (a timeout) already ran halts
//       the case `fired-unknown-timer`); {kind:"settle", port, call, outcome,
//       value, now} (a port's promise answer settles: `call` is the
//       recording's name of the port call, given in that call's env item; an
//       unknown one halts `settled-unknown-call`); {kind:"callback", port,
//       args, target, now} (the test calls a function the engine handed a port:
//       `target` names it by identity). The engine rebuilds the arguments from
//       the trees (an `id` n the case already bound is that very object,
//       brought to the content the tree gives it; a new n is a new object,
//       bound to n), delivers the input, and runs to quiescence (no job of the
//       step left) before it answers. `now` is the clock value of the step.
//       `env` is what the step's effects were answered with, in recorded
//       order, and nothing else: {kind:"port", port, call, answer | throws},
//       {kind:"read", port, key, value} (a data member of a port object the
//       engine was answered with), {kind:"clock", source, value},
//       {kind:"draw", source, value}, and (protocol 4) {kind:"new", port, call,
//       answer | throws} (a port function constructed: a socket) and reads of
//       the port `globalThis` (`key` a transport or DOM global the engine reads
//       itself: fetch, WebSocket, EventSource, localStorage, sessionStorage,
//       document, window, navigator; `value` undefined, a port function or a
//       port object). A port call, read, clock read or draw is
//       served the next item when that item is of its kind and name; anything
//       else halts the case (check `effect-order` when what was asked is later
//       in `env`, `unanswered` when it is not there). An answer {"$dr":
//       "promise"} is a promise the engine holds until a `settle` input names
//       its call; an answer {"$dr":"port"} is a port object whose member reads
//       are answered by `read` items and whose methods are port calls
//       `<port>.<member>` (a symbol-keyed method too: `<port>.Symbol(Symbol.
//       asyncIterator)`, so an answered async iterator is driven by `next`
//       calls whose promise answers settle with `{value, done}`); writing a
//       member is a `set` effect {port, key, value}, and a function written so
//       (a socket's onmessage) is the engine's own, called back by a
//       `callback` input. A function node with a `port` is a port function:
//       calling it is a port call, `new` a `new` effect, and its members
//       (`<port>.<member>`) port functions. Timers never run on their own: `timer.set` and
//       `timer.clear` are effects, and a firing is an input. `bind` lists
//       {slot, path, n} (when the engine takes that output slot: returns,
//       throws, after, changes, state, stateChanges, effects.<i>.args,
//       effects.<i>.state, effects.<i>.value; the object at `path` in it is the
//       recording's n from then on), {slot, path, name} (the value there is
//       the handed-out engine code `name`) and {timer, index} (the step's
//       index-th timer is the recording's timer `timer`). Binding tells where
//       an object sits in an output, never what the output holds. `during`
//       lists {call, step}: inputs the test made inside that port call of this
//       step (a subscriber calling back into the store), each delivered,
//       synchronously and as a step of its own, inside that call before it
//       answers. `late` says the test had ended before this input came (the
//       end state, and the pending timers, are those the test ended with); a
//       timer firing is never late (one that fires after its test ended is no
//       step: C0e fix round). `hold` (protocol 4) says the next input arrived
//       in the same microtask drain in a way the engine must reproduce, so it
//       keeps this one and delivers the group when a step comes without
//       `hold`: an input with `together` (it arrived before any microtask the
//       one before it started had run) is delivered right after the one
//       before it opened, and the one before forwards to it (what lands there
//       afterwards is the later input's); a settle with `immediate: g` (its
//       port's own promise settled g microtask generations after the call, in
//       the call's drain) is given by the call itself, through the same
//       promises as the recorder's (the port's own, then for a wrapAnswers
//       port the one the module holds a microtask later), g generations of a
//       no-op marker chain after the call, and never before a call or
//       callback of the group before it; any other input is delivered once
//       the engine has run out. An input opens when it is delivered (a call,
//       callback or timer: before its synchronous part; a settle: at the first
//       reaction of its promise, which the engine registers before the
//       module's). Steps are numbered in the recording's order, a step's
//       nested inputs right after it. `entryBind` binds the entry
//       state. `strings` (optional) are long strings added to the case's
//       string table (below), in order.
//   {id, op:"end", unit}                        -> {id, ok, replayed}
//       Closes the case: `replayed` is {steps, entry?, end?, pending, halt,
//       outside, bindFailures, strings?} with every value slot of the case written in one
//       identity scope (codec emitSlots: the entry state, the steps, the end
//       state), in the shape of a recorded case's steps (n the engine's own
//       count, input args as the engine saw them, effects in observed order,
//       `returnedAt`: how many of the step's effects came before its
//       synchronous part returned or threw, returns or throws, after, changes,
//       and for a stateful family `state` and `stateChanges` after the
//       synchronous part); `entry` and `end` are a stateful family's state when
//       the case began and ended. `pending` lists the case's timers still
//       pending when its test ended (set, not cleared, a timeout not fired),
//       in the order they were set: {timer (the recording's name its bind
//       gave it, or null), delay (a codec tree), repeat, step (the engine's
//       count of the step that set it)}; compared as `pending-timers`. A step
//       that has no synchronous part of the module's own (`settle`) reports no
//       `returnedAt`, as none is recorded. `halt` is {step, check, detail} (step: the
//       engine's count) or null. `outside` lists what was made or thrown while
//       no step of the case was open, charged to the case (an effect, an
//       uncaught error from a job the case scheduled); before answering, the
//       engine waits (bounded) for the jobs the case scheduled with
//       setImmediate or queueMicrotask.
//   {id, op:"close", unit, force?}              -> {id, ok, between}
//       `force` stops the unit at once (its engine did not answer in time).
//   {id, op:"stop"}                             -> {id, ok}, then the process exits.
//
// String tables. A string of 1,024 or more UTF-16 units may be sent once per
// case and stand in a tree as {"$dr":"slice","s":k}: in requests, strings[k] is
// the k-th string the case's requests added (`step.strings`, `seed.strings`);
// in an `end` answer, `replayed.strings[k]`. No codec tree has an own "$dr"
// member unescaped, so the node is never a value. Strings are JSON strings: a
// lone surrogate is a `\uD800`-style escape, which a reader that is not
// JavaScript must accept and keep as one UTF-16 unit (see ENGINE_ACCIDENTS). A
// line never holds a raw U+2028 or U+2029 (both are written as escapes,
// `protocolLine`), so a reader that ends lines there too reads one message per
// line; an engine must write its answers the same way.
//
// A failure is {id, ok:false, error}; a unit whose engine died answers every
// later request so, with `lost: true`.
//
// What a non-JavaScript engine must implement, beyond the calls of protocol 2:
// the store's state and its notifications (a `notify` effect for every
// notification, with the state and the previous state, in order with the
// subscribers' port calls, before or after the return as the module makes
// them), the module state a family names, seeded and read as above, the
// change set of the state (every path below its root whose object changed:
// copy-on-write, `Arc` identity projected to paths), timers as effects and
// firings as inputs (an interval fires any number of times until cleared, a
// timeout once, and those still pending at the end are reported; a clear of a handle that is no timer of the case's own names
// the handle itself), promise answers settled by inputs, port objects
// answered member by member, engine code handed to the test and called by its
// name, callbacks handed to ports called back by the test, inputs nested in a
// port call, and `returnedAt` (what a step did before it returned, against
// what its continuation did: a notification before the state is set, or one
// delivered after the action returned, is a difference). What is an accident
// of JavaScript it need not copy is ENGINE_ACCIDENTS below.
//
// What the interface can and cannot prove. The replayer judges what the engine
// answers against the recording it keeps to itself: an engine that echoes what
// it is sent, that answers a step with another step's recording, or that looks
// a case up by anything the protocol carries fails the closure (replay.test.mjs
// runs three such engines, on the pure toy family and on the store and timer
// toy family). It cannot prove anything against an engine that reads the
// fixture files itself and matches a case by the content of its inputs: that
// engine cheats on purpose, and only not giving it the files (a runner that is
// not handed the recording directory) or reviewing its source stops it. A Rust
// runner is a test program over the fixtures; it must keep the part that reads
// recorded outputs (to compare) apart from the engine it runs.
//
// What protocol 4 still lacks (package C0f report, "Not done"): a module the
// test mocked (its exports as ports the map does not list, answered by the
// test's factory); a promise or a body inside an answer; inputs a drain places
// some generations after the one before them other than a port's own answer
// (they come once the engine ran out, which the replay judges); the abort of
// a signal the test handed in (flagged `signal-aborted`).
//
// What a comparer must allow a runner that is no JavaScript executor (the C0f
// fix round, from the review's S6; for package C0g). Inside a `together`
// group, what an earlier member's continuations do after the later member
// opened is recorded in the later member's step (forwarding), because the
// group is delivered at once and no input of the protocol can tell them
// apart; a sans-IO Rust engine will attribute those effects to the member
// whose continuation made them. So a comparer must compare a group's effects
// as one sequence, in order, keeping each member's synchronous part and its
// `returnedAt`, and not by step; the TypeScript replay is unaffected, since it
// delivers a group as the recorder saw it. Likewise `immediate: g` asks for
// JavaScript's promise generations (counted up to IMMEDIATE_GENERATIONS, 64;
// an answer later in its call's drain is refused, `immediate-expired`): a
// runner without them may give an immediate answer before the engine runs
// out, in recorded order, and be judged on the group's sequence. The counts
// themselves belong to the JavaScript engine (a Bun upgrade can move them,
// and the recorder's own promise wrappers move them by a generation in some
// patterns: the immediates toy), so a change of Bun regenerates the corpus.
// `load.portData` is drawn per test file, so with a case's ordinal it names
// the container: never hand a runner the recording.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTracked } from './children.mjs';

export const PROTOCOL = 4;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '..');
/** From this length (UTF-16 units) a string may travel once per case in a string table (see above). */
export const LONG_STRING = 1024;

/**
 * What in the recordings, and so in this protocol, is an accident of
 * JavaScript that a Rust engine should not have to imitate, with what its
 * runner should do instead. The TypeScript closure compares all of them
 * exactly (it is the same engine), except the two that are no behaviour
 * (replay-compare.mjs NOT_COMPARED); a Rust runner should judge them as stated.
 */
export const ENGINE_ACCIDENTS = Object.freeze([
  { what: 'clock reads as effects', instead: 'JavaScript reads Date.now(), new Date(), Date() and performance.now() as often as its code does, each a recorded `clock` effect with its source. A Rust module is handed the step\'s `now` and never reads a clock: its runner should drop `clock` effects from the comparison and judge stored times by the time oracle (a stored time must equal a supplied now, design §4.2)' },
  { what: 'the source names of draws', instead: 'a `draw` effect names its JavaScript source, and the source carries the draw\'s type: `Math.random` a float in [0, 1), `crypto.randomUUID` a UUID string, `crypto.getRandomValues` bytes of the length asked for. They are three kinds of draw, not one stream. A Rust module takes its draws in order by type; its runner should map each source name to its type once and compare the order, the type and the value of every draw, not the JavaScript name' },
  { what: 'port names of module ports', instead: '`module:<path>#<export>` names a JavaScript module file. The Rust module boundaries mirror the port map (§6), so a runner maps each such name to the Rust port once, in a table, rather than reproducing file paths' },
  { what: 'functions in values', instead: 'a function handed in (an injected callback) is written `{"$dr":"function","name":…}` with its JavaScript name; a Rust engine has its port, not the name. Its runner should treat the node as the port the map declares at that position' },
  { what: 'object identity numbers', instead: 'the codec numbers objects a case reaches more than once; a Rust engine has `Arc` identity instead. Its runner compares identity structure (which positions hold the same object), never the numbers: the replayer pairs the two namings position by position (replay-compare.mjs createIdentityJudge)' },
  { what: 'binding of engine-made objects to recorded numbers', instead: 'JavaScript passes the very object a step returned to the next call. A Rust engine that owns its state needs no binding for state it keeps; it needs it only for values the test hands back (`bind`)' },
  { what: 'messages the JavaScript engine writes itself', instead: 'a native error the engine throws, not the module\'s code (a TypeError from reading a member of null), carries the engine\'s own text: JavaScriptCore writes "null is not an object (evaluating \'diff.additions\')" (two recorded session-diff-stats cases), V8 "Cannot read properties of null (reading \'additions\')", and a Rust module cannot write either. Its runner should compare the class, the `name` and the own data of such an error exactly and its message only as engine-made: a thrown native error whose message the module\'s source does not build is listed for review when the messages differ, never passed or failed silently. The TypeScript closure compares the message exactly (same engine)' },
  { what: 'timer handles in values', instead: 'a module that keeps a timer handle in its state (the history budget\'s accounting timer) holds Bun\'s `Timeout` object, written `{"$dr":"class","name":"Timeout","value":{}}`; a Rust module holds a handle of its own. Its runner should compare a handle as a timer handle by its identity (which position holds which handle), not by its class name' },
  { what: 'the numbers of port calls, timers and handed-out code', instead: 'a port call\'s `call`, a timer\'s `id` and the `<entry>#<n>` of engine code handed to the test are the recorder\'s counts in the order JavaScript made them (and, for handed-out code, of what it wrapped). They are names: the TypeScript closure compares port call numbers and timer ids as pairings across the case, and the replayer hands the engine the recording\'s names (`call` in env items, `{timer, index}` and `{name}` binds), so a Rust engine numbers its own and its runner maps them, never reproducing the counts' },
  { what: 'a store\'s actions as values of its state', instead: 'a zustand store keeps its actions in its state, so a recorded state holds `{"$dr":"function","name":"saveX"}` members (and groups of them, `actions`); a Rust store has methods. Its runner should take those members as the store\'s action names, present in every state, and compare the rest of the state as data' },
  { what: 'lone surrogates in JSON text', instead: 'codec strings are UTF-16: containers and this protocol carry a lone surrogate as a `\\uD800`-style escape (the replayer\'s toy family records one). A JSON reader that decodes into UTF-8 strings (serde_json\'s `String`) rejects or replaces it. A Rust runner must read codec strings as UTF-16 code units (the `ledger-core` JSON parser into `JsStr`), and write them back the same way' },
]);

/**
 * One protocol line: JSON with U+2028 and U+2029 written as escapes (JSON
 * allows both raw), so a reader that also ends lines there (Node's readline
 * does) still reads one request per line.
 */
export const protocolLine = (message) => JSON.stringify(message).replace(/[\u2028\u2029]/g, (character) => (character === '\u2028' ? '\\u2028' : '\\u2029'));

/**
 * Long strings of a tree put in a string table: each string of LONG_STRING
 * units or more becomes {"$dr":"slice","s":k}, k its index in `table` (an
 * array the caller keeps for the case; `known` maps a string to its index).
 * Returns the tree with the strings replaced; new strings are appended.
 */
export function shareStrings(node, table, known = new Map(table.map((text, index) => [text, index]))) {
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.length < LONG_STRING) return value;
      let index = known.get(value);
      if (index === undefined) { index = table.length; table.push(value); known.set(value, index); }
      return { $dr: 'slice', s: index };
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__') Object.defineProperty(out, key, { value: visit(value[key]), writable: true, enumerable: true, configurable: true });
      else out[key] = visit(value[key]);
    }
    return out;
  };
  return visit(node);
}

/** A tree with its string-table references put back (the inverse of shareStrings); an index out of the table throws. */
export function expandStrings(node, table) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => expandStrings(item, table));
  if (node.$dr === 'slice' && Object.keys(node).length === 2 && Number.isInteger(node.s)) {
    if (node.s < 0 || node.s >= table.length) throw new Error(`a tree referred to string ${node.s} of a table of ${table.length}`);
    return table[node.s];
  }
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === '__proto__') Object.defineProperty(out, key, { value: expandStrings(node[key], table), writable: true, enumerable: true, configurable: true });
    else out[key] = expandStrings(node[key], table);
  }
  return out;
}

/** The command that runs the TypeScript engine under the test isolation guard (`cwd` decides how Bun resolves the product's path aliases). */
export function typescriptEngine({ cwd }) {
  return {
    name: 'typescript',
    command: process.execPath,
    args: [path.join(SCRIPTS, 'test-isolation-guard.mjs'), 'bun', '--preload', path.join(SCRIPTS, 'test-isolation-preload.mjs'), path.join(HERE, 'engine-ts.mjs')],
    cwd,
  };
}

// How long a stopping engine has to answer `stop` and then to exit before its process group is killed.
const STOP_MS = 10000;
const killGroup = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };

/**
 * Starts an engine process. Every request has a deadline (`deadlineMs`); one
 * that passes rejects with an error naming the engine, the request and what
 * it was waiting for, so a hung engine is an inconclusive run, never a pass.
 */
export function openEngine({ name, command, args, cwd, env = {}, deadlineMs = 300000 }) {
  const { GITHUB_ACTIONS: _hosted, ...inherited } = process.env;
  const child = spawnTracked(command, args, { cwd, env: { ...inherited, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  let exited = null;
  const failAll = (reason) => {
    for (const [, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  // A line can be tens of megabytes (an `end` answer): the chunks of a line are kept in a list and only each new
  // chunk is searched for its end, so a long line costs its length once, not its length times its chunks.
  let parts = [];
  child.stdout.on('data', (chunk) => {
    let newline = chunk.indexOf('\n');
    if (newline < 0) { parts.push(chunk); return; }
    let rest = chunk;
    while (newline >= 0) {
      parts.push(rest.slice(0, newline));
      const line = parts.join('');
      parts = [];
      rest = rest.slice(newline + 1);
      newline = rest.indexOf('\n');
      if (!/\S/.test(line)) continue;
      let message;
      try { message = JSON.parse(line); } catch { stderr += `\n[engine wrote a line that is no JSON: ${line.slice(0, 200)}]`; continue; }
      const waiter = message !== null && typeof message === 'object' ? pending.get(message.id) : undefined;
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    if (rest) parts.push(rest);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20000); });
  const done = new Promise((resolve) => {
    child.on('error', (error) => { exited = { code: null, error: error.message }; failAll(`engine ${name} could not start: ${error.message}`); resolve(exited); });
    child.on('close', (code, signal) => { exited = { code, signal }; failAll(`engine ${name} exited (${signal ?? code}) with requests unanswered${stderr ? `: ${stderr.trim().slice(-2000)}` : ''}`); resolve(exited); });
  });
  // A write after the engine died fails with EPIPE: the close handler already failed what was waiting.
  child.stdin.on('error', () => {});
  /**
   * Sends `message`; `what` names it in a deadline's error (the replayer's own
   * words: what it was delivering, which the engine is never told), and
   * `deadlineMs` overrides the engine's deadline for this request.
   */
  const request = (message, { what = message.op, deadlineMs: limit = deadlineMs } = {}) => new Promise((resolve, reject) => {
    if (exited) { reject(new Error(`engine ${name} has exited (${exited.signal ?? exited.code})${stderr ? `: ${stderr.trim().slice(-2000)}` : ''}`)); return; }
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`engine ${name} did not answer ${what} within ${limit} ms`));
    }, limit);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${protocolLine({ ...message, id })}\n`);
  });
  return {
    name,
    request,
    get stderr() { return stderr; },
    async stop() {
      if (!exited) {
        try { await request({ op: 'stop' }, { what: 'stop', deadlineMs: STOP_MS }); } catch { /* already gone, or hung: killed below */ }
        child.stdin.end();
        const timer = setTimeout(() => { killGroup(child); }, STOP_MS);
        await done;
        clearTimeout(timer);
      }
      return exited;
    },
    kill() { killGroup(child); },
  };
}
