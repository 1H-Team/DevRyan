// The closure check (BH4; design file 31 §5.5): every scenario of a group is
// run on the reference (R), on a second reference on a fresh data root (R')
// and on the JavaScript candidate adapter (J, js-candidate.mjs: the group's
// own handlers in a process of its own on a data root of its own), and, when
// one is given, on a candidate (C). The comparer (compare.mjs) compares R
// with R' (stability), R with J (closure) and R with C (the judgment).
//
// The outcome of a row (one step), in this order (outcomes.mjs has the table):
//   1. a driver problem on R or R': inconclusive (unrecordable for the checks that make it so);
//   2. R against R' differs: unstable; R against R' could not be compared in full: inconclusive;
//   3. a driver problem on J, or R against J differs: unrecordable (the reference's inside view and a
//      correct implementation's outside view disagree); not compared in full: inconclusive;
//   4. with a candidate: a candidate fault or a difference: failed; another problem or a part not
//      compared: inconclusive; else passed. Without a candidate, J is the one judged: passed.
//   An edge exchange (the edge answers it; never sent to a candidate) that is stable ends
//   inconclusive with the check `edge-exchange`: nothing of the group's was judged on it; one the
//   tail answers (what the server composes after the group) with `tail-exchange`.
// What the judged arm did is never hidden by an earlier class (design §2.2 "never as a silent pass"):
// a candidate fault or a difference of the candidate fails the row whatever 1 to 3 said (the earlier
// class stays in the reason), and, on a row 1 to 3 left inconclusive, a fault of J or R against J
// differing makes it unrecordable. Each row carries `judged` (the judged arm's differences and
// faults), and outcomes.mjs never lets a waiver cover a row whose `judged` is not empty.
// A row never passes with a difference, a driver problem or a part not compared.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE_EDGE_FILES, REFERENCE_EDGE_STARTUP_FILES, candidateArm, referenceArm } from './arms.mjs';
import { allOf, compareRecordings, dateLagOf, differenceLine } from './compare.mjs';
import { CANDIDATE_FAULTS, UNRECORDABLE, recordingJson, runScenario } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JS_CANDIDATE = path.join(HERE, 'js-candidate.mjs');

/** What each group declares to the comparer (rules P and W, the effect kinds it can cause; groups.mjs names the dependencies). */
export const DECLARATIONS = Object.freeze({
  'magic-prompts': Object.freeze({
    identifierKeys: Object.freeze([]), // it chooses no identifier
    timeKeys: Object.freeze([]), // it writes no time
    effects: Object.freeze([]), // its dependencies are fsPromises, path and the data root: no hub, no outbound call, no child
  }),
  'session-folders': Object.freeze({
    identifierKeys: Object.freeze([]), // it chooses no identifier a body carries
    // Each save writes `<file>.tmp-${process.pid}-${crypto.randomUUID()}` and renames it over the file (rule T): the name
    // appears in a failed save's error text, and in the tree only if a process dies between the write and the rename.
    temporaryNames: Object.freeze([Object.freeze({ file: 'sessions-directories.json' })]),
    timeKeys: Object.freeze([]), // it writes no time of its own (updatedAt is the client's)
    effects: Object.freeze([]), // its dependencies are fsPromises, path and the data root: no hub, no outbound call, no child
  }),
});
export const declarationsFor = (name) => ({ ...(DECLARATIONS[name] ?? {}), edgeFiles: [...REFERENCE_EDGE_FILES], startupFiles: [...REFERENCE_EDGE_STARTUP_FILES] });

/** The principals J and a candidate are given: those the reference can produce (a step the reference cannot make has nothing to be compared with, and would change the candidate's state). */
export const JUDGED_PRINCIPALS = Object.freeze(['local-admin']);

/** J as a candidate arm: `handlers` is a directory holding a copy of the group's files (planted differences), or null. */
export function jsArm({ name, label, handlers = null, env = process.env }) {
  return candidateArm({ command: [process.execPath, JS_CANDIDATE, '--group', name, ...(handlers ? ['--handlers', handlers] : [])], label, env, principals: JUDGED_PRINCIPALS });
}

const problemsOf = (step) => step?.problems ?? [];
const checksOf = (step) => [...new Set(problemsOf(step).map((entry) => entry.check))];
const problemText = (label, step) => problemsOf(step).map((entry) => `${label} ${entry.check}: ${entry.text}`);

/**
 * The rows of one scenario from its recordings. `reference`, `second` and
 * `js` are recordings; `candidate` is one or null. Each row: `{ id, outcome,
 * reason, checks, differences, inconclusive, nondeterministic }`.
 */
