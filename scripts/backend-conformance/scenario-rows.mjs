// The rows of a harness run (BH4): every scenario of the group through the
// closure check (closure.mjs): the reference (R), a second reference on a
// fresh data root (R') and the JavaScript candidate adapter (J), each
// recorded into the run's scratch, compared by the comparer (compare.mjs),
// and turned into one row per step plus one per scenario for what belongs to
// the whole recording (`<scenario>/recording`).
import { runClosure } from './closure.mjs';
import { CANDIDATE_EFFECT_LIMIT } from './observe.mjs';
import { SCENARIOS as MAGIC_PROMPTS } from './scenarios/magic-prompts.mjs';

/** The scenarios of each group the harness has scenarios for. */
export const SCENARIOS_BY_GROUP = Object.freeze({ 'magic-prompts': MAGIC_PROMPTS });

/**
 * runMain's produceRows: `{ rows, waivers, gaps }` for `name`'s scenarios
 * (those named by --scenario, or all). Each arm's recording is written to
 * `recordings/<scenario>/<arm>.json` in the run (scratch only, never kept
 * unless the run is). A group without scenarios produces no rows; an unknown
 * --scenario id is a census gap.
 */
export async function produceScenarioRows({ run, group, name, options = {}, log = () => {}, limits, scenarios = SCENARIOS_BY_GROUP[name] ?? [] }) {
  const asked = options.scenarios ?? [];
  const gaps = asked.filter((id) => !scenarios.some((scenario) => scenario.id === id)).map((id) => `--scenario=${id} names no scenario of group ${name}`);
  const chosen = asked.length ? scenarios.filter((scenario) => asked.includes(scenario.id)) : scenarios;
  const rows = [];
  const waivers = {};
  let observedExchanges = 0;
  for (const scenario of chosen) {
    const { rows: produced, recordings } = await runClosure({ run, scenario, name, group, limits });
    // The candidate arms' exchanges, each observed from outside under the named limit (observe.mjs).
    for (const key of ['js', 'candidate']) observedExchanges += recordings[key]?.observation?.exchanges ?? 0;
    const counts = {};
    for (const row of produced) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
    log(`compared ${scenario.id}: ${produced.length} rows (R, R' and J): ${Object.entries(counts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')}`);
    rows.push(...produced.map(({ id, outcome, reason, checks, differences, inconclusive, nondeterministic, judged, whole }) => ({ id, outcome, reason, checks, differences: [...differences, ...inconclusive.map((line) => `(inconclusive) ${line}`)], nondeterministic, judged, whole })));
    for (const [stepId, waiver] of Object.entries(scenario.waivers ?? {})) waivers[`${scenario.id}/${stepId}`] = waiver;
  }
  return { rows, waivers, gaps, limits: [{ ...CANDIDATE_EFFECT_LIMIT, count: observedExchanges, unit: 'candidate exchanges' }] };
}
