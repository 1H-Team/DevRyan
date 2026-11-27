// Planted candidates for the comparer (design file 30 §4.4, §4.7, §5, package
// O0d). Each is a copy of the scheduler package made in the run root with one
// planted change (exact anchored replacements, each anchor occurring once:
// replay.mjs `prepareCopy`), replayed against the reference recording of the
// scenarios it names, with the comparer on. Each must be reported `different`
// on each of its scenarios with its own named rule or oracle among the
// comparer's failures (`compare.rules`), and the closure judgement of that
// replay (the planted module's own provenance difference aside) must exit 1.
// The unchanged copy, replayed the same way, reproduces every case with the
// comparer passing (the control: without it a plant could pass for nothing).
//
//   bun scripts/scheduler-conformance/compare-mutants.mjs --scenarios=<container> [--only=<plant,...>] [--root=<dir>]
// prints one JSON line `{ control, plants }`; with `--modes=<scenario,...>` instead, the read-mode and
// independence checks (`runModeChecks`) on those scenarios (F10-auto-resume must be among the recorded cases).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeClosure, recordedMarks } from './closure.mjs';
import { DESIGN_INDEPENDENCE, unitsOf, compareEvent } from './compare.mjs';
import { copyProvenance, DEFAULT_MODE, installReplayHooks, loadCopy, loadReference, prepareCopy, replayCase } from './replay.mjs';
import { caseEvents, readContainer } from './trace.mjs';

const PLANTED_MODULE = 'packages/orchestration-runtime/scheduler.js';

const LAUNCH_IN_FINALLY = '          && !cancellationOwners.has(task.taskId)) launchTask(task);';
const ACCEPTED = "        const next = { ...previous, status: 'running' };\n        await commitTaskUpdateLocked(previous, next);\n        clearStartingLease(taskId);\n        return true;";
const ADMITTED = '          leaseToken: createLeaseToken(),\n          startedAt: now(),\n          waitingReason: null,';
const RECOVERY_LOOP = '        for (const task of active) await recoverTask(cloneTask(task));';
/** The restart sample's crash point with two active tasks (one stays starting) and one queued (package O0d fix round 1, S4). */
const RESTART_MIXED = 'restart-mixed crash at save 6 durable';

/**
 * The planted candidates: `rule` the name that must be among the comparer's failures on every scenario in
 * `scenarios` (a scenario's name, or one of its crash points by its test name), and every name in `also` with it;
 * `edits` the anchored replacements in scheduler.js. Each is one change the owner's rule (no cap, queue, throttle or
 * delay of launches) or the comparer's rules and oracles must catch.
 */
