// The rows of a harness run (BH2): every scenario of the group, run against the
// reference arm, recorded into the run's scratch and turned into rows. With no
// comparer (BH3) and no closure check (BH4) every recorded row is inconclusive,
// awaiting comparison, so a run exits 2 with rows; nothing here passes a row.
import { referenceArm } from './arms.mjs';
import { recordingJson, rowsFromRecording, runScenario } from './driver.mjs';
import { SCENARIOS as MAGIC_PROMPTS } from './scenarios/magic-prompts.mjs';

/** The scenarios of each group the harness has scenarios for. */
export const SCENARIOS_BY_GROUP = Object.freeze({ 'magic-prompts': MAGIC_PROMPTS });

/**
 * runMain's produceRows: `{ rows, waivers }` for `name`'s scenarios (those
 * named by --scenario, or all). Each recording is written to
 * `recordings/<scenario>/reference.json` in the run (scratch only, never kept
 * unless the run is). A group without scenarios produces no rows; an unknown
 * --scenario id is a census gap.
 */
export async function produceScenarioRows({ run, group, name, options = {}, log = () => {}, limits, scenarios = SCENARIOS_BY_GROUP[name] ?? [] }) {
  const asked = options.scenarios ?? [];
  const gaps = asked.filter((id) => !scenarios.some((scenario) => scenario.id === id)).map((id) => `--scenario=${id} names no scenario of group ${name}`);
  const chosen = asked.length ? scenarios.filter((scenario) => asked.includes(scenario.id)) : scenarios;
  const rows = [];
  const waivers = {};
  for (const scenario of chosen) {
    const label = `scenarios/${scenario.id}`;
    const arm = referenceArm({ run, name, group, label: `${label}/reference` });
    const recording = await runScenario({ scenario, arm, run, label: `${label}/reference`, limits });
    run.writeFile(`recordings/${scenario.id}/reference.json`, recordingJson(recording));
    const produced = rowsFromRecording(recording);
    log(`recorded ${scenario.id}: ${produced.length} rows on the reference arm`);
    rows.push(...produced);
    for (const [stepId, waiver] of Object.entries(scenario.waivers ?? {})) waivers[`${scenario.id}/${stepId}`] = waiver;
  }
  return { rows, waivers, gaps };
}
