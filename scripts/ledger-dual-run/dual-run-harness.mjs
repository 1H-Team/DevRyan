#!/usr/bin/env node
// The ledger dual-run harness, full run. See docs/TESTING.md, "Ledger dual-run harness".
//
//   node scripts/ledger-dual-run/dual-run-harness.mjs [--scenario=a,b] [--implementation=worker,process,native:<path>[,native-unseeded:<path>]]
//       [--suite=scenarios,cross-read,aged,mutants,crash,contention] [--allow-inconclusive=<scenario>,...] [--json=<file>] [--keep-artifacts]
//
// Every row ends passed, failed, inconclusive or info. Exit status: 0 when
// nothing failed and nothing was inconclusive (an inconclusive row of a
// scenario named in --allow-inconclusive is shown and counted, not fatal);
// 1 when anything failed; 2 when nothing failed but a row was inconclusive.
// The last line gives the counts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspace } from './dual-run.mjs';
import { runSuites, SUITES } from './dual-run-suites.mjs';

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
export function parseImplementations(text = 'worker,process') {
  return text.split(',').filter(Boolean).map((item) => {
    if (item === 'worker') return { name: 'js-worker', endpoint: { kind: 'worker' } };
    if (item === 'process') return { name: 'js-process', endpoint: { kind: 'process' } };
    // A native ledger that implements the identifier protocol (dual-run-ids.cjs) is compared seeded; `native-unseeded:` one that does not.
    if (item.startsWith('native:')) return { name: `native:${path.basename(item.slice(7))}`, endpoint: { kind: 'process', command: path.resolve(item.slice(7)), args: [] } };
    if (item.startsWith('native-unseeded:')) return { name: `native-unseeded:${path.basename(item.slice(16))}`, endpoint: { kind: 'process', command: path.resolve(item.slice(16)), args: [] }, ids: null };
    throw new TypeError(`unknown implementation ${item}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The run never reads the owner's home, Git configuration or hooks: the
  // process moves itself into a private environment before anything runs.
  const { ISOLATION_ROOT_VARIABLE } = await import('../test-isolation-check.mjs');
  if (!process.versions.bun && process.env[ISOLATION_ROOT_VARIABLE] === undefined) {
    const { isolateCurrentProcess } = await import('../test-isolation-guard.mjs');
    isolateCurrentProcess();
  }
  const workspace = createWorkspace({ keepArtifacts: process.argv.includes('--keep-artifacts') });
  let status = 'failed';
  try {
    const report = await runSuites({ workspace, suites: (option('suite') ?? SUITES.join(',')).split(','), scenarios: option('scenario')?.split(','),
      implementations: parseImplementations(option('implementation')), allowInconclusive: (option('allow-inconclusive') ?? '').split(',').filter(Boolean),
      log: (line) => console.log(line) });
    if (option('json')) await fs.writeFile(option('json'), `${JSON.stringify(report, (key, value) => (key === 'run' ? undefined : value), 2)}\n`);
    const { passed, failed, inconclusive, info } = report.counts;
    const verdict = failed ? 'FAILED' : inconclusive && !report.passed ? 'INCONCLUSIVE' : 'passed';
    console.log(`ledger dual run: ${verdict} (${passed} passed, ${failed} failed, ${inconclusive} inconclusive${inconclusive && report.passed ? ' (allowed)' : ''}, ${info} info; ${report.coverage.summary})`);
    status = report.passed ? 'passed' : 'failed';
    process.exitCode = failed ? 1 : report.passed ? 0 : 2;
  } finally {
    workspace.finish(status);
  }
}