export const CANDIDATE_PLANTS = Object.freeze([
  {
    name: 'launch-one-tick-late', rule: 'launch_delayed', scenarios: ['F1-fanout-8'],
    purpose: 'a launch one tick late: the pump\'s finally queues each launch in a microtask (with one task nothing comes between, so only a fan-out shows it)',
    edits: [{ anchor: LAUNCH_IN_FINALLY, with: '          && !cancellationOwners.has(task.taskId)) queueMicrotask(() => launchTask(task));' }],
  },
  {
    name: 'concurrency-cap', rule: 'launch_delayed', scenarios: ['F1-fanout-8'],
    purpose: 'a cap of 4 concurrent launches: admitted tasks beyond it are not launched',
    edits: [{ anchor: '      for (const task of admitted) {', with: '      for (const task of admitted) { if (activeLaunches.size >= 4) continue;' }],
  },
  {
    name: 'launch-queue', rule: 'launch_delayed', scenarios: ['F1-fanout-8'],
    purpose: 'a queue in front of launches: one launch at a time, the next when the previous executor call settles',
    edits: [
      { anchor: '  const launchTask = (task) => {', with: '  const plantedQueue = [];\n  const plantedDrain = () => { while (plantedQueue.length && activeLaunches.size === 0) launchTask(plantedQueue.shift()); };\n  const launchTask = (task) => {' },
      { anchor: LAUNCH_IN_FINALLY, with: '          && !cancellationOwners.has(task.taskId)) { plantedQueue.push(task); plantedDrain(); }' },
      { anchor: '      () => activeLaunches.delete(task.taskId),\n      () => activeLaunches.delete(task.taskId),\n    );\n  };\n\n  const observeRecoveredTask', with: '      () => { activeLaunches.delete(task.taskId); plantedDrain(); },\n      () => { activeLaunches.delete(task.taskId); plantedDrain(); },\n    );\n  };\n\n  const observeRecoveredTask' },
    ],
  },
  {
    name: 'timer-before-launch', rule: 'launch_delayed', scenarios: ['submit-complete'],
    purpose: 'an extra timer before a launch: each launch first sets a timer of 0 ms',
    edits: [{ anchor: LAUNCH_IN_FINALLY, with: '          && !cancellationOwners.has(task.taskId)) { scheduleTimeout(() => {}, 0); launchTask(task); }' }],
  },
  {
    name: 'launch-advanced', rule: 'launch_advanced', scenarios: ['F1-fanout-8'],
    purpose: 'a launch advanced: each admitted task launches right after its own starting save, before the admissions behind it',
    edits: [{ anchor: '        scheduleStartingLease(next);\n        admitted.push(cloneTask(next));', with: '        scheduleStartingLease(next);\n        admitted.push(cloneTask(next));\n        launchTask(cloneTask(next));' }],
  },
  {
    name: 'extra-save', rule: 'saved-state', scenarios: ['submit-complete'],
    purpose: 'an extra save: provider acceptance writes its state a second time',
    edits: [{ anchor: ACCEPTED, with: ACCEPTED.replace('        clearStartingLease(taskId);', '        await persistence.save(snapshotLocked(), {});\n        clearStartingLease(taskId);') }],
  },
  {
    name: 'skipped-save', rule: 'saved-state', scenarios: ['submit-complete'],
    purpose: 'a skipped save: the first write of a state holding a running task is not made (the commit goes on as if it had been)',
    edits: [
      { anchor: '  const persistLocked = async () => {', with: '  let plantedSkipped = false;\n  const persistLocked = async () => {' },
      { anchor: '      await persistence.save(state, { onProgress: input => {', with: '      await (!plantedSkipped && state.tasks.some((row) => row.status === \'running\') && (plantedSkipped = true) ? async () => {} : persistence.save)(state, { onProgress: input => {' },
    ],
  },
  {
    name: 'waiter-before-save', rule: 'durability', scenarios: ['wait-then-shutdown'],
    purpose: 'a waiter resolved before its save: task waiters are released before the terminal state is saved',
    edits: [{ anchor: '    tasks.set(next.taskId, next);\n    resultEnvelopes.set(next.taskId, envelope);\n    try {\n      await persistLocked();', with: '    tasks.set(next.taskId, next);\n    resultEnvelopes.set(next.taskId, envelope);\n    notifyTaskWaiters(next);\n    try {\n      await persistLocked();' }],
  },
  {
    name: 'launch-before-starting-save', rule: 'durability', scenarios: ['submit-complete'],
    purpose: 'a launch before its starting save (design M6): the admitted task is launched before its admission is saved',
    edits: [{ anchor: '        await commitTaskUpdateLocked(previous, next);\n        scheduleStartingLease(next);', with: '        tasks.set(next.taskId, next);\n        launchTask(cloneTask(next));\n        await commitTaskUpdateLocked(previous, next);\n        scheduleStartingLease(next);' }],
  },
  {
    name: 'time-not-from-now', rule: 'times', scenarios: ['submit-complete'],
    purpose: 'a time not derived from a handed-out now: startedAt is now plus 7 ms',
    edits: [{ anchor: ADMITTED, with: ADMITTED.replace('startedAt: now(),', 'startedAt: now() + 7,') }],
  },
  {
    name: 'identifier-not-from-site', rule: 'identifiers', scenarios: ['submit-complete'],
    purpose: 'an identifier not from its draw site: the lease token is drawn (draw order unchanged) but the task gets one made from its task ID',
    edits: [{ anchor: ADMITTED, with: ADMITTED.replace('leaseToken: createLeaseToken(),', 'leaseToken: (createLeaseToken(), `dvr_lease_${previous.taskId.slice(9)}`),') }],
  },
  {
    name: 'illegal-transition', rule: 'transitions', scenarios: ['submit-complete'],
    purpose: 'an illegal transition: provider acceptance also changes the task\'s label (an immutable field), with the scheduler\'s own transition guard taken out',
    edits: [
      { anchor: '  const commitTaskUpdateLocked = async (previous, next, { publish = true } = {}) => {\n    assertManagedTaskTransition(previous, next);', with: '  const commitTaskUpdateLocked = async (previous, next, { publish = true } = {}) => {' },
      { anchor: ACCEPTED, with: ACCEPTED.replace("status: 'running' };", "status: 'running', label: `${previous.label} (planted)` };") },
    ],
  },
  {
    name: 'timer-leaked-at-shutdown', rule: 'timer-census', scenarios: ['wait-then-shutdown'],
    purpose: 'a timer leaked at shutdown: shutdown no longer clears starting leases',
    edits: [{ anchor: '      for (const taskId of [...startingLeaseTimers.keys()]) clearStartingLease(taskId);\n', with: '' }],
  },
  {
    name: 'waiting-capacity-written', rule: 'waiting-capacity', scenarios: ['F9-prerequisites'],
    purpose: 'waitingReason capacity written: a task held for prerequisites is recorded as held for capacity',
    edits: [{ anchor: '        kind: decision.reason,', with: "        kind: decision.reason === 'prerequisites' ? 'capacity' : decision.reason," }],
  },
  // ---------------------------------------------------------------- fix round 1
  // The design's cap and capacity hold (§4.7 M7, M8) and a recovery that never pumps: each diverges before any launch
  // (an admission save, a hold), so its launches are judged in the candidate's run past the first difference.
  {
    name: 'admission-cap', rule: 'launch_delayed', scenarios: ['F1-fanout-8'],
    purpose: 'a cap of 4 at admission (design M7): pump skips a queued task while 4 are active; the fifth to eighth launches never come',
    edits: [{ anchor: '      for (const [index, previous] of queued.entries()) {', with: '      for (const [index, previous] of queued.entries()) { if (activeCount >= 4) { held++; continue; }' }],
  },
  {
    name: 'admit-capacity-forced', rule: 'launch_delayed', also: ['waiting-capacity'], scenarios: ['F1-fanout-8'],
    purpose: 'a queue that holds one launch until another finishes (design M8): the admission decision without the hook answers capacity, limit 1, once a task is active',
    edits: [{ anchor: '    if (!admitLaunch) return { admit: true };', with: "    if (!admitLaunch) return activeCount >= 1 ? { admit: false, reason: 'capacity', limit: 1, retryInMs: 5000 } : { admit: true };" }],
  },
  {
    name: 'recovery-no-pump', rule: 'launch_delayed', scenarios: [RESTART_MIXED],
    purpose: 'a recovery that never pumps: initialize recovers the active tasks but does not admit the queued ones',
    edits: [{ anchor: '      activated = true;\n      await pump();', with: '      activated = true;' }],
  },
  // S4: recovery order and leases, per push on the restart sample.
  {
    name: 'recovery-reversed', rule: 'port-arguments', scenarios: [RESTART_MIXED],
    purpose: 'active tasks recovered in reverse queue order',
    edits: [{ anchor: RECOVERY_LOOP, with: '        for (const task of active.reverse()) await recoverTask(cloneTask(task));' }],
  },
  {
    name: 'recovery-parallel', rule: 'event-sequence', scenarios: [RESTART_MIXED],
    purpose: 'active tasks reconciled in parallel (design M10)',
    edits: [{ anchor: RECOVERY_LOOP, with: '        await Promise.all(active.map((task) => recoverTask(cloneTask(task))));' }],
  },
  {
    name: 'recovery-no-starting-lease', rule: 'event-sequence', scenarios: [RESTART_MIXED],
    purpose: 'initialize does not re-arm the starting lease of a task still starting after its reconcile',
    edits: [{ anchor: '        scheduleTaskDeadline(task);\n        scheduleStartingLease(task);\n', with: '        scheduleTaskDeadline(task);\n' }],
  },
  // S3: a second launch of a task is a defect.
  {
    name: 'duplicate-launch', rule: 'launch_duplicated', scenarios: ['submit-complete'],
    purpose: 'a task launched twice: the pump\'s finally launches each admitted task again',
    edits: [{ anchor: LAUNCH_IN_FINALLY, with: '          && !cancellationOwners.has(task.taskId)) { launchTask(task); activeLaunches.delete(task.taskId); launchTask(task); }' }],
  },
  // The corpus gaps the review found: each now has a scenario that shows it.
  {
    name: 'run-cleanup-31000', rule: 'times', scenarios: ['run-cleanup-backoff'],
    purpose: 'a changed backoff (design M5): the second run-cleanup retry 31,000 ms instead of 30,000',
    edits: [{ anchor: 'const RUN_CLEANUP_RETRY_MS = [5_000, 30_000, 120_000, 600_000];', with: 'const RUN_CLEANUP_RETRY_MS = [5_000, 31_000, 120_000, 600_000];' }],
  },
  {
    name: 'queue-order-no-createdAt', rule: 'saved-state', also: ['launch_delayed'], scenarios: ['queue-order-ties'],
    purpose: 'queue order without its createdAt tiebreak (design M11): two tasks of one sequence ordered by task ID',
    edits: [{ anchor: '  left.sequence - right.sequence\n  || left.createdAt - right.createdAt\n', with: '  left.sequence - right.sequence\n' }],
  },
  {
    name: 'shutdown-keeps-deadlines', rule: 'timer-census', scenarios: ['shutdown-with-timers'],
    purpose: 'shutdown no longer clears task deadline timers',
    edits: [{ anchor: '      for (const taskId of [...timeoutTimers.keys()]) clearTaskTimeout(taskId);\n', with: '' }],
  },
  {
    name: 'shutdown-keeps-admission-retry', rule: 'timer-census', scenarios: ['shutdown-with-timers'],
    purpose: 'shutdown no longer clears the admission retry',
    edits: [{ anchor: '      nativeCompletionFailures.clear();\n      clearAdmissionRetry();', with: '      nativeCompletionFailures.clear();' }],
  },
]);

