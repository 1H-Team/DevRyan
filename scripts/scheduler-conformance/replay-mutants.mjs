// Planted differences for the replayer (design file 30 §4.7, package O0c).
// Two kinds, each an exact anchored replacement (the anchor must occur
// exactly once) in a copy made in the run root, never in the repository:
//
// - in the copy of the scheduler package (COPY_PLANTS): the closure check,
//   JavaScript against a copy of itself, must report each as `different` by
//   its own named check, showing the first differing event, on the source it
//   names (the scenarios, or a test recording), and the closure judgement of
//   that replay (provenance of the planted module aside) must exit 1; the
//   unchanged copy reproduces every case and its judgement exits 0. Every final
//   check (ledger, mutated, case-bytes) has a plant only it reports, and one
//   plant changes nothing but a timer's delay;
// - in a copy of the replayer itself (REPLAYER_PLANTS, its own folder with
//   the shared codec and the comparer, the package reached through a link): each is reported by
//   its named check, which is a check of the replay (`placement`, `draw`), of
//   the closure judgement (`reproduced-complete`, `crossed-mark`: judgeClosure
//   in closure.mjs, which reads the recording's marks itself), or of this table
//   (`copy-plants`: every copy plant still reported `different` by its own
//   check, and judged exit 1). The three that move where a `settle` input is
//   delivered run against DELIVERY_COPY, which is no difference: the unchanged
//   replayer reproduces every case against it (the delivery control).
//
//   bun scripts/scheduler-conformance/replay-mutants.mjs --scenarios=<container> --tests=<container>,... [--json=<out>]
// replays the scenario container and the test containers against the
// unchanged copy and every copy plant, and runs each replayer plant in its own
// process; one JSON line.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { caseEvents, casePlacement, readContainer } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '../..');

/** `n` microtask hops, then `tail` (a planted effect that lands after a member's settlement, where a test has its next input). */
const hops = (n, tail) => `Promise.resolve()${'.then(() => 0)'.repeat(n)}.then(() => { ${tail} })`;
/** A flush whose settlement comes `n` microtasks later, nothing else changed (the anchor is the end of flush). */
const FLUSH_END = '      await publicationTail;\n    }\n  };';
const flushLater = (n) => ({
  name: `flush-settles-later-${n}`, check: 'order', on: 'tests', cases: ['a flush beside another scheduler\'s initialization'], settled: true,
  purpose: `a flush that settles ${n} microtask${n === 1 ? '' : 's'} later (O0c review 2, B1'): different on a case whose compared prefix holds an input placed in a settlement's continuation (shapes.toy.mjs)`,
  file: 'scheduler.js', anchor: FLUSH_END, with: FLUSH_END.replace('    }\n  };', `    }\n    ${'await null; '.repeat(n)}\n  };`),
});
const SUBMIT_RETURN = '    const committed = uncommittedRead ? committedReadState.tasks.find(row => row.taskId === task.taskId) : tasks.get(task.taskId);\n    return cloneTask(committed ?? task);';

/**
 * Planted differences in the copy of the scheduler: each must be reported `different` by `check` on the source
 * `on` (`scenarios`: the scenarios named; `tests`: any case of the test recordings given, or the cases named by
 * `cases`), `event` (when given) naming the kind of event the first difference is at, `settled` (when set)
 * requiring an input placed `settle` in that case's compared prefix before the difference.
 */
