// Planted recorder bugs (design file 30 §4.7 style, for the recorder itself):
// each is built in the run root by exact anchored replacements in a copy of
// this folder (every anchor must occur exactly once) and must be reported by
// its own named check: a check of checks.mjs over the corpora it names
// (`toy`, `fixtures`, `refused`) for a planted recorder, a tool check on
// fixed inputs for a planted tool. `unchanged` is a copy without a
// replacement that must pass every check, so a broken copy cannot pass for a
// caught bug. The list holds the first build's six, the first review's 26
// (P01-P26), those that pin the fix round's changes, the second review's
// eleven that the self-test missed (N02 ... N21) and those that pin the
// second fix round's. A mutant may change a second file (`also`).
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const R = 'recorder.mjs';
const T = 'trace.mjs';
const recorder = (name, check, replacements, corpora = ['toy']) => ({ name, kind: 'recorder', check, file: R, replacements, corpora });
const tool = (name, check, file, replacements) => ({ name, kind: 'tool', check, file, replacements });
const ADVANCE = 'advance(inst.case, setAt + effectiveDelay(delay))';

export const MUTANTS = Object.freeze([
  { name: 'unchanged', kind: 'recorder', replacements: [], check: null, corpora: ['toy', 'fixtures', 'refused'] },
  // The first build's.
  recorder('option-call-unrecorded', 'option-calls', [["    output(inst, 'port', fields);", "    if (name !== 'publishEvent') output(inst, 'port', fields);"]]),
  recorder('settlement-under-latest-call', 'settlement-call', [["output(inst, 'settle', { call, outcome: 'resolve'", "output(inst, 'settle', { call: inst.calls, outcome: 'resolve'"]]),
  recorder('hidden-draw-unrecorded', 'hidden-draws', [["  input(inst, 'draw', { site, source: 'hidden', value: slot(inst, value, 'in') });\n", '']]),
  recorder('late-effect-to-next-test', 'late-owner', [['  inst.events.push(entry);', [
    '  (record.closed ? ghostOf(inst) : inst).events.push(entry);',
    '}',
    'function ghostOf(inst) {',
    '  let ghost = current.constructions.find((entry) => entry.ghostOf === inst);',
    '  if (!ghost) { ghost = { n: current.constructions.length + 1, ghostOf: inst, events: [], defaulted: [] }; current.constructions.push(ghost); }',
    '  return ghost;',
  ].join('\n')]]),
  tool('zero-constructions-pass', 'zero-recording', T, [['    if (built === 0) incomplete.push(', '    if (false) incomplete.push('], ['  else if (outcomes.recorded === 0) incomplete.push(', '  else if (false) incomplete.push(']]),
  tool('unstable-case-unreported', 'stability', T, [['    if (left.line !== right.line) unstable.push(', '    if (false) unstable.push(']]),
  // The first review's (O0a-review.md, "Planted bugs"), re-planted on this recorder.
  recorder('P01-persistence-option-unwrapped', 'option-calls', [['  if (holdsFunctions(value)) return portObject(inst, key, value);\n  return value;', "  if (holdsFunctions(value) && key !== 'persistence') return portObject(inst, key, value);\n  return value;"]]),
  recorder('P02-member-copy-unwrapped', 'identity', [["      if (typeof value !== 'function' || typeof key !== 'string') return value;", "      if (typeof value !== 'function' || typeof key !== 'string' || key === 'copy') return value;"]]),
  recorder('P03-control-markAccepted-unwrapped', 'option-calls', [["      if (typeof value !== 'function' || typeof key !== 'string' || key === 'constructor') return value;", "      if (typeof value !== 'function' || typeof key !== 'string' || key === 'constructor' || key === 'markAccepted') return value;"]]),
  recorder('P04-resolve-under-previous-port', 'golden-events', [["input(inst, 'answer', { port, outcome: 'resolve'", "input(inst, 'answer', { port: Math.max(1, port - 1), outcome: 'resolve'"]]),
  recorder('P05-call-after-its-return', 'golden-events', [["          input(inst, 'call', { call, member: key, args: slot(inst, handed, 'in') });\n          return deliver(inst, call, () => apply(value, object, handed), key);",
    "          const swapped = slot(inst, handed, 'in'); let result; try { result = deliver(inst, call, () => apply(value, object, handed), key); } finally { input(inst, 'call', { call, member: key, args: swapped }); }\n          return result;"]]),
  recorder('P06-undefined-reads-dropped', 'golden-events', [["        if (!isImplicitKey(key)) input(inst, 'read', { object: name, key: keyField(inst, key), value: slot(inst, value, 'in') });", "        if (!isImplicitKey(key) && value !== undefined) input(inst, 'read', { object: name, key: keyField(inst, key), value: slot(inst, value, 'in') });"]]),
  recorder('P07-option-draws-unrecorded', 'golden-events', [["      input(inst, 'draw', { site: key, source: 'option', value: slot(inst, result, 'in') });\n", '']]),
  recorder('P08-default-draws-unrecorded', 'served-values', [["      input(inst, 'draw', { site, source: 'default', value: slot(inst, value, 'in') });\n", '']]),
  recorder('P09-clock-twice-the-delay', 'recorder-clock', [[ADVANCE, 'advance(inst.case, setAt + 2 * effectiveDelay(delay))']]),
  recorder('P10-timer-advances-the-running-case', 'recorder-clock', [[ADVANCE, 'advance(current, setAt + effectiveDelay(delay))']]),
  recorder('P11-late-mark-dropped', 'late-owner', [['  if (record.closed) entry.late = true;\n', '']]),
  recorder('P12-after-write-dropped-silently', 'fixtures', [['    unplaced += 1;\n    lateCases.add(keyOf(record));\n', '']], ['fixtures']),
  { name: 'P13-codec-drops-error-code', kind: 'recorder', check: 'identity', file: '../client-conformance/codec.mjs', corpora: ['toy'], replacements: [["        ...members(item, { skip: (key) => ERROR_POSITION_KEYS.has(key) || key === 'message' || key === 'cause' }),", "        ...members(item, { skip: (key) => ERROR_POSITION_KEYS.has(key) || key === 'message' || key === 'cause' || key === 'code' }),"]] },
  recorder('P14-identity-scope-per-slot', 'identity', [['    snap = snapshot(value, record.codec);', '    snap = snapshot(value, createCodecContext({ names: portNames, unwrap: (item) => apply(WeakMapGet, rawOf, [item]) }));']]),
  recorder('P15-module-digest-of-the-path', 'provenance', [['sha(readFileSync(file))]));', 'sha(file)]));']]),
  recorder('P16-during-never-set', 'golden-events', [['  const during = inst.portStack.length ? inst.portStack[inst.portStack.length - 1] : undefined;', '  const during = undefined;']]),
  recorder('P17-concurrent-never-flagged', 'fixtures', [["  if (overlap) current.flags.add('concurrent');\n  closeCase(current);", '  closeCase(current);'], ["  if (overlap) current.flags.add('concurrent');\n}, CASE_TIMEOUT_MS);", '}, CASE_TIMEOUT_MS);'], ["  if (openTests > 0) current.flags.add('concurrent');", '']], ['fixtures']),
  recorder('P18-unnamed-product-line-no-error', 'refused', [['    noteError(`a ${kind} read at ${relative(frame.file)}:${frame.line} has no site in the target spec`);\n', '']], ['refused']),
  recorder('P19-date-now-left-real', 'recorder-clock', [['  RealDate.now = function now() {', '  RealDate.nominalNow = function now() {']]),
  recorder('P20-timer-clear-loses-its-id', 'golden-events', [["    if (isObjectHandle(handle)) output(inst, 'timer.clear', { timer: apply(WeakMapGet, ids, [handle]) ?? null });", "    if (isObjectHandle(handle)) output(inst, 'timer.clear', { timer: null });"]]),
  tool('P21-recorder-errors-not-surfaced', 'recorder-errors', T, [['    for (const error of raw.errors) incomplete.push(', '    for (const error of []) incomplete.push(']]),
  tool('P22-test-count-not-compared', 'test-count', T, [['    if (ran.length !== tests.length) {', '    if (false) {']]),
  tool('P23-plain-difference-exits-2', 'plain-difference', 'record.mjs', [['  const code = differences.length ? EXIT.fail :', '  const code = false ? EXIT.fail :']]),
  tool('P24-canonical-line-check-removed', 'canonical-lines', T, [['    if (JSON.stringify(parsed) !== line) throw', '    if (false) throw']]),
  recorder('P25-performance-read-unrecorded', 'performance', [["        input(inst, 'clock', { source: 'performance', site, value: slot(inst, value, 'in') });\n", '']]),
  recorder('P26-abort-input-unrecorded', 'abort', [["      if (dir === 'in') input(inst, 'abort', { signal: number, reason: slot(inst, reason, 'in') });", "      if (dir === 'in') void reason;"]]),
  // The fix round's.
  recorder('scheduler-abort-unrecorded', 'scheduler-abort', [["      else output(inst, 'abort', { signal: number, reason: slot(inst, reason, 'out') });", '      else void reason;']]),
  recorder('signal-numbers-dropped', 'scheduler-abort', [['  if (signals && dir) ref.signals =', '  if (false) ref.signals =']]),
  recorder('default-persistence-not-supplied', 'default-persistence', [["  if (TARGET.defaultPersistence) supplied.set('persistence',", "  if (false) supplied.set('persistence',"]]),
  recorder('options-copied-at-construction', 'lazy-options', [['      let value = reflectGet(options, key, options);', '      let value = reflectGet(inst.frozen ??= { ...options }, key, inst.frozen);']]),
  recorder('port-in-unrecorded', 'golden-events', [["      if (!isImplicitKey(key)) input(inst, 'read', { object: name, op: 'has', key: keyField(inst, key), value: slot(inst, found, 'in') });", '      void found;']]),
  recorder('unwrapped-function-unflagged', 'fixtures', [["    if (typeof item === 'function') { record.flags.add(flag); mark(record, ref.slot, 'unwrapped'); continue; }", "    if (typeof item === 'function') continue;"]], ['fixtures']),
  recorder('mutation-after-crossing-unchecked', 'fixtures', [['      if (contentText(again) !== contentText(record.snaps[record.checked])) record.changed.push(record.checked);', '      if (false) record.changed.push(record.checked);']], ['fixtures']),
  recorder('tail-call-read-unflagged', 'refused', [['      noteError(`a ${kind} read by product code whose frame is gone (a tail call) has no site in the target spec (frames ${where(frames.slice(outside))})`);\n', '']], ['refused']),
  recorder('listener-read-unflagged', 'refused', [["  noteError(`a ${kind} read in product code outside any construction's chain", "  if (false) noteError(`a ${kind} read in product code outside any construction's chain"]], ['refused']),
  recorder('new-date-left-real', 'recorder-clock', [['  globalThis.Date = NominalDate;', '  void NominalDate;']]),
  recorder('spin-never-stopped', 'refused', [['    if (spin.count >= SPIN_LIMIT) {', '    if (false) {']], ['refused']),
  recorder('ledger-digest-dropped', 'ledger-digest', [['    if (LEDGER && name === TARGET.savedState.port) fields.ledger =', '    if (false) fields.ledger =']]),
  tool('provenance-never-differs', 'provenance', T, [["  return found.length ? found.join('; ') : null;\n}", '  return null;\n}']]),
  tool('raw-version-unchecked', 'raw-version', T, [['raw.version !== RAW_VERSION) return', 'false) return']]),
  tool('unreadable-raw-crashes', 'unreadable-raw', T, [['    } catch (error) {\n      return { name, unreadable: `not JSON (${error.message})` };\n    }', '    } finally { /* planted: no guard */ }']]),
  // The second review's (O0a-review-2.md, "Planted bugs, round 2"), those it found missed, re-planted on this recorder.
  recorder('N02-every-signal-numbered-1', 'signal-numbers', [['  number = inst.signals.size + 1;', '  number = 1;']]),
  recorder('N05-default-persistence-load-undefined', 'default-persistence', [['const defaultPersistence = () => ({ async load() { return null; }, async save() {} });', 'const defaultPersistence = () => ({ async load() {}, async save() {} });']]),
  recorder('N06-options-has-answers-supplied', 'lazy-options', [["      const found = reflectHas(options, key);\n      if (!isImplicitKey(key)) input(inst, 'read', { object: 'options'", "      const found = reflectHas(options, key) || supplied.has(key);\n      if (!isImplicitKey(key)) input(inst, 'read', { object: 'options'"]]),
  recorder('N08-out-values-never-rechecked', 'receiver-mutation', [["  record.crossed.push(value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null);", "  record.crossed.push(dir === 'in' && value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null);"]]),
  { name: 'N10-codec-left-out-of-the-recorder-digest', kind: 'recorder', check: 'recorder-digest', file: R, corpora: ['toy'],
    replacements: [["const RECORDER = sha([path.join(HERE, 'recorder.mjs'), path.join(HERE, 'trace.mjs'), path.join(HERE, '../client-conformance/codec.mjs'), ", "const RECORDER = sha([path.join(HERE, 'recorder.mjs'), path.join(HERE, 'trace.mjs'), "]],
    also: { file: T, replacements: [["  return sha256([path.join(harnessDir, 'recorder.mjs'), path.join(harnessDir, 'trace.mjs'), path.join(harnessDir, '../client-conformance/codec.mjs'), ", "  return sha256([path.join(harnessDir, 'recorder.mjs'), path.join(harnessDir, 'trace.mjs'), "]] } },
  { name: 'N11-spin-limit-1000', kind: 'recorder', check: 'refused', file: T, corpora: ['refused'], replacements: [['export const SPIN_LIMIT = 1_000_000;', 'export const SPIN_LIMIT = 1_000;']] },
  recorder('N13-date-call-left-real', 'recorder-clock', [['    apply() { return new RealDate(RealDate.now()).toString(); },', '    apply() { return RealDate(); },']]),
  recorder('N14-env-listener-read-unflagged', 'refused', [["if (site) input(inst, 'env', { site, name: key, value: slot(inst, value, 'in') }); } else unownedRead('env');", "if (site) input(inst, 'env', { site, name: key, value: slot(inst, value, 'in') }); }"]], ['refused']),
  recorder('N17-class-instance-with-functions-unflagged', 'fixtures', [["    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item) && holdsFunctions(item)) { record.flags.add(flag); mark(record, ref.slot, 'unwrapped'); }\n", '']], ['fixtures']),
  recorder('N18-ambiguous-clear-dropped', 'ambiguous-clear', [['live.length > 1 ? { timer: live[live.length - 1], ambiguous: [...live] } : { timer: live[0] ?? null }', '{ timer: live[live.length - 1] ?? null }']]),
  recorder('N21-listener-rule-only-in-test-cases', 'refused', [['  const frames = stackFrames();\n  const at = frames.findIndex', "  if (current.kind !== 'test') return;\n  const frames = stackFrames();\n  const at = frames.findIndex"]], ['refused']),
  // The second fix round's.
  recorder('listener-exempt-without-a-scheduler', 'refused', [['  const frames = stackFrames();\n  const at = frames.findIndex', '  if (current.constructions.length === 0) return;\n  const frames = stackFrames();\n  const at = frames.findIndex']], ['refused']),
  recorder('direct-helper-exempt-for-any-caller', 'refused', [['  if (DIRECT.has(`${frames[at].file}:${frames[at].line}`) && caller && !PRODUCT_FILES.has(caller.file)) return;', '  if (DIRECT.has(`${frames[at].file}:${frames[at].line}`)) return;']], ['refused']),
  recorder('direct-helper-never-exempt', 'refused', [['  if (DIRECT.has(`${frames[at].file}:${frames[at].line}`) && caller && !PRODUCT_FILES.has(caller.file)) return;', '  void caller;']], ['refused']),
  recorder('late-error-dropped', 'refused', [['  lateErrors.push(message);\n  writeUnplaced();', '  void message;']], ['refused']),
  recorder('out-mutation-always-a-note', 'fixtures', [["    if (!again) for (const item of record.snaps[index].nodes.keys())", '    if (false) for (const item of record.snaps[index].nodes.keys())']], ['fixtures']),
  recorder('every-mutation-a-note', 'fixtures', [["    let again = record.dirs[index] !== 'out';", '    let again = false;'], ["    if (!again) for (const item of record.snaps[index].nodes.keys())", '    if (false) for (const item of record.snaps[index].nodes.keys())']], ['fixtures']),
  recorder('null-option-not-supplied', 'null-options', [['      if ((value === undefined || value === null) && typeof key === \'string\' && supplied.has(key)) {', '      if (value === undefined && typeof key === \'string\' && supplied.has(key)) {']]),
  recorder('abort-written-at-dispatch', 'scheduler-abort', [['    for (const write of writers) write(reason);\n', '']]),
  recorder('signal-path-depth-8', 'signal-numbers', [['  const walk = (item, trail) => {\n    if (item === target) return trail;', '  const walk = (item, trail) => {\n    if (item === target) return trail;\n    if (trail.length > 8) return null;']]),
  recorder('own-read-unrecorded', 'lazy-options', [["      if (!isImplicitKey(key)) input(inst, 'read', { object: name, op: 'own', key: keyField(inst, key), ...ownFields(inst, out) });", '      void ownFields;']]),
  tool('allowance-allows-every-case', 'allowance', 'record.mjs', [['    if (!entry.case || !reasons.has(entry.case)) return true;', '    if (!entry.case) return true;']]),
  tool('allowance-unused-ignored', 'allowance', 'record.mjs', [["  for (const entry of allow) if (!used.has(entry.case)) open.push(", '  for (const entry of []) if (!used.has(entry.case)) open.push(']]),
  tool('notes-dropped-by-the-reader', 'case-notes', T, [['      const notes = [...(entry.notes ?? [])].sort(compare);', '      const notes = [];']]),
]);