const scenarioOf = (id) => /scenarios\.corpus\.mjs:\d+ (.+) #\d+$/.exec(id)?.[1] ?? null;

/** Replays the named scenario cases of a container against a copy, with the comparer on; results in order. */
async function replaySelected({ file, copyDir, names }) {
  const read = readContainer(readFileSync(file, 'utf8'));
  const copy = await loadCopy(copyDir);
  const reference = await loadReference();
  const results = [];
  for (const record of read.cases) {
    if (!names.includes(scenarioOf(record.id))) continue;
    results.push({ ...(await replayCase({ record, resolve: read.resolve, header: read.header, copy, reference })), testFile: read.header.testFile });
  }
  return { containers: [{ file, testFile: read.header.testFile, cases: read.cases.length, end: read.end, provenance: copyProvenance(read.header, copy) }], results };
}

/** The judgement of one selected replay: the marks of the selected cases only (what the closure reads, cut to them). */
function judgeSelected(file, replayed, options) {
  const marks = recordedMarks(file);
  const ids = new Set(replayed.results.map((result) => result.id));
  const cases = marks.cases.filter((mark) => ids.has(mark.id));
  const recorded = { end: { cases: cases.length, events: cases.reduce((sum, mark) => sum + mark.events, 0) }, cases };
  const containers = replayed.containers.map((container) => ({ ...container, end: recorded.end }));
  return judgeClosure([{ source: 'scenarios', recording: null, replays: [{ file, recorded, ...replayed, containers }] }], options);
}