export const COPY_PLANTS = Object.freeze([
  {
    name: 'launch-delayed', check: 'order', on: 'scenarios', scenarios: ['F1-fanout-8', 'submit-complete'],
    purpose: 'a launch delayed by one step (design M1): the pump\'s finally queues each launch in a microtask',
    file: 'scheduler.js', anchor: '&& !cancellationOwners.has(task.taskId)) launchTask(task);', with: '&& !cancellationOwners.has(task.taskId)) queueMicrotask(() => launchTask(task));',
  },
  {
    name: 'save-dropped', check: 'order', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'a save dropped: a transition to starting is committed without its save',
    file: 'scheduler.js', anchor: '    tasks.set(next.taskId, next);\n    try {\n      await persistLocked();', with: '    tasks.set(next.taskId, next);\n    try {\n      if (next.status !== \'starting\') await persistLocked();',
  },
  {
    name: 'launches-swapped', check: 'value', on: 'scenarios', scenarios: ['F1-fanout-8'],
    purpose: 'two port calls swapped: the first two launches of one pump in the other order (design M2)',
    file: 'scheduler.js', anchor: '      for (const task of admitted) {', with: '      for (const task of admitted.length > 1 ? [admitted[1], admitted[0], ...admitted.slice(2)] : admitted) {',
  },
  {
    name: 'timer-delay', check: 'value', on: 'scenarios', scenarios: ['cancel-abort-timeout'],
    purpose: 'a timer set with another delay: the abort race 5,000 ms becomes 5,001 ms (design M5)',
    file: 'scheduler.js', anchor: 'const abortTimeoutMs = options.abortTimeoutMs ?? 5_000;', with: 'const abortTimeoutMs = options.abortTimeoutMs ?? 5_001;',
  },
  {
    name: 'lease-delay-plus1', check: 'value', event: 'out timer.set', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'only a timer delay changes: the starting lease is armed one millisecond later (seen nowhere but in its timer.set)',
    file: 'scheduler.js', anchor: '    }, Math.max(0, dueAt - now())));', with: '    }, Math.max(0, dueAt - now()) + 1));',
  },
  {
    name: 'abort-not-issued', check: 'order', on: 'scenarios', scenarios: ['cancel-abort-timeout'],
    purpose: 'an abort not issued: the cancel race times out without aborting the signal it handed the executor',
    file: 'scheduler.js', anchor: '          () => abortController.abort(new Error(\n            `Managed task abort exceeded ${abortTimeoutMs}ms`,\n          )),', with: '          () => undefined,',
  },
  {
    name: 'return-changed', check: 'value', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'a return value changed: submit settles with one more member on the task',
    file: 'scheduler.js', anchor: '    return cloneTask(committed ?? task);', with: '    return Object.assign(cloneTask(committed ?? task), { planted: true });',
  },
  {
    name: 'extra-port-call', check: 'order', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'an extra port call: every event is published twice',
    file: 'scheduler.js', anchor: '      await publishEvent(event);', with: '      await publishEvent(event); await publishEvent(event);',
  },
  {
    name: 'settlement-order', check: 'order', on: 'scenarios', scenarios: ['F1-fanout-8'],
    purpose: 'a wrong settlement order: the first submit of a group settles after the second (its settlement waits twelve microtasks)',
    file: 'scheduler.js', anchor: '      await pump();\n    } catch {\n      // Launch bookkeeping', with: '      await pump(); if (task.sequence === 1) for (let tick = 0; tick < 12; tick += 1) await null;\n    } catch {\n      // Launch bookkeeping',
  },
  // One per final check: each difference is seen by that check alone (the online comparison passes).
  {
    name: 'saved-state-changed', check: 'ledger', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'a saved state changed after its save resolved: its reference bytes are not what was saved (the ledger check, the first final check)',
    file: 'scheduler.js', anchor: '      committedReadState = state;\n      uncommittedRead = false;\n      outcome = \'committed\';', with: `      committedReadState = state;\n      uncommittedRead = false;\n      outcome = 'committed';\n      void ${hops(6, "if (state.tasks[0]) state.tasks[0].prompt += ' planted';")};`,
  },
  {
    name: 'returned-task-changed', check: 'mutated', on: 'scenarios', scenarios: ['submit-complete'],
    purpose: 'a task handed to the caller changed by the scheduler after its submit settled',
    file: 'scheduler.js', anchor: SUBMIT_RETURN, with: `${SUBMIT_RETURN.replace('    return cloneTask(committed ?? task);', `    const returned = cloneTask(committed ?? task);\n    void ${hops(6, 'returned.planted = true;')};\n    return returned;`)}`,
  },
  {
    name: 'launch-uncloned', check: 'case-bytes', on: 'scenarios', scenarios: ['F8-deferred-launches'],
    purpose: 'aliasing only: the executor gets the admitted object itself, not a clone (one object across events where the recording has two)',
    file: 'scheduler.js', anchor: '        const result = await method(cloneTask(task), control);', with: '        const result = await method(task, control);',
  },
  // The review's escapes (O0c review B1, S2), judged on test recordings as well as scenarios.
  {
    name: 'extra-save-after-submit', check: 'order', on: 'tests',
    purpose: 'one extra save, six microtasks after submit returns',
    file: 'scheduler.js', anchor: SUBMIT_RETURN, with: SUBMIT_RETURN.replace('    return cloneTask', `    void ${hops(6, 'void runExclusive(() => persistLocked()).catch(() => {});')};\n    return cloneTask`),
  },
  {
    name: 'extra-publish-after-submit', check: 'order', on: 'tests',
    purpose: 'one extra publication of the submitted task, six microtasks after submit returns',
    file: 'scheduler.js', anchor: SUBMIT_RETURN, with: SUBMIT_RETURN.replace('    return cloneTask', `    void ${hops(6, 'void publishManagedEvent(toManagedTaskEvent(tasks.get(task.taskId) ?? task, null));')};\n    return cloneTask`),
  },
  {
    name: 'deadline-delay-minus1', check: 'value', event: 'out timer.set', on: 'tests',
    purpose: 'a task deadline timer armed one millisecond early (a timer delay only tests reach)',
    file: 'scheduler.js', anchor: '    const delay = Math.max(0, task.timeoutAt - now());', with: '    const delay = Math.max(0, task.timeoutAt - now() - 1);',
  },
  {
    name: 'recovery-parallel', check: 'order', on: 'scenarios', scenarios: ['F7-restart-recovery'],
    purpose: 'a restart recovers its active tasks in parallel instead of in order',
    file: 'scheduler.js', anchor: '        for (const task of active) await recoverTask(cloneTask(task));', with: '        await Promise.all(active.map((task) => recoverTask(cloneTask(task))));',
  },
  flushLater(1), flushLater(2), flushLater(3),
  {
    name: 'getTask-undefined', check: 'value', on: 'tests', cases: ['awaited directly'],
    purpose: 'getTask of a missing task returns undefined where it returned null (seen in no compared prefix of the corpus once the settle mark was narrowed)',
    file: 'scheduler.js', anchor: '        ?? nativeJobProofs.get(taskId)?.task);\n    },', with: '        ?? nativeJobProofs.get(taskId)?.task) || undefined;\n    },',
  },
  // Three of the reviews' six escapes, reached by cases of shapes.toy.mjs (no scenario reaches them).
  {
    name: 'shutdown-code', check: 'value', on: 'tests', cases: ['initialize after shutdown is refused'],
    purpose: 'an error code changed in initialize after shutdown',
    file: 'scheduler.js', anchor: "    if (shutDown) {\n      return Promise.reject(new ManagedOrchestrationError(\n        'scheduler_shut_down',", with: "    if (shutDown) {\n      return Promise.reject(new ManagedOrchestrationError(\n        'scheduler_shutdown',",
  },
  {
    name: 'publish-warn-text', check: 'value', on: 'tests', cases: ['a publication that fails is logged'],
    purpose: 'the warning a failed publication logs changed',
    file: 'scheduler.js', anchor: "'[ManagedOrchestration] Failed to publish task event'", with: "'[ManagedOrchestration] Failed to publish a task event'",
  },
  {
    name: 'timing-callback-dropped', check: 'order', on: 'tests', cases: ['a mutation that fails reports its timing'],
    purpose: 'onMutationTiming never reported for a failed mutation',
    file: 'scheduler.js', anchor: '          try { void Promise.resolve(options.onMutationTiming(Object.freeze({ waitMs: startedAt - queuedAt, holdMs: performance.now() - startedAt, failed }))).catch(() => {}); }', with: '          try { if (!failed) void Promise.resolve(options.onMutationTiming(Object.freeze({ waitMs: startedAt - queuedAt, holdMs: performance.now() - startedAt, failed }))).catch(() => {}); }',
  },
]);