/**
 * A copy of this folder at `<runDir>/<name>/scripts/scheduler-conformance`
 * with the mutant's replacements, beside links to the shared folders it
 * imports (a copy of the client harness when a replacement is in it).
 * Returns the copy's directory (canonical).
 */
export function buildMutant({ harnessDir, runDir, mutant }) {
  const scripts = path.join(runDir, mutant.name, 'scripts');
  const copy = path.join(scripts, 'scheduler-conformance');
  mkdirSync(scripts, { recursive: true });
  cpSync(harnessDir, copy, { recursive: true });
  const ownClient = mutant.file?.startsWith('../client-conformance/');
  for (const shared of ['client-conformance', 'qa', 'test-runner-utils.mjs']) {
    const target = path.join(harnessDir, '..', shared);
    if (!existsSync(target)) continue;
    if (shared === 'client-conformance' && ownClient) cpSync(target, path.join(scripts, shared), { recursive: true });
    else symlinkSync(target, path.join(scripts, shared));
  }
  for (const edit of mutant.file ? [{ file: mutant.file, replacements: mutant.replacements }, ...(mutant.also ? [mutant.also] : [])] : []) {
    const file = path.join(copy, edit.file);
    let text = readFileSync(file, 'utf8');
    for (const [anchor, replacement] of edit.replacements) {
      const hits = text.split(anchor).length - 1;
      if (hits !== 1) throw new Error(`mutant ${mutant.name}: anchor occurs ${hits} times in ${edit.file}: ${anchor}`);
      text = text.replace(anchor, () => replacement);
    }
    writeFileSync(file, text);
  }
  return realpathSync(copy);
}

