// The rows of a harness run (BH4): every scenario of the group through the
// closure check (closure.mjs): the reference (R), a second reference on a
// fresh data root (R') and the JavaScript candidate adapter (J), each
// recorded into the run's scratch, compared by the comparer (compare.mjs),
// and turned into one row per step plus one per scenario for what belongs to
// the whole recording (`<scenario>/recording`). Then the census (BH5,
// coverage-census.mjs): every item of the group against the rows that passed;
// each gap or census problem is a census gap of the run. A run of some of the
// group's scenarios (--scenario) has no census: it is never complete (exit 2,
// `not judged: census` on the last line).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DECLARATIONS, runClosure } from './closure.mjs';
import { dateLagOf, writersOf } from './compare.mjs';
import { groupItems } from './census-source.mjs';
import { censusLines, judgeCensus } from './coverage-census.mjs';
import { REPOSITORY_ROOT } from './edge.mjs';
import { CANDIDATE_EFFECT_LIMIT } from './observe.mjs';
import { judgeRun } from './outcomes.mjs';
import { PRINCIPALS } from './scenario.mjs';
import { RUST_GROUPS, rustCandidateCommand } from './rust-candidate.mjs';
import { CENSUS_ERRORS as MAGIC_PROMPTS_ERRORS, CENSUS_WAIVERS as MAGIC_PROMPTS_CENSUS, SCENARIOS as MAGIC_PROMPTS } from './scenarios/magic-prompts.mjs';
import { CENSUS_ERRORS as SESSION_FOLDERS_ERRORS, CENSUS_WAIVERS as SESSION_FOLDERS_CENSUS, SCENARIOS as SESSION_FOLDERS } from './scenarios/session-folders.mjs';

/** How each `--candidate` name of a group becomes a command (RunRefused when it cannot be run, with how to make it runnable). */
export const CANDIDATE_COMMANDS = Object.freeze(Object.fromEntries(RUST_GROUPS.map((group) => [group, Object.freeze({ rust: () => rustCandidateCommand({ group }) })])));

/** The scenarios of each group the harness has scenarios for. */
export const SCENARIOS_BY_GROUP = Object.freeze({ 'magic-prompts': MAGIC_PROMPTS, 'session-folders': SESSION_FOLDERS });
/** Each group's census waivers: items no scenario can exercise, each with why. */
export const CENSUS_WAIVERS_BY_GROUP = Object.freeze({ 'magic-prompts': MAGIC_PROMPTS_CENSUS, 'session-folders': SESSION_FOLDERS_CENSUS });
/** Each group's declared write errors: the errors a write call can meet in a data-root state (census `error` items). */
export const CENSUS_ERRORS_BY_GROUP = Object.freeze({ 'magic-prompts': MAGIC_PROMPTS_ERRORS, 'session-folders': SESSION_FOLDERS_ERRORS });

/** The limit printed when --scenario chose some of the group's scenarios: the census needs all of them. */
export const CENSUS_PARTIAL_LIMIT = Object.freeze({
  name: 'census-not-judged',
  text: 'the census judges the whole group only: with --scenario choosing some of its scenarios, items the others exercise would be gaps, so nothing is said about coverage and the run is incomplete (exit 2, "not judged: census" on the last line)',
});

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
/** A group file as an absolute path: repository-relative, or absolute already (a copy in a test's scratch). */
const groupFile = (file) => path.resolve(REPOSITORY_ROOT, file);
const realOf = (file) => { try { return fs.realpathSync(file); } catch { return file; } };
const dependencyNames = (group) => { try { return Object.keys(group.dependencies({ dataRoot: path.sep, hub: () => () => {}, factories: {}, absent: {}, stubs: {} })); } catch { return []; } };

/**
 * The steps of a recording whose tree changed (rule last-writer's reading, edge
 * and start-up files apart): a write call counts only through one of them.
 */
export function touchedSteps(recording, declarations = {}) {
  const edgeFiles = new Set([...(declarations.edgeFiles ?? []), ...(recording.edgeFiles ?? [])]);
  const startupFiles = new Set(declarations.startupFiles ?? []);
  const { touched } = writersOf(recording, (entryName, entry, which) => (which === 'startup' ? startupFiles.has(entryName) : entry?.edge === true || edgeFiles.has(entryName)));
  return [...touched].filter(([, paths]) => paths.size > 0).map(([step]) => step);
}

/**
 * The census input of a group from its reference recordings and judged rows
 * (`rows` with `waived`, as judgeRun returns them): the items read from the
 * group's files now (and what the reading could not read), the routes their
 * source registers, the principal classes, the group's census waivers and
 * declared write errors, the steps of each recording that changed its tree,
 * and the digests of the files read.
 */