/**
 * Not a difference: a copy whose flush member changes what getTask answers for one probe (`dvr_task_delivery`,
 * shapes.toy.mjs) in the jobs around its settlement's continuation, silently: `early` from the call until the
 * jobs that run first after the settlement, then `null` (what the unchanged scheduler answers) in the job where the
 * recorded continuation ran, `late-1` one microtask later, `late-2` two later. Only the planted replayers
 * `settle-delivered-*` run against it (O0c review 3, S1): delivered where the recording puts it the probe reads
 * `null`, as recorded; a microtask early or one or two late, another value. The reaction that moves the state is
 * registered a microtask after the call, behind the candidate's observer and the replayer's own reaction.
 */
export const DELIVERY_COPY = Object.freeze([
  { file: 'scheduler.js', anchor: '  const flush = async () => {\n', with: '  let plantedDelivery = null;\n  const flush = async () => {\n' },
  {
    file: 'scheduler.js', anchor: '    flush,\n    getTask(taskId) {\n',
    with: [
      '    flush() {',
      '      const settled = flush();',
      "      plantedDelivery = 'early';",
      "      queueMicrotask(() => { settled.then(() => { plantedDelivery = null; queueMicrotask(() => { plantedDelivery = 'late-1'; queueMicrotask(() => { plantedDelivery = 'late-2'; }); }); }, () => {}); });",
      '      return settled;',
      '    },',
      '    getTask(taskId) {',
      "      if (taskId === 'dvr_task_delivery' && plantedDelivery !== null) return plantedDelivery;",
      '',
    ].join('\n'),
  },
]);
const DELIVERY_CASE = 'awaited, then a call the settlement\'s own continuation makes';
const SETTLE_QUEUE = '    const queue = () => { queueMicrotask(deliver); };';

/**
 * Planted bugs in a copy of the replayer: each must be reported by its named check, on `on` (scenarios or the
 * test recordings). `edits` are the anchored replacements, all in `file`. A `copy-plants` plant is reported when
 * one of the copy plants it `breaks` (run with that replayer) is no longer caught.
 */