export function closureRows({ scenario, reference, second, js, candidate = null, declarations = {} }) {
  const stability = compareRecordings({ reference, other: second, mode: 'stability', declarations });
  // A candidate's Date is bounded by the lag Node's Date cache showed on this run's references (R and R'), measured, never assumed.
  const dateLagMs = Math.max(dateLagOf(reference), dateLagOf(second));
  const closure = compareRecordings({ reference, other: js, mode: 'candidate', declarations, dateLagMs });
  const judged = candidate ? compareRecordings({ reference, other: candidate, mode: 'candidate', declarations, dateLagMs }) : null;
  const steps = (recording) => new Map((recording.steps ?? []).map((step) => [step.id, step]));
  const [stepsR, stepsR2, stepsJ, stepsC] = [reference, second, js, candidate].map((recording) => (recording ? steps(recording) : null));
  const rows = [];
  const at = (result, id) => result?.steps.get(id) ?? { differences: [], inconclusive: [], notes: [], edge: false };
  // Recording-level findings (the arms' supplied values, the start and exit trees, a pairing conflict, an edge file
  // changed) are the row `<scenario>/recording`, which every scenario has; a start problem is the row `<scenario>/start`.
  const RECORDING = '(recording)';
  const levelOf = (result) => ({ differences: result?.differences ?? [], inconclusive: result?.inconclusive ?? [], notes: result?.notes ?? [], edge: false });
  for (const result of [stability, closure, judged]) if (result) result.steps.set(RECORDING, levelOf(result));
  const allRows = [...(reference.setup?.problems.length || second.setup?.problems.length || js.setup?.problems.length || candidate?.setup?.problems.length ? [{ id: 'start', kind: 'start' }] : []), ...(reference.steps ?? []), { id: RECORDING, kind: 'recording' }];
  if ((reference.steps ?? []).some((step) => step.id === 'recording' || step.id === 'start')) throw new Error(`closure: scenario ${scenario.id} names a step "recording" or "start", which are the rows of the whole recording`);
  for (const step of allRows) {
    const id = `${scenario.id}/${step.id === RECORDING ? 'recording' : step.id}`;
    const pick = (map, recording) => (step.id === 'start' ? recording?.setup : step.id === RECORDING ? { problems: [] } : map?.get(step.id));
    const r = pick(stepsR, reference);
    const r2 = pick(stepsR2, second);
    const j = pick(stepsJ, js);
    const c = candidate ? pick(stepsC, candidate) : null;
    const row = { id, outcome: 'inconclusive', reason: '', checks: [], differences: [], inconclusive: [], nondeterministic: r?.nondeterministic ?? null, whole: step.id === RECORDING || step.id === 'start' };
    const s = at(stability, step.id);
    const k = at(closure, step.id);
    const g = judged ? at(judged, step.id) : null;
    const referenceChecks = [...new Set([...checksOf(r), ...checksOf(r2)])];
    const set = (outcome, checks, reasonLines, differences = [], inconclusive = []) => Object.assign(row, { outcome, checks, reason: reasonLines.join(' | '), differences: differences.map(differenceLine), inconclusive: inconclusive.map((item) => `${item.step} ${item.component}: ${item.why}`) });
    const inconclusiveChecks = (items, fallback) => [...new Set(items.map((item) => item.check ?? fallback))];
    if (referenceChecks.length) {
      set(referenceChecks.some((check) => UNRECORDABLE.has(check)) ? 'unrecordable' : 'inconclusive', referenceChecks, [...problemText('R', r), ...problemText('R\'', r2)]);
    } else if (s.differences.length) {
      set('unstable', ['unstable'], ['the reference against a second reference on a fresh data root differs'], s.differences, s.inconclusive);
    } else if (s.inconclusive.length) {
      set('inconclusive', ['stability-incomplete'], ['the reference against a second reference could not be compared in full'], [], s.inconclusive);
    } else if (at(stability, step.id).edge && at(stability, step.id).answeredBy === 'tail') {
      set('inconclusive', ['tail-exchange'], ['a tail exchange: what the server composes after the group answers it (the group host\'s stand-in; stable: R against R\' equal), it is never sent to a candidate, and nothing of the group\'s is judged on it']);
    } else if (at(stability, step.id).edge) {
      set('inconclusive', ['edge-exchange'], ['an edge exchange: the edge answers it (stable: R against R\' equal), it is never sent to a candidate, and nothing of the group\'s is judged on it']);
    } else if (checksOf(j).length) {
      set('unrecordable', ['closure'], ['the JavaScript candidate adapter had problems', ...problemText('J', j)]);
    } else if (k.differences.length) {
      set('unrecordable', ['closure'], ['the reference\'s inside view against the JavaScript candidate adapter\'s outside view differs'], k.differences, k.inconclusive);
    } else if (k.inconclusive.length) {
      set('inconclusive', inconclusiveChecks(k.inconclusive, 'closure-incomplete'), ['the reference against the JavaScript candidate adapter could not be compared in full'], [], k.inconclusive);
    } else if (candidate) {
      const candidateChecks = checksOf(c);
      if (candidateChecks.length) set('inconclusive', candidateChecks, problemText('C', c));
      else if (g.inconclusive.length) set('inconclusive', inconclusiveChecks(g.inconclusive, 'candidate-incomplete'), ['the candidate could not be compared in full'], [], g.inconclusive);
      else set('passed', [], ['equal to the reference (R = R\' and R = J)']);
    } else {
      set('passed', [], ['the JavaScript candidate adapter equals the reference, and the reference is stable']);
    }
    // What the judged arm did is never hidden by the class above (S2 of the BH3/BH4 review).
    const jFaults = checksOf(j).filter((check) => CANDIDATE_FAULTS.has(check));
    const cFaults = candidate ? checksOf(c).filter((check) => CANDIDATE_FAULTS.has(check)) : [];
    const earlier = () => (row.outcome === 'passed' ? [] : [`before the judged arm was looked at, the row was ${row.outcome} (${row.checks.join(', ')}): ${row.reason}`]);
    if (row.outcome === 'inconclusive' && (jFaults.length || k.differences.length)) {
      set('unrecordable', ['closure', ...jFaults], [...earlier(), 'the JavaScript candidate adapter had faults or differs from the reference', ...problemText('J', j)], k.differences, k.inconclusive);
    }
    if (candidate && (cFaults.length || g.differences.length)) {
      set('failed', [...(cFaults.length ? checksOf(c) : []), ...(g.differences.length ? ['difference'] : [])], [...earlier(), ...(cFaults.length ? problemText('C', c) : []), ...(g.differences.length ? ['the candidate differs from the reference'] : [])], g.differences, g.inconclusive);
    }
    const judgedArm = candidate ? { differences: g.differences, faults: cFaults } : { differences: k.differences, faults: jFaults };
    row.judged = { arm: candidate ? 'candidate' : 'js', differences: judgedArm.differences.length, faults: judgedArm.faults };
    if (row.nondeterministic) row.reason = `${row.reason} (nondeterministic: ${row.nondeterministic})`;
    rows.push(row);
  }
  return { rows, comparisons: { stability, closure, judged } };
}