const modulesOf = async (copy) => ({
  trace: await import(pathToFileURL(path.join(copy, 'trace.mjs')).href),
  record: await import(pathToFileURL(path.join(copy, 'record.mjs')).href),
});
const EMPTY_FILE = 'scripts/scheduler-conformance/toy/toy-empty.toy.mjs';
const rawOf = (fields = {}) => ({ version: 1, file: EMPTY_FILE, codec: 3, recording: 3, recorder: 'sha256:0', modules: {}, target: 'toy', clock: 'nominal', bun: '0', cases: [{ kind: 'test', ordinal: 1, flags: [], constructions: [{ n: 1, defaulted: [], events: [] }] }], values: {}, errors: [], unplaced: 0, lateCases: [], ...fields });
const testOf = (name, status = 'passed', line = 5) => ({ file: EMPTY_FILE, line, describe: [], name, status, assertions: 1 });
const recordingOf = (trace, raws, junit, run = 1) => ({ run, status: 0, junit, ...trace.buildContainers({ raws, junit, root: '/', expectedFiles: [EMPTY_FILE] }) });

/**
 * Tool checks on fixed inputs, run against a copy's own modules. Each
 * returns null when it holds. `containers` are a toy recording's, `scratch`
 * a directory the check may write into.
 */
export const TOOL_CHECKS = Object.freeze({
  /** A recording in which a named file built no scheduler is inconclusive (exit 2), never complete. */
  async 'zero-recording'(copy) {
    const { trace, record } = await modulesOf(copy);
    const junit = [testOf('builds no scheduler')];
    const raw = rawOf({ cases: [{ kind: 'test', ordinal: 1, flags: [], constructions: [] }] });
    const { code } = record.judgeRecording({ plain: { status: 0, junit }, recordings: [recordingOf(trace, [raw], junit, 1), recordingOf(trace, [raw], junit, 2)] });
    return code === trace.EXIT.inconclusive ? null : `a recording whose one file built no scheduler exits ${code}`;
  },
  /** Two recordings whose case lines differ name the case unstable (exit 2). */
  async stability(copy, { containers }) {
    const { trace, record } = await modulesOf(copy);
    const changed = containers.map((container, index) => (index > 0 ? container : { ...container, text: container.text.replace('"flags":[]', '"flags":["planted"]') }));
    const first = trace.readContainer(containers[0].text).cases.find((entry) => entry.flags.length === 0)?.id;
    const recording = (run, list) => ({ run, status: 0, junit: [], containers: list, incomplete: [], outcomes: {} });
    const judged = record.judgeRecording({ plain: { status: 0, junit: [] }, recordings: [recording(1, containers), recording(2, changed)] });
    if (judged.code !== trace.EXIT.inconclusive) return `two recordings that differ in one case exit ${judged.code}`;
    return judged.unstable.some((entry) => entry.case === first) ? null : `the unstable case is not named (${judged.unstable.map((entry) => entry.case).join(', ') || 'none'})`;
  },
  /** A recorder error in a raw is reported (exit 2), with its text. */
  async 'recorder-errors'(copy) {
    const { trace, record } = await modulesOf(copy);
    const junit = [testOf('one')];
    const raw = rawOf({ errors: ['a planted recorder error'] });
    const recordings = [recordingOf(trace, [raw], junit, 1), recordingOf(trace, [raw], junit, 2)];
    const judged = record.judgeRecording({ plain: { status: 0, junit }, recordings });
    if (!judged.incomplete.some((entry) => entry.check === 'recorder-error' && entry.detail.includes('a planted recorder error'))) return `the recorder error is not reported (${judged.incomplete.map((entry) => entry.check).join(', ') || 'nothing'})`;
    return judged.code === trace.EXIT.inconclusive ? null : `a recording with a recorder error exits ${judged.code}`;
  },
  /** Another number of tests than junit lists is reported (exit 2). */
  async 'test-count'(copy) {
    const { trace, record } = await modulesOf(copy);
    const junit = [testOf('one', 'passed', 5), testOf('two', 'passed', 6)];
    const raw = rawOf();
    const judged = record.judgeRecording({ plain: { status: 0, junit }, recordings: [recordingOf(trace, [raw], junit, 1), recordingOf(trace, [raw], junit, 2)] });
    if (!judged.incomplete.some((entry) => entry.check === 'count')) return `two junit tests and one recorded case are not reported (${judged.incomplete.map((entry) => entry.check).join(', ') || 'nothing'})`;
    return judged.code === trace.EXIT.inconclusive ? null : `the count mismatch exits ${judged.code}`;
  },
  /** A test that passes plainly and fails under the recorder is a failure (exit 1), named. */
  async 'plain-difference'(copy) {
    const { trace, record } = await modulesOf(copy);
    const plain = [testOf('one')];
    const recorded = [testOf('one', 'failed')];
    const raw = rawOf();
    const judged = record.judgeRecording({ plain: { status: 0, junit: plain }, recordings: [recordingOf(trace, [raw], recorded, 1), recordingOf(trace, [raw], recorded, 2)] });
    if (!judged.differences.length) return 'the plain/recorded difference is not reported';
    return judged.code === trace.EXIT.fail ? null : `a plain/recorded difference exits ${judged.code}`;
  },
  /** A container line that is not canonical JSON is refused. */
  async 'canonical-lines'(copy, { containers }) {
    const { trace } = await modulesOf(copy);
    const [head, ...rest] = containers[0].text.split('\n');
    const spaced = [head.replace('{"format":', '{"format": '), ...rest].join('\n');
    try { trace.readContainer(spaced); } catch { return null; }
    return 'a header line with a space after a colon was read';
  },
  /** A raw another raw version wrote is reported unreadable (exit 2), never read. */
  async 'raw-version'(copy, { scratch }) {
    const { trace } = await modulesOf(copy);
    const directory = path.join(scratch, 'raw-version');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'x.raw.json'), JSON.stringify(rawOf({ version: 99 })));
    const raws = trace.readRaws(directory);
    const built = trace.buildContainers({ raws, junit: [testOf('one')], root: '/', expectedFiles: [EMPTY_FILE] });
    return built.incomplete.some((entry) => entry.check === 'unreadable-raw') ? null : `a raw of version 99 was read (${built.incomplete.map((entry) => entry.check).join(', ') || 'nothing reported'})`;
  },
  /** A truncated raw is reported unreadable, naming the file, instead of crashing the tool. */
  async 'unreadable-raw'(copy, { scratch }) {
    const { trace } = await modulesOf(copy);
    const directory = path.join(scratch, 'unreadable-raw');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'x.raw.json'), JSON.stringify(rawOf()).slice(0, 40));
    let built;
    try { built = trace.buildContainers({ raws: trace.readRaws(directory), junit: [testOf('one')], root: '/', expectedFiles: [EMPTY_FILE] }); } catch (error) { return `a truncated raw crashes the reader: ${error.message}`; }
    return built.incomplete.some((entry) => entry.check === 'unreadable-raw' && entry.file === 'x.raw.json') ? null : 'a truncated raw is not reported by name';
  },
  /** A named case's problem is allowed with its reason (exit 0, printed allowed); without the allowance it is inconclusive; an allowance that names nothing is itself inconclusive. */
  async allowance(copy) {
    const { trace, record } = await modulesOf(copy);
    const junit = [testOf('one', 'passed', 5), testOf('two', 'passed', 6)];
    const raw = rawOf({ cases: [1, 2].map((ordinal) => ({ kind: 'test', ordinal, flags: ordinal === 1 ? ['mutated-after-crossing'] : [], constructions: [{ n: 1, defaulted: [], events: [] }] })) });
    const recordings = [recordingOf(trace, [raw], junit, 1), recordingOf(trace, [raw], junit, 2)];
    const id = recordings[0].incomplete.find((entry) => entry.check === 'unrecordable')?.case;
    if (!id) return 'the planted unrecordable case is not reported';
    const plain = { status: 0, junit };
    const bare = record.judgeRecording({ plain, recordings });
    if (bare.code !== trace.EXIT.inconclusive) return `an unrecordable case without an allowance exits ${bare.code}`;
    const allowed = record.judgeRecording({ plain, recordings, allow: [{ case: id, reason: 'a planted reason' }] });
    if (allowed.code !== trace.EXIT.pass || !allowed.allowed.some((entry) => entry.case === id && entry.reason === 'a planted reason') || allowed.outcomes.allowed !== 1) return `an allowed case exits ${allowed.code} (allowed ${JSON.stringify(allowed.allowed.map((entry) => entry.case))})`;
    // Beside the real allowance, one that names no case: the run is no longer complete.
    const stale = record.judgeRecording({ plain, recordings, allow: [{ case: id, reason: 'a planted reason' }, { case: `${id} (another)`, reason: 'names nothing' }] });
    if (stale.code !== trace.EXIT.inconclusive || !stale.incomplete.some((entry) => entry.check === 'allowance-unused')) return `an allowance that names no case leaves the run at exit ${stale.code}`;
    return null;
  },
  /** A case's notes reach its container line and the run's info list; a noted case keeps its outcome. */
  async 'case-notes'(copy) {
    const { trace } = await modulesOf(copy);
    const junit = [testOf('one')];
    const raw = rawOf({ cases: [{ kind: 'test', ordinal: 1, flags: [], notes: ['mutated-by-receiver'], constructions: [{ n: 1, defaulted: [], events: [] }] }] });
    const built = recordingOf(trace, [raw], junit, 1);
    const [line] = trace.readContainer(built.containers[0].text).cases;
    if (JSON.stringify(line.notes) !== '["mutated-by-receiver"]' || line.outcome !== 'recorded') return `the container case has notes ${JSON.stringify(line.notes)}, outcome ${line.outcome}`;
    return built.info.length === 1 && built.info[0].note === 'mutated-by-receiver' ? null : `info ${JSON.stringify(built.info)}`;
  },
  /** checkProvenance holds for a real header and finds a module digest that is not the file's. */
  async provenance(copy, { containers, root, harnessDir }) {
    const { trace } = await modulesOf(copy);
    const { header } = trace.readContainer(containers[0].text);
    const real = trace.checkProvenance(header, { root, harnessDir });
    if (real !== null) return `a real header fails provenance: ${real}`;
    const [file] = Object.keys(header.modules);
    const planted = { ...header, modules: { ...header.modules, [file]: trace.sha256(file) } };
    return trace.checkProvenance(planted, { root, harnessDir }) === null ? 'a module digest that is not the file\'s holds' : null;
  },
});