export const REPLAYER_PLANTS = Object.freeze([
  {
    name: 'input-delivered-early', check: 'placement', on: 'scenarios',
    purpose: 'an input delivered early: the driving loop no longer drains to quiescence before an input',
    file: 'replay.mjs', edits: [{ anchor: '        await this.drain();\n        if (this.stopped || this.produced.length >= this.limit) break;', with: '        if (this.stopped || this.produced.length >= this.limit) break;' }],
  },
  {
    name: 'output-comparison-skipped', check: 'copy-plants', on: 'scenarios', breaks: ['launches-swapped', 'timer-delay', 'return-changed'],
    purpose: 'an output comparison skipped: values of outputs are no longer compared when they are produced',
    file: 'replay.mjs', edits: [{ anchor: '      if (shapeText(tree) !== shapeText(recorded)) {', with: '      if (entry.dir !== \'out\' && shapeText(tree) !== shapeText(recorded)) {' }],
  },
  {
    name: 'partial-counted-reproduced', check: 'crossed-mark', on: 'tests',
    purpose: 'a case compared only up to its first busy input reported as a reproduction of the whole case',
    file: 'replay.mjs', edits: [{ anchor: "    if (result.outcome === 'partial') return { ...base, ...result, busy: busyText,", with: "    if (result.outcome === 'partial') return { ...base, ...result, outcome: 'reproduced', busy: busyText," }],
  },
  {
    name: 'busy-delivered-at-rest', check: 'crossed-mark', on: 'tests',
    purpose: 'busy marks ignored: every input is delivered at quiescence and every case compared whole (a candidate deciding its own classification)',
    file: 'replay.mjs', edits: [{ anchor: '  const { limit, busy } = casePlacement(record, expected);', with: '  const { busy } = casePlacement(record, expected); const limit = expected.length; for (const event of expected) if (event.place === \'busy\') event.place = \'rest\';' }],
  },
  {
    name: 'prefix-accepted', check: 'event-count', on: 'tests',
    purpose: 'a case cut before its last member call in the replayer: a prefix judged as the whole case (the judgement counts the recording\'s events itself)',
    file: 'replay.mjs', edits: [{ anchor: '  const expected = caseEvents(record);\n  base.events = expected.length;', with: '  const expected = caseEvents(record);\n  { const cut = expected.findLastIndex((event) => event.dir === \'in\' && event.kind === \'call\' && event.call > 0); if (cut > 0) { expected.length = cut; record = { ...record, constructions: record.constructions.map((construction) => ({ ...construction, events: construction.events.filter((event) => event.at <= cut) })) }; } }\n  base.events = expected.length;' }],
  },
  {
    name: 'draw-wrong-site', check: 'draw', on: 'scenarios',
    purpose: 'a draw served from the wrong site: hidden draws of persistLocked served from createTaskId\'s queue',
    file: 'replay.mjs', edits: [{ anchor: '        const queue = this.draws.get(`${construction}:${fields.site}`);', with: '        const queue = this.draws.get(`${construction}:${fields.site === \'persistLocked\' ? \'createTaskId\' : fields.site}`) ?? this.draws.get(`${construction}:${fields.site}`);' }],
  },
  // The second review's (S4): the `return` delivery, which no case told apart before shapes.toy.mjs.
  {
    name: 'return-delivered-at-rest', check: 'order', on: 'tests',
    purpose: 'a port\'s already-settled promise settled at quiescence instead of at the port\'s return (two schedulers initializing at once then run one after the other)',
    file: 'replay.mjs', edits: [
      { anchor: '      if (want.settled && settled !== undefined && this.expected[settled].outcome === want.settled) {', with: '      if (false) {' },
      { anchor: "        if (want.place !== 'rest') {", with: "        if (want.place !== 'rest' && want.place !== 'return') {" },
    ],
  },
  {
    name: 'value-diff-as-unrecordable', check: 'unrecordable-mark', on: 'tests', copy: 'deadline-delay-minus1',
    purpose: 'an output value difference reported unrecordable with a reason (S3: the judgement accepted it, and the corpus exited 0)',
    file: 'replay.mjs', edits: [{ anchor: "        this.stop({ outcome: 'different', check: entry.kind === 'draw' ? 'draw' : 'value',", with: "        this.stop({ outcome: entry.dir === 'out' ? 'unrecordable' : 'different', reason: 'planted', check: entry.kind === 'draw' ? 'draw' : 'value'," }],
  },
  // The review's replayer plants (O0c review B1, S2), each of which passed its self-test then.
  {
    name: 'value-diff-as-crossed', check: 'copy-plants', on: 'scenarios', breaks: ['launches-swapped', 'lease-delay-plus1', 'deadline-delay-minus1'],
    purpose: 'an output value difference reported crossed, its check name kept',
    file: 'replay.mjs', edits: [{ anchor: "        this.stop({ outcome: 'different', check: entry.kind === 'draw' ? 'draw' : 'value',", with: "        this.stop({ outcome: entry.dir === 'out' ? 'crossed' : 'different', check: entry.kind === 'draw' ? 'draw' : 'value'," }],
  },
  {
    name: 'ledger-check-skipped', check: 'copy-plants', on: 'scenarios', breaks: ['saved-state-changed'],
    purpose: 'the save digest check skipped',
    file: 'replay.mjs', edits: [{ anchor: '      if (!entry.ledger) continue;', with: '      continue;' }],
  },
  {
    name: 'mutated-check-skipped', check: 'copy-plants', on: 'scenarios', breaks: ['returned-task-changed'],
    purpose: 'the check that objects still hold what they held when they crossed skipped',
    file: 'replay.mjs', edits: [{ anchor: '      if (contentText(again) === contentText(this.snaps[slot])) continue;', with: '      continue;' }],
  },
  {
    name: 'case-bytes-skipped', check: 'copy-plants', on: 'scenarios', breaks: ['launch-uncloned'],
    purpose: 'the identity comparison of the case\'s values skipped',
    file: 'replay.mjs', edits: [{ anchor: '    const trees = emitSlots(this.snaps);', with: '    return null;' }],
  },
  {
    name: 'timer-set-skipped-everywhere', check: 'copy-plants', on: 'scenarios', breaks: ['lease-delay-plus1', 'deadline-delay-minus1'],
    purpose: 'timer.set events compared nowhere (online and in the identity pass)',
    file: 'replay.mjs', edits: [
      { anchor: '    const shown = describe(entry, c);\n    if (!want) this.stop(', with: '    const shown = describe(entry, c);\n    if (entry.kind === \'timer.set\' && want?.kind === \'timer.set\') return;\n    if (!want) this.stop(' },
      { anchor: '    for (const [index, { entry }] of this.produced.entries()) {\n      for (const [key, item] of Object.entries(entry)) {\n        if (!isRef(item)) continue;\n        produced.push(', with: '    for (const [index, { entry }] of this.produced.entries()) {\n      if (entry.kind === \'timer.set\') continue;\n      for (const [key, item] of Object.entries(entry)) {\n        if (!isRef(item)) continue;\n        produced.push(' },
    ],
  },
  // The third review's (S1): where a `settle` input is delivered, told apart only against the delivery copy.
  {
    name: 'settle-delivered-early', check: 'value', on: 'tests', against: 'delivery', cases: [DELIVERY_CASE],
    purpose: 'an input placed in a settlement\'s continuation delivered one microtask early (in the replayer\'s own reaction)',
    file: 'replay.mjs', edits: [{ anchor: SETTLE_QUEUE, with: '    const queue = () => { deliver(); };' }],
  },
  {
    name: 'settle-delivered-late-1', check: 'value', on: 'tests', against: 'delivery', cases: [DELIVERY_CASE],
    purpose: 'an input placed in a settlement\'s continuation delivered one microtask late',
    file: 'replay.mjs', edits: [{ anchor: SETTLE_QUEUE, with: '    const queue = () => { queueMicrotask(() => queueMicrotask(deliver)); };' }],
  },
  {
    name: 'settle-delivered-late-2', check: 'value', on: 'tests', against: 'delivery', cases: [DELIVERY_CASE],
    purpose: 'an input placed in a settlement\'s continuation delivered two microtasks late',
    file: 'replay.mjs', edits: [{ anchor: SETTLE_QUEUE, with: '    const queue = () => { queueMicrotask(() => queueMicrotask(() => queueMicrotask(deliver))); };' }],
  },
]);