/**
 * Runs `scenario` on R, R' and J (and C when `candidateCommand` is given)
 * inside `run`, writes each recording to `recordings/<scenario>/<arm>.json`,
 * and returns `{ rows, recordings, comparisons }`. The arms of one scenario
 * run at the same time, each on its own data root and HOME. `coverage`: R
 * takes the group's block coverage (the census reads it).
 */
export async function runClosure({ run, scenario, name, group, candidateCommand = null, candidateLabel = 'candidate', handlers = null, limits, env = process.env, recordings: given = {}, coverage = true }) {
  const label = (arm) => `scenarios/${scenario.id}/${arm}`;
  const arms = {
    // R takes the group's block coverage for the census (R' does not: R against R' also shows that taking it changed nothing).
    reference: () => referenceArm({ run, name, group, label: label('reference'), env, coverage }),
    second: () => referenceArm({ run, name, group, label: label('reference-2'), env }),
    js: () => jsArm({ name, label: label(handlers ? 'js-planted' : 'js'), handlers, env }),
    ...(candidateCommand ? { candidate: () => candidateArm({ command: candidateCommand, label: label(candidateLabel), env, principals: JUDGED_PRINCIPALS }) } : {}),
  };
  const recordings = { ...given };
  await Promise.all(Object.entries(arms).filter(([key]) => !recordings[key]).map(async ([key, make]) => {
    const arm = make();
    recordings[key] = await runScenario({ scenario, arm, run, label: arm.label, limits });
    run.writeFile(`recordings/${scenario.id}/${path.basename(arm.label)}.json`, recordingJson(recordings[key]));
  }));
  const { rows, comparisons } = closureRows({ scenario, reference: recordings.reference, second: recordings.second, js: recordings.js, candidate: recordings.candidate ?? null, declarations: declarationsFor(name) });
  return { rows, recordings, comparisons };
}

/** Every difference of a comparison as lines (for reports and tests). */
export const comparisonLines = (comparison) => [...allOf(comparison, 'differences').map(differenceLine), ...allOf(comparison, 'inconclusive').map((item) => `${item.step} ${item.component}: (inconclusive) ${item.why}`)];
