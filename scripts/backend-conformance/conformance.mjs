#!/usr/bin/env node
// The backend route-group conformance run (docs/TESTING.md, "Backend
// route-group conformance harness"; design file 31).
//
//   node scripts/test-isolation-guard.mjs node scripts/backend-conformance/conformance.mjs --group=<name>
//       [--scenario=<id>,...] [--allow-inconclusive=<row>,...] [--keep-artifacts]
//
// BH0 to BH4 exist: the run root, the outcomes and exit codes, the report,
// the composition check (the server's composition text against the table,
// the census's reach and layer stack, the edge probes), the group host, the
// tap, the scenario driver, the comparer and the closure check: every
// scenario of the group runs on the reference, on a second reference on a
// fresh data root and on the JavaScript candidate adapter (closure.mjs), and
// each step's row is judged from the comparisons (compare.mjs).
// Exit codes (outcomes.mjs): 0 every row passed or waived and one passed;
// 1 a failed row; 2 anything else not waived, a composition drift, or no
// rows; 64 refused (usage, outside the isolation guard, an output path).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMain } from './conformance-run.mjs';
import { checkComposition } from './composition-drift.mjs';
import { interruptTeardown } from './driver.mjs';
import { produceScenarioRows } from './scenario-rows.mjs';

export const main = (options = {}) => runMain({ checkComposition, produceRows: (context) => produceScenarioRows(context), onInterrupt: interruptTeardown, ...options });

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
  process.exit();
}