const replaceOnce = (text, plant) => (plant.edits ?? [plant]).reduce((current, edit) => {
  const hits = current.split(edit.anchor).length - 1;
  if (hits !== 1) throw new Error(`replay plant ${plant.name}: its anchor occurs ${hits} times in ${plant.file}`);
  return current.replace(edit.anchor, () => edit.with);
}, text);

/**
 * A copy of the replayer with one plant (or none): this folder's replay
 * modules and the shared codec, at their repository-relative paths, with the
 * repository's packages reached through a link (the reference ledger encoder
 * and the package the copies are made from). Returns the copied replay.mjs.
 */
export function plantedReplayer(root, plant = null) {
  const harness = path.join(root, 'scripts/scheduler-conformance');
  mkdirSync(harness, { recursive: true });
  for (const file of ['replay.mjs', 'replay-values.mjs', 'candidate.mjs', 'compare.mjs', 'trace.mjs', 'target.json']) cpSync(path.join(HERE, file), path.join(harness, file));
  cpSync(path.join(REPOSITORY, 'scripts/client-conformance'), path.join(root, 'scripts/client-conformance'), { recursive: true });
  symlinkSync(path.join(REPOSITORY, 'packages'), path.join(root, 'packages'));
  if (plant) writeFileSync(path.join(harness, plant.file), replaceOnce(readFileSync(path.join(harness, plant.file), 'utf8'), plant));
  return path.join(harness, 'replay.mjs');
}

/** Whether the recorded case `id` of `file` has an input placed `settle` in its compared prefix, before event `at`. */
function settlePlacedBefore(file, id, at) {
  const record = readContainer(readFileSync(file, 'utf8')).cases.find((entry) => entry.id === id);
  if (!record || record.outcome !== 'recorded') return false;
  const list = caseEvents(record);
  const { limit } = casePlacement(record, list);
  return list.some((event, index) => index < Math.min(limit, at - 1) && event.place === 'settle');
}