export function censusInput({ name, group, recordings, rows, waivers = CENSUS_WAIVERS_BY_GROUP[name] ?? {}, errors = CENSUS_ERRORS_BY_GROUP[name] ?? [] }) {
  const files = group.files.map(groupFile);
  // Item ids name files from the group's own directory (the common parent of its files), so they read as the registrar's neighbours.
  const root = files.map(path.dirname).reduce((common, dir) => { while (!`${dir}${path.sep}`.startsWith(`${common}${path.sep}`)) common = path.dirname(common); return common; });
  const { items, routes, problems } = groupItems({ files, dependencies: dependencyNames(group), root, outside: (group.outsideModules ?? []).map(groupFile) });
  for (const item of items) item.realFile = realOf(item.file);
  const principals = Object.entries(PRINCIPALS).map(([principal, entry]) => ({ name: principal, class: entry.class }));
  const declarations = DECLARATIONS[name] ?? null;
  const withTouched = recordings.map((entry) => ({ ...entry, touched: entry.touched ?? touchedSteps(entry.recording, declarations ?? {}) }));
  return { group: name, items, routes, recordings: withTouched, rows, waivers, errors, principals, declarations, sourceProblems: problems, sources: Object.fromEntries(group.files.map((file) => [file, digest(groupFile(file))])) };
}

/**
 * runMain's produceRows: `{ rows, waivers, gaps }` for `name`'s scenarios
 * (those named by --scenario, or all). Each arm's recording is written to
 * `recordings/<scenario>/<arm>.json` in the run (scratch only, never kept
 * unless the run is). A group without scenarios produces no rows; an unknown
 * --scenario id is a census gap. With every scenario run, the census judges
 * the group (`census.json` in the run): each gap and problem is a census gap.
 */
export async function produceScenarioRows({ run, group, name, options = {}, log = () => {}, limits, scenarios = SCENARIOS_BY_GROUP[name] ?? [], censusWaivers = CENSUS_WAIVERS_BY_GROUP[name] ?? {}, censusErrors = CENSUS_ERRORS_BY_GROUP[name] ?? [], closure = runClosure, candidates = CANDIDATE_COMMANDS }) {
  // A named candidate is judged in place of J (J still runs: the closure check needs it).
  const candidateCommand = options.candidate ? candidates[name]?.[options.candidate]?.() ?? null : null;
  const candidateLabel = options.candidate ? `candidate-${options.candidate}` : 'candidate';
  const judgedArm = options.candidate ? `the ${options.candidate} candidate (C)` : 'the JavaScript candidate adapter (J)';
  const asked = options.scenarios ?? [];
  const gaps = asked.filter((id) => !scenarios.some((scenario) => scenario.id === id)).map((id) => `--scenario=${id} names no scenario of group ${name}`);
  const chosen = asked.length ? scenarios.filter((scenario) => asked.includes(scenario.id)) : scenarios;
  const rows = [];
  const waivers = {};
  const references = [];
  let observedExchanges = 0;
  for (const scenario of chosen) {
    const { rows: produced, recordings } = await closure({ run, scenario, name, group, limits, ...(candidateCommand ? { candidateCommand, candidateLabel } : {}) });
    references.push({ scenario: scenario.id, recording: recordings.reference });
    // The candidate arms' exchanges, each observed from outside under the named limit (observe.mjs).
    for (const key of ['js', 'candidate']) observedExchanges += recordings[key]?.observation?.exchanges ?? 0;
    const counts = {};
    for (const row of produced) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
    log(`compared ${scenario.id}: ${produced.length} rows (R, R' and J${candidateCommand ? ', judged on C' : ''}): ${Object.entries(counts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')}`);
    // Rule W's Date lag, as measured on this scenario's references (driver.mjs groupCoverage): the bound a candidate's Date is held to.
    const lagOf = (recording) => `${dateLagOf(recording)} ms (heads ${recording?.dateLag?.heads ?? 0}, timer ${recording?.dateLag?.timer ?? 0})`;
    log(`date lag ${scenario.id}: R ${lagOf(recordings.reference)}, R' ${lagOf(recordings.second)}`);
    rows.push(...produced.map(({ id, outcome, reason, checks, differences, inconclusive, nondeterministic, judged, whole }) => ({ id, outcome, reason, checks, differences: [...differences, ...inconclusive.map((line) => `(inconclusive) ${line}`)], nondeterministic, judged, whole })));
    for (const [stepId, waiver] of Object.entries(scenario.waivers ?? {})) waivers[`${scenario.id}/${stepId}`] = waiver;
  }
  const runLimits = [{ ...CANDIDATE_EFFECT_LIMIT, count: observedExchanges, unit: 'candidate exchanges' }];
  const unjudged = [];
  if (chosen.length < scenarios.length) { runLimits.push({ ...CENSUS_PARTIAL_LIMIT, count: chosen.length, unit: `of ${scenarios.length} scenarios run` }); unjudged.push('census'); }
  else if (chosen.length) {
    const judgedRows = judgeRun({ rows, waivers }).rows;
    const census = judgeCensus(censusInput({ name, group, recordings: references, rows: judgedRows, waivers: censusWaivers, errors: censusErrors }));
    run.writeFile('census.json', `${JSON.stringify({ judgedArm, ...census }, null, 1)}\n`);
    for (const line of censusLines(census)) log(line);
    // An item counts as exercised only through a row that passed on the judged arm.
    log(`census judged on ${judgedArm}: an exercised item's rows passed on it`);
    gaps.push(...census.gaps, ...census.problems.map((problem) => `${name}: census problem: ${problem}`));
  }
  return { rows, waivers, gaps, limits: runLimits, unjudged };
}
