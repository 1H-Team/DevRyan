// Planted bugs in the scripted driver itself (package O0b): each is an exact
// anchored replacement in a copy of driver.mjs (built by mutants.mjs's
// buildMutant; every anchor must occur exactly once) and must be reported by
// its own named check of driver.mjs (DRIVER_CHECKS) when its probe scenario
// runs. `unchanged` is a copy without a replacement that must pass every
// probe, so a copy that is broken cannot pass for a caught bug.
//
//   bun scripts/scheduler-conformance/driver-mutants.mjs   (prints one JSON line: every mutant's outcome)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMutant } from './mutants.mjs';
import { createScratch } from './record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = 'driver.mjs';
const planted = (name, check, replacements, probes) => ({ name, check, file: D, replacements, probes });

/** The probe scenarios (scenarios.mjs names) every mutant runs; a mutant names the ones that reach its bug. */
export const PROBES = Object.freeze(['F1-fanout-8', 'cancel-two', 'cancel-abort-timeout', 'submit-complete', 'F10-auto-resume']);

export const DRIVER_MUTANTS = Object.freeze([
  { name: 'unchanged', check: null, file: D, replacements: [], probes: PROBES },
  // A deferred settled out of order: the newest automatic call first.
  planted('settle-newest-first', 'settle-order', [['    for (const entry of this.pendingAutos) if (!this.instances[entry.inst - 1].dead) return entry;\n    return null;',
    '    const live = [...this.pendingAutos].filter((entry) => !this.instances[entry.inst - 1].dead);\n    return live.length ? live[live.length - 1] : null;']], ['cancel-two']),
  // A timer fired at the wrong virtual time: one millisecond late.
  planted('timer-late', 'timer-time', [['        this.time = timer.due;\n', '        this.time = timer.due + 1;\n']], ['cancel-abort-timeout']),
  // A timer fired early: at its set time.
  planted('timer-early', 'timer-time', [['        this.time = timer.due;\n', '        this.time = timer.setAt;\n']], ['cancel-abort-timeout']),
  // Port answers delivered between two timers due at the same instant (an order no runtime produces).
  planted('answers-between-same-instant-timers', 'timer-time', [['        await this.deliver([this.fire(timer)]);\n', '        await this.deliver([this.fire(timer)]);\n        await this.settleAutos();\n']], ['F10-auto-resume']),
  // An input delivered before the drain finished: the step does not wait for its own group's drain.
  planted('step-without-drain', 'input-before-drain', [['    const results = await this.deliver(inputs);\n', '    const results = this.deliver(inputs);\n']], ['submit-complete']),
  // A group split across macrotasks: a boundary between two inputs of one group.
  planted('group-split', 'group-atomic', [['      results.push(input.run());\n', '      results.push(input.run());\n      await boundary();\n']], ['F1-fanout-8']),
  // A group split by a microtask alone.
  planted('group-split-microtask', 'group-atomic', [['      results.push(input.run());\n', '      results.push(input.run());\n      await null;\n']], ['F1-fanout-8']),
  // Quiescence reported too early: the one-boundary drain awaits a microtask instead of an immediate.
  planted('quiescence-too-early', 'quiescence-confirmed', [["    if (this.drain.kind === 'one') await boundary();", "    if (this.drain.kind === 'one') await null;"]], ['F1-fanout-8']),
]);

/** Runs every mutant's probes against its copy (in this process: run it with bun). Returns `[{ name, check, reported: { probe: check|null|error } }]`. */
export async function runDriverMutants({ runDir, mutants = DRIVER_MUTANTS }) {
  const { runScenario, scenarioNamed } = await import('./scenarios.mjs');
  const results = [];
  for (const mutant of mutants) {
    const copy = buildMutant({ harnessDir: HERE, runDir, mutant: { ...mutant, file: mutant.replacements.length ? mutant.file : undefined } });
    const driver = await import(pathToFileURL(path.join(copy, D)).href);
    const reported = {};
    for (const probe of mutant.probes) {
      try {
        await runScenario(scenarioNamed(probe), { driver });
        reported[probe] = null;
      } catch (error) {
        reported[probe] = error instanceof driver.DriverCheckError ? error.check : `error: ${error?.message ?? error}`;
      }
    }
    results.push({ name: mutant.name, check: mutant.check, reported });
  }
  return results;
}

/** What is wrong with a run of the mutants: a mutant no probe reported by its own check, or an unchanged copy some probe failed. */
export function judgeDriverMutants(results) {
  const problems = [];
  for (const { name, check, reported } of results) {
    const found = Object.entries(reported);
    if (check === null) { for (const [probe, outcome] of found) if (outcome !== null) problems.push(`the unchanged copy fails probe ${probe}: ${outcome}`); continue; }
    if (!found.some(([, outcome]) => outcome === check)) problems.push(`${name} was not reported by ${check} (${found.map(([probe, outcome]) => `${probe}: ${outcome ?? 'passed'}`).join('; ')})`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const scratch = createScratch('scheduler-conformance-driver-mutants');
  let status = 'failed';
  try {
    const results = await runDriverMutants({ runDir: scratch.dir });
    const problems = judgeDriverMutants(results);
    console.log(JSON.stringify({ results, problems }));
    status = problems.length ? 'failed' : 'passed';
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    scratch.finish(status);
  }
}