/** The first case of `results` that is not reproduced (or partial, or empty), with its check and first differing event. */
const firstFailing = (results) => results.find((result) => !['reproduced', 'partial', 'empty'].includes(result.outcome)) ?? null;
const brief = (result) => (result ? { case: result.id, outcome: result.outcome, check: result.check ?? null, at: result.at ?? null, expected: result.expected ?? null, got: result.got ?? null, detail: (result.detail ?? '').slice(0, 400) } : null);
const PLANTED_MODULE = 'packages/orchestration-runtime/scheduler.js';

/**
 * Replays the scenario container and the test containers against the unchanged copy and every copy plant, with
 * the replayer at `replayModule`, and judges each with the closure judgement (`judgeClosure`, the repository's,
 * reading the recording's marks itself; a planted copy's own module difference aside). Returns
 * `{ unchanged: { reproduced, cases, failing, code }, plants: [{ name, check, on, caught, outcome, code, found }] }`:
 * a plant is caught when a case of its own source and cases is reported `different` by its check (at an event of
 * its `event` kind, when given) and the judgement exits 1.
 */
export async function runCopyPlants({ scenarios, tests = [], root, replayModule, only = null, withUnchanged = !only }) {
  const { prepareCopy, replayContainers } = await import(pathToFileURL(replayModule).href);
  const { judgeClosure, recordedMarks } = await import(pathToFileURL(path.join(HERE, 'closure.mjs')).href);
  const pick = (results, names) => results.filter((result) => names.some((name) => result.id.endsWith(` ${name} #1`)));
  const replayAll = async (copyDir, files) => {
    const replays = [];
    for (const file of files) replays.push({ file, recorded: recordedMarks(file), ...(await replayContainers({ files: [file], copyDir })) });
    return replays;
  };
  const sourcesOf = (scenarioReplays, testReplays) => [{ source: 'scenarios', recording: null, replays: scenarioReplays }, ...(testReplays.length ? [{ source: 'tests', recording: null, replays: testReplays }] : [])];
  const unchangedDir = withUnchanged ? prepareCopy(root, { name: 'copy-unchanged' }) : null;
  const unchangedScenarios = withUnchanged ? await replayAll(unchangedDir, [scenarios]) : [];
  const unchangedTests = withUnchanged ? await replayAll(unchangedDir, tests) : [];
  const unchangedResults = [...unchangedScenarios, ...unchangedTests].flatMap((replay) => replay.results ?? []);
  const unchanged = {
    reproduced: unchangedScenarios.flatMap((replay) => replay.results ?? []).filter((result) => result.outcome === 'reproduced').length,
    cases: unchangedScenarios.flatMap((replay) => replay.results ?? []).length,
    failing: brief(firstFailing(unchangedResults)),
    code: judgeClosure(sourcesOf(unchangedScenarios, unchangedTests)).code,
  };
  const plants = [];
  for (const plant of COPY_PLANTS.filter((entry) => !only || only.includes(entry.name))) {
    const copyDir = prepareCopy(root, { name: `copy-${plant.name}`, replace: [plant] });
    const replays = plant.on === 'tests' ? await replayAll(copyDir, tests) : await replayAll(copyDir, [scenarios]);
    const results = replays.flatMap((replay) => replay.results ?? []);
    const containerOf = new Map(replays.flatMap((replay) => (replay.results ?? []).map((result) => [result, replay.file])));
    const own = plant.on === 'tests' ? (plant.cases ? pick(results, plant.cases) : results) : pick(results, plant.scenarios);
    const reporting = own.find((result) => result.outcome === 'different' && result.check === plant.check && (!plant.event || String(result.expected ?? '').startsWith(plant.event))
      && (!plant.settled || settlePlacedBefore(containerOf.get(result), result.id, result.at)));
    const judged = judgeClosure(plant.on === 'tests' ? sourcesOf([], replays).slice(1) : sourcesOf(replays, []), { expectCopyDiffers: [PLANTED_MODULE] });
    const differing = results.filter((result) => result.outcome === 'different');
    plants.push({
      name: plant.name, check: plant.check, on: plant.on, scenarios: plant.scenarios ?? null, caught: Boolean(reporting) && judged.code === 1, code: judged.code,
      outcome: (reporting ?? firstFailing(own))?.outcome ?? 'reproduced', found: brief(reporting ?? firstFailing(own)), cases: own.length,
      different: differing.length, checks: [...new Set(differing.map((result) => result.check))].sort(),
    });
  }
  return { unchanged, plants };
}

