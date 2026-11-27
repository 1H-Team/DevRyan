// The scenario corpus as a bun test file: one test per scenario of
// scenarios.mjs (the large F1 sizes excepted), and one per crash point of
// the scenarios that ask for them (every save, durable and torn). Recorded
// under the recorder (recorder.mjs) it gives the scenarios' traces in the
// recorder's own format; run plainly it checks that every scenario runs.
// Settings: DEVRYAN_SCHEDULER_DRIVER_DRAIN (a drain mode of driver.mjs,
// default one), DEVRYAN_SCHEDULER_SCENARIOS (a comma list of test names to
// keep; default all). Each test also compares the run's facts with what its
// scenario states (scenario-facts.mjs) and fails on a difference.
import { test } from 'bun:test';
import { compareFacts, scenarioFacts, statedFacts } from './scenario-facts.mjs';
import { corpusTests, runScenario } from './scenarios.mjs';

const DRAIN = process.env.DEVRYAN_SCHEDULER_DRIVER_DRAIN || 'one';
const ONLY = process.env.DEVRYAN_SCHEDULER_SCENARIOS === undefined ? null : new Set(process.env.DEVRYAN_SCHEDULER_SCENARIOS.split(','));
// Generous: the work is virtual-time and deterministic, only its duration varies with the machine's load.
const TIMEOUT_MS = 600_000;

for (const entry of corpusTests()) {
  if (ONLY && !ONLY.has(entry.name)) continue;
  test(entry.name, async () => {
    const { driver } = await runScenario(entry.scenario, { drain: DRAIN, crash: entry.crash });
    const actual = scenarioFacts(driver);
    const differences = compareFacts(statedFacts(entry, actual), actual);
    if (differences.length) throw new Error(`${entry.name}: the facts differ from what the scenario states: ${differences.join('; ')}`);
  }, TIMEOUT_MS);
}