/**
 * Runs the control and every plant (or `only`) against the scenario container. Returns `{ control, plants }`:
 * control `{ cases, reproduced, failing, code }`; per plant `{ name, rule, caught, cases: [{ scenario, outcome, check,
 * rule, rules }], code }`, caught when every one of its scenarios is `different` with `rule` among the comparer's
 * failures and the judgement exits 1.
 */
export async function runCandidatePlants({ scenarios, root, only = null }) {
  installReplayHooks();
  const plants = CANDIDATE_PLANTS.filter((plant) => !only || only.includes(plant.name));
  const names = [...new Set(plants.flatMap((plant) => plant.scenarios))];
  const controlDir = prepareCopy(root, { name: 'copy-unchanged' });
  const controlRun = await replaySelected({ file: scenarios, copyDir: controlDir, names });
  const control = {
    cases: controlRun.results.length,
    reproduced: controlRun.results.filter((result) => result.outcome === 'reproduced' && result.compare?.verdict === 'pass').length,
    missing: names.filter((name) => !controlRun.results.some((result) => scenarioOf(result.id) === name)),
    failing: controlRun.results.find((result) => result.outcome !== 'reproduced') ?? null,
    code: judgeSelected(scenarios, controlRun).code,
  };
  const out = [];
  for (const plant of plants) {
    const copyDir = prepareCopy(root, { name: `copy-${plant.name}`, replace: plant.edits.map((edit) => ({ file: 'scheduler.js', ...edit })) });
    const run = await replaySelected({ file: scenarios, copyDir, names: plant.scenarios });
    const judged = judgeSelected(scenarios, run, { expectCopyDiffers: [PLANTED_MODULE] });
    const wanted = [plant.rule, ...(plant.also ?? [])];
    const cases = run.results.map((result) => ({ scenario: scenarioOf(result.id), outcome: result.outcome, check: result.check ?? null, rule: result.rule ?? null, rules: result.compare?.rules ?? [], observed: result.compare?.observed ?? null, detail: String(result.compare?.findings?.find((finding) => finding.rule === plant.rule)?.detail ?? result.detail ?? '').slice(0, 400) }));
    const caught = cases.length === plant.scenarios.length && cases.every((item) => item.outcome === 'different' && wanted.every((rule) => item.rules.includes(rule))) && judged.code === 1;
    out.push({ name: plant.name, rule: plant.rule, also: plant.also ?? [], caught, code: judged.code, cases });
  }
  return { control, plants: out };
}