/** One replayer plant, judged by its named check (runs in its own process, see main). */
export async function runReplayerPlant({ plant, scenarios, tests = [], root }) {
  const replayModule = plantedReplayer(path.join(root, `replayer-${plant.name}`), plant);
  if (plant.check === 'copy-plants') {
    const table = await runCopyPlants({ scenarios, tests, root: path.join(root, `copies-${plant.name}`), replayModule, only: plant.breaks });
    const missed = table.plants.filter((entry) => !entry.caught);
    return { name: plant.name, check: plant.check, caught: missed.length > 0, found: missed.length ? { detail: `copy plants no longer reported different by their own check: ${missed.map((entry) => `${entry.name} (want ${entry.check}; found ${entry.outcome} ${entry.found?.check ?? 'nothing'}, judged exit ${entry.code})`).join(', ')}` } : null };
  }
  const { prepareCopy, replayContainers } = await import(pathToFileURL(replayModule).href);
  // Against the unchanged copy, or (`copy`) against a planted one, whose own module difference is then expected, or
  // (`against: 'delivery'`) against the delivery copy, which differs from the recorded code in no compared event.
  const copyPlant = plant.copy ? COPY_PLANTS.find((entry) => entry.name === plant.copy) : null;
  const copyDir = prepareCopy(path.join(root, `copies-${plant.name}`), { name: 'copy', replace: plant.against === 'delivery' ? DELIVERY_COPY : copyPlant ? [copyPlant] : [] });
  const files = plant.on === 'tests' ? tests : [scenarios];
  if (['reproduced-complete', 'crossed-mark', 'event-count', 'unrecordable-mark'].includes(plant.check)) {
    // The judgement is the repository's own: the plant is in the replayer, the check is the closure's, which reads the recording's marks itself.
    const { judgeClosure, recordedMarks } = await import(pathToFileURL(path.join(HERE, 'closure.mjs')).href);
    const replays = [];
    for (const file of files) replays.push({ file, recorded: recordedMarks(file), ...(await replayContainers({ files: [file], copyDir })) });
    const judged = judgeClosure([{ source: plant.on, recording: null, replays }], { expectCopyDiffers: copyPlant ? [PLANTED_MODULE] : [] });
    const found = judged.problems.find((problem) => problem.check === plant.check);
    return { name: plant.name, check: plant.check, caught: Boolean(found) && judged.code === 1, found: found ? { detail: found.detail } : null };
  }
  const replayed = await replayContainers({ files, copyDir });
  const own = plant.cases ? replayed.results.filter((result) => plant.cases.some((name) => result.id.endsWith(` ${name} #1`))) : replayed.results;
  const reporting = own.find((result) => result.outcome === 'different' && result.check === plant.check);
  const outcome = { name: plant.name, check: plant.check, caught: Boolean(reporting), found: brief(reporting ?? firstFailing(own)) };
  if (plant.against !== 'delivery') return outcome;
  // The same planted replayer on the real recordings (every test container but the shapes), against the unchanged
  // copy: how many of their cases it makes `different` (O0c review 3, S1: whether a real recording tells the
  // directions apart; none tells the early one, see docs/TESTING.md).
  const real = files.filter((file) => !file.endsWith('shapes.toy.mjs.ndjson'));
  const unchanged = prepareCopy(path.join(root, `copies-${plant.name}`), { name: 'unchanged' });
  const realResults = real.length ? (await replayContainers({ files: real, copyDir: unchanged })).results : [];
  const differing = realResults.filter((result) => result.outcome === 'different');
  return { ...outcome, real: { cases: realResults.length, different: differing.length, checks: [...new Set(differing.map((result) => result.check))].sort(), first: brief(differing[0] ?? null) } };
}

/** The unchanged replayer against the delivery copy: every case as against the unchanged copy, the delivery case reproduced. */
export async function runDeliveryControl({ tests, root }) {
  const { prepareCopy, replayContainers } = await import(pathToFileURL(path.join(HERE, 'replay.mjs')).href);
  const copyDir = prepareCopy(path.join(root, 'copies-delivery-control'), { name: 'copy', replace: DELIVERY_COPY });
  const { results } = await replayContainers({ files: tests, copyDir });
  const delivery = results.find((result) => result.id.endsWith(` ${DELIVERY_CASE} #1`)) ?? null;
  return { cases: results.length, different: results.filter((result) => result.outcome === 'different').length, delivery: delivery ? { outcome: delivery.outcome, produced: delivery.produced, events: delivery.events } : null, failing: brief(firstFailing(results)) };
}

/**
 * Runs one command, its stdout's last line parsed as JSON. Bounded: past `timeoutMs` the process is killed and the
 * result is an error that names `what` (the plants it was running), so a stuck plant says which one it was.
 */
const runJson = (args, { timeoutMs, what }) => new Promise((resolve) => {
  const child = spawn('bun', args, { cwd: REPOSITORY, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let late = false;
  const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (late) { resolve({ error: `${what} did not finish within ${timeoutMs} ms and was killed` }); return; }
    try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: `${what}: exit ${code ?? signal}: ${err.trim().split('\n').slice(-4).join(' | ')}` }); }
  });
});

/**
 * How many plant processes run at once when the caller does not say: each replays the whole corpus it is given and
 * keeps a core busy, so all of them at once (21) swamp a small machine. One core is left to the caller.
 */
export const defaultPlantWorkers = (cores = os.availableParallelism()) => Math.max(1, Math.min(4, cores - 1));

/** At most `workers` of the given thunks run at once; resolves each thunk's own result. */
export function limiter(workers) {
  let active = 0;
  const waiting = [];
  const next = () => { if (active < workers && waiting.length) { active += 1; waiting.shift()(); } };
  return (thunk) => new Promise((resolve, reject) => {
    waiting.push(() => { Promise.resolve().then(thunk).then(resolve, reject).finally(() => { active -= 1; next(); }); });
    next();
  });
}

async function main(argv) {
  const options = Object.fromEntries(argv.map((arg) => /^--([a-z-]+)=(.*)$/.exec(arg)).filter(Boolean).map((match) => [match[1], match[2]]));
  if (!options.scenarios) { console.error('usage: bun replay-mutants.mjs --scenarios=<container> [--tests=<container>,...] [--json=<out>] [--only=<replayer plant>] [--workers=N] [--deadline-ms=N]'); return 64; }
  const workers = Number(options.workers ?? defaultPlantWorkers());
  const deadlineMs = Number(options['deadline-ms'] ?? 600_000);
  if (!Number.isInteger(workers) || workers < 1 || !Number.isInteger(deadlineMs) || deadlineMs < 1) { console.error('--workers and --deadline-ms must be positive integers'); return 64; }
  const tests = (options.tests ?? '').split(',').filter(Boolean);
  // Standalone, the scratch is a run root (removed on pass, failure and interruption, its children stopped first); under a caller, inside the caller's.
  const scratch = options.root ? null : (await import('./record.mjs')).createScratch('scheduler-conformance-plants');
  const root = scratch ? scratch.dir : mkdtempSync(path.join(options.root, 'replay-plants-'));
  try {
    if (options.only) {
      const plant = REPLAYER_PLANTS.find((entry) => entry.name === options.only);
      const outcome = await runReplayerPlant({ plant, scenarios: options.scenarios, tests, root });
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return 0;
    }
    if (options['delivery-control']) {
      process.stdout.write(`${JSON.stringify(await runDeliveryControl({ tests, root }))}\n`);
      return 0;
    }
    if (options.copies !== undefined) {
      // One share of the copy plants (and, for the first share, the unchanged copy), in this process.
      const names = options.copies.split(',').filter(Boolean);
      const table = await runCopyPlants({ scenarios: options.scenarios, tests, root, replayModule: path.join(HERE, 'replay.mjs'), only: names, withUnchanged: options.unchanged === '1' });
      process.stdout.write(`${JSON.stringify(table)}\n`);
      return 0;
    }
    const args = [fileURLToPath(import.meta.url), `--scenarios=${options.scenarios}`, `--tests=${tests.join(',')}`, `--root=${root}`];
    // The copy plants in four processes and each replayer plant in its own (a second replayer would install its hooks
    // over this one's): at most `workers` of them at a time, each with a deadline that names its plants.
    const SHARES = 4;
    const shares = Array.from({ length: SHARES }, (_, index) => COPY_PLANTS.filter((_plant, at) => at % SHARES === index).map((plant) => plant.name));
    const queued = limiter(workers);
    const copyRuns = Promise.all(shares.map((names, index) => queued(() => runJson([...args, `--copies=${names.join(',')}`, `--unchanged=${index === 0 ? 1 : 0}`], { timeoutMs: deadlineMs, what: `the copy plants ${names.join(', ')}` }))));
    const replayerRuns = Promise.all(REPLAYER_PLANTS.map((plant) => queued(async () => {
      const found = await runJson([...args, `--only=${plant.name}`], { timeoutMs: deadlineMs, what: `the replayer plant ${plant.name}` });
      return found.error ? { name: plant.name, check: plant.check, caught: false, found: { detail: `the plant's process failed: ${found.error}` } } : found;
    })));
    const deliveryRun = queued(() => runJson([...args, '--delivery-control=1'], { timeoutMs: deadlineMs, what: 'the delivery control' }));
    const [tables, replayer, delivery] = await Promise.all([copyRuns, replayerRuns, deliveryRun]);
    const failed = tables.find((table) => table.error);
    const byName = new Map(tables.flatMap((table) => table.plants ?? []).map((entry) => [entry.name, entry]));
    const copies = {
      unchanged: failed ? { error: failed.error } : tables[0].unchanged,
      plants: COPY_PLANTS.map((plant) => byName.get(plant.name) ?? { name: plant.name, check: plant.check, caught: false, found: { detail: `the plant's process failed: ${failed?.error ?? 'no result'}` } }),
    };
    const text = `${JSON.stringify({ ...copies, replayer, delivery })}\n`;
    if (options.json) writeFileSync(options.json, text); else process.stdout.write(text);
    return 0;
  } finally {
    if (scratch) scratch.finish('passed');
    else if (process.env.DEVRYAN_KEEP_ARTIFACTS !== '1') rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