/** A recorded case with its events edited in memory (positions `at` and `seq` kept consistent). */
function editedRecord(record, edit) {
  const events = caseEvents(record);
  const next = edit(events);
  if (!next) return null;
  const seq = new Map();
  const placed = next.map((event, index) => { const n = (seq.get(event.c) ?? 0) + 1; seq.set(event.c, n); return { ...event, at: index + 1, seq: n }; });
  return { ...record, constructions: record.constructions.map((construction) => ({ ...construction, events: placed.filter((event) => event.c === construction.n).map(({ c: _c, ...event }) => event) })) };
}

/**
 * The two named relaxations, run through the replayer against real recordings: OD2's read mode (the unchanged copy
 * and a copy that reads an option once more, exact and free; a recording edited so one option key reads two values)
 * and the design's independence table (a recording edited so a timer set comes before the publication that was
 * right before it: the unchanged copy reproduces it only with the table, the replay's move and the comparer's
 * agree). Returns one entry per check.
 */
export async function runModeChecks({ scenarios, root, names }) {
  installReplayHooks();
  const read = readContainer(readFileSync(scenarios, 'utf8'));
  const records = read.cases.filter((record) => names.includes(scenarioOf(record.id)));
  const reference = await loadReference();
  const unchanged = await loadCopy(prepareCopy(root, { name: 'copy-modes' }));
  const READ_SITE = '    const committed = uncommittedRead ? committedReadState.tasks.find(row => row.taskId === task.taskId) : tasks.get(task.taskId);';
  const extraRead = await loadCopy(prepareCopy(root, { name: 'copy-extra-read', replace: [{ file: 'scheduler.js', anchor: READ_SITE, with: `    void options.abortTimeoutMs;\n${READ_SITE}` }] }));
  // A copy that reads an option key no recording ever read: in read mode free its value cannot be given (inconclusive).
  const unreadRead = await loadCopy(prepareCopy(root, { name: 'copy-unread-read', replace: [{ file: 'scheduler.js', anchor: READ_SITE, with: `    void options.plantedUnreadOption;\n${READ_SITE}` }] }));
  const replay = (record, copy, mode) => replayCase({ record, resolve: read.resolve, header: read.header, copy, reference, mode: { ...DEFAULT_MODE, ...mode } });
  const brief = (result) => ({ id: result.id, outcome: result.outcome, check: result.check ?? null, rule: result.rule ?? null, readMode: result.compare?.readMode ?? result.readMode ?? null, independence: result.compare?.independence ?? null, verdict: result.compare?.verdict ?? null });
  const out = { readFree: [], extraReadExact: [], extraReadFree: [], unreadFree: [], varies: null, independence: null };
  for (const record of records) {
    out.readFree.push(brief(await replay(record, unchanged, { reads: 'free' })));
    out.extraReadExact.push(brief(await replay(record, extraRead, { reads: 'exact' })));
    out.extraReadFree.push(brief(await replay(record, extraRead, { reads: 'free' })));
    out.unreadFree.push(brief(await replay(record, unreadRead, { reads: 'free' })));
  }
  // option-varies: the second read of one option key answers another recorded value.
  const target = records[0];
  const varied = editedRecord(target, (events) => {
    const reads = events.filter((event) => event.dir === 'in' && event.kind === 'read' && event.object === 'options' && event.op === undefined);
    const byKey = new Map();
    for (const event of reads) byKey.set(event.key, [...(byKey.get(event.key) ?? []), event]);
    const twice = [...byKey.values()].find((list) => list.length >= 2);
    const other = events.find((event) => event.kind === 'clock' && typeof event.value === 'string');
    if (!twice || !other) return null;
    return events.map((event) => (event === twice[1] ? { ...event, value: other.value } : event));
  });
  out.varies = varied ? brief(await replay(varied, unchanged, { reads: 'free' })) : { error: 'no option key read twice' };
  // Independence: the first publication immediately followed by a timer set, the two moved (timer set first).
  const auto = read.cases.find((record) => scenarioOf(record.id) === 'F10-auto-resume');
  let swappedAt = null;
  const swapped = auto && editedRecord(auto, (events) => {
    const list = events.map((event) => compareEvent(event, read.resolve));
    const units = unitsOf(list);
    const index = units.findIndex((unit, at) => unit.lane === 'publish' && units[at + 1]?.lane === 'timer.set');
    if (index < 0) return null;
    const [publish, timer] = [units[index], units[index + 1]];
    swappedAt = publish.start + 1;
    return [...events.slice(0, publish.start), ...events.slice(timer.start, timer.end), ...events.slice(publish.start, publish.end), ...events.slice(timer.end)];
  });
  out.independence = swapped ? { at: swappedAt, design: brief(await replay(swapped, unchanged, { independence: DESIGN_INDEPENDENCE })), strict: brief(await replay(swapped, unchanged, {})) } : { error: 'F10-auto-resume has no publication right before a timer set' };
  return out;
}

async function main(argv) {
  const options = Object.fromEntries(argv.map((arg) => /^--([a-z-]+)=(.*)$/.exec(arg)).filter(Boolean).map((match) => [match[1], match[2]]));
  if (!options.scenarios) { console.error('usage: bun compare-mutants.mjs --scenarios=<container> [--only=<plant,...>] [--root=<dir>]'); return 64; }
  const scratch = options.root ? null : (await import('./record.mjs')).createScratch('scheduler-conformance-compare-plants');
  const root = scratch ? scratch.dir : mkdtempSync(path.join(options.root, 'compare-plants-'));
  try {
    const result = options.modes
      ? await runModeChecks({ scenarios: options.scenarios, root, names: options.modes.split(',') })
      : await runCandidatePlants({ scenarios: options.scenarios, root, only: options.only ? options.only.split(',') : null });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } finally {
    if (scratch) scratch.finish('passed');
    else if (process.env.DEVRYAN_KEEP_ARTIFACTS !== '1') rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
