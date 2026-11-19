#!/usr/bin/env node
// Harmlessness of the tap (BH1; design file 31 §10 risk 2): the product tests
// the tap can affect must pass identically with and without it. Pass-set
// parity, judged by the client harness's own parity judge (`judgeParity`,
// `outputLines` from scripts/client-conformance/parity.mjs), on Vitest runs
// of packages/web: each set runs twice plainly and once with the tap preloaded
// into every Vitest process (NODE_OPTIONS=--import, servers "all"), and
//   - every test's outcome must be the same, and every printed line (stdout,
//     and each test's system-out/system-err in the junit report) must be the
//     same, except lines whose shape already differed between the two plain
//     runs (parity.mjs's rule; counted and printed);
//   - the tap must have run: it wrote a record file, and for a set that says
//     so, it wrapped group handlers that tests then called. A tapped run in
//     which the tap never armed proves nothing and is inconclusive.
//
//   node --import=./scripts/test-isolation-preload.mjs scripts/backend-conformance/harmlessness.mjs [--set=<name>,...] [--keep-artifacts]
//
// Exit 0 when every set holds; 1 on a difference; 2 when a run is
// inconclusive; 64 refused (usage, outside isolation).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputLines } from '../client-conformance/parity.mjs';
import { harmlessnessVerdict, parseVitestJunit, printed } from './harmlessness-judge.mjs';

export { harmlessnessVerdict, learnVaryingSpans, maskVaryingSpans, parseVitestJunit } from './harmlessness-judge.mjs';
import { RunRefused, createBackendRun, isolationRefusal } from './run-scratch.mjs';
import { REPOSITORY_ROOT, SERVER_REQUIRE_BASE } from './edge.mjs';
import { TAP_SETUP_VARIABLE } from './tap.mjs';
import { readTapRecords } from './host-launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(REPOSITORY_ROOT, 'packages/web');
const SERVER = 'packages/web/server';
export const EXIT = Object.freeze({ holds: 0, differs: 1, inconclusive: 2, refused: 64 });

/**
 * The test sets. `groupFiles` configure the tap as for a group host; `wraps`
 * says whether the set's tests drive the group's handlers through a real
 * Express app (so the tap must have wrapped some), with the reason when not.
 */
export const SETS = Object.freeze({
  'magic-prompts': Object.freeze({
    groupFiles: ['lib/magic-prompts/routes.js', 'lib/magic-prompts/runtime.js'],
    // The pilot's own test, the route census that registers it, the policy that decides it, and the edge layers the host composes.
    tests: ['lib/magic-prompts/runtime.test.js', 'lib/multi-user/route-policy-coverage.test.js', 'lib/multi-user/policy.test.js', 'lib/opencode/core-routes.test.js', 'lib/opencode/bootstrap-runtime.test.js', 'lib/multi-user/local-owner-bootstrap.test.js'],
    wraps: false,
    whyNotWrapped: 'no existing test registers the pilot routes on a real Express app (design file 31 section 4.1: zero HTTP exchanges); the census registers them on a recording app',
  }),
  registrars: Object.freeze({
    groupFiles: ['lib/processes/routes.js', 'lib/opencode/global-agents-md-routes.js'],
    // Registrar tests that serve real requests through Express and supertest, so the tap wraps and observes them.
    tests: ['lib/processes/routes.test.js', 'lib/opencode/global-agents-md-routes.test.js'],
    wraps: true,
  }),
});

const vitestBin = () => path.join(path.dirname(createRequire(path.join(WEB, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');

function runVitest({ files, junit, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestBin(), 'run', ...files, '--reporter=junit', `--outputFile=${junit}`], { cwd: WEB, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code, signal) => {
      let tests = [];
      try { tests = parseVitestJunit(fs.readFileSync(junit, 'utf8')); } catch { /* no report: no tests, reported as incomplete */ }
      resolve({ code, signal, output, tests });
    });
  });
}

/** Runs one set: two plain runs and one tapped run, then the verdict. */
export async function runSet({ run, name, set }) {
  const files = set.tests.map((file) => `${SERVER.slice('packages/web/'.length)}/${file}`);
  const expectedFiles = [...files];
  const plain = [];
  // The junit files differ only by a digit, so the "report written to" line varies by shape alone.
  for (const index of [1, 2]) plain.push(await runVitest({ files, junit: path.join(run.makeDirectory(`${name}/run-${index}`), 'report.xml'), env: process.env }));
  const outDir = run.makeDirectory(`${name}/run-3/tap`);
  const setup = run.writeFile(`${name}/tap-setup.json`, JSON.stringify({
    v: 1, outDir, group: `harmlessness-${name}`, servers: 'all', expressFrom: SERVER_REQUIRE_BASE, declaredBackground: [],
    groupFiles: set.groupFiles.map((file) => path.join(REPOSITORY_ROOT, SERVER, file)),
  }));
  const tapImport = `--import=${pathToFileURL(path.join(HERE, 'tap.mjs')).href}`;
  const env = { ...process.env, [TAP_SETUP_VARIABLE]: setup, NODE_OPTIONS: [process.env.NODE_OPTIONS, tapImport].filter(Boolean).join(' ') };
  const tapped = await runVitest({ files, junit: path.join(path.dirname(outDir), 'report.xml'), env });
  const tapFiles = fs.readdirSync(outDir).filter((file) => file.endsWith('.ndjson'));
  const records = tapFiles.flatMap((file) => readTapRecords(path.join(outDir, file)));
  tapped.tapFiles = tapFiles.length;
  tapped.tapProcesses = records.filter((record) => record.type === 'tap').length;
  tapped.wrapped = records.filter((record) => record.type === 'exchange' && record.kind === 'group').length;
  tapped.groupRegistrations = records.filter((record) => record.type === 'registration' && record.group).length;
  tapped.exchanges = records.filter((record) => record.type === 'exchange').length;
  const verdict = harmlessnessVerdict({ plain, tapped, expectedFiles, wraps: set.wraps });
  const count = (runResult, status) => runResult.tests.filter((test) => test.status === status).length;
  return { name, files: files.length, tests: plain[0].tests.length, plainPassed: plain.map((runResult) => count(runResult, 'passed')), tappedPassed: count(tapped, 'passed'),
    exits: [...plain.map((runResult) => runResult.code), tapped.code], tap: { files: tapped.tapFiles, processes: tapped.tapProcesses, groupRegistrations: tapped.groupRegistrations, exchanges: tapped.exchanges, groupExchanges: tapped.wrapped },
    outputLines: outputLines(printed(plain[0])).length, ...verdict };
}

async function main(argv = process.argv.slice(2)) {
  const refusal = isolationRefusal();
  if (refusal) { process.stderr.write(`harmlessness: ${refusal}\n`); return EXIT.refused; }
  let names = Object.keys(SETS);
  for (const argument of argv) {
    if (argument === '--keep-artifacts') continue;
    const match = /^--set=(.+)$/.exec(argument);
    if (!match) { process.stderr.write(`harmlessness: unknown option ${argument}\n`); return EXIT.refused; }
    names = match[1].split(',');
    const unknown = names.filter((name) => !Object.hasOwn(SETS, name));
    if (unknown.length) { process.stderr.write(`harmlessness: unknown set ${unknown.join(', ')} (known: ${Object.keys(SETS).join(', ')})\n`); return EXIT.refused; }
  }
  let run;
  try { run = createBackendRun({ owner: 'backend-conformance-harmlessness', keepArtifacts: argv.includes('--keep-artifacts') }); } catch (error) {
    if (error instanceof RunRefused) { process.stderr.write(`harmlessness: ${error.message}\n`); return EXIT.refused; }
    throw error;
  }
  let exit = EXIT.inconclusive;
  try {
    let differences = 0;
    let incomplete = 0;
    for (const name of names) {
      const result = await runSet({ run, name, set: SETS[name] });
      differences += result.differences.length;
      incomplete += result.incomplete.length;
      console.log(`set ${name}: ${result.files} files, ${result.tests} tests; passed ${result.plainPassed.join(' and ')} plain, ${result.tappedPassed} tapped; exits ${result.exits.join(', ')}; tap: ${result.tap.files} record files from ${result.tap.processes} processes, ${result.tap.groupRegistrations} group registrations, ${result.tap.exchanges} exchanges (${result.tap.groupExchanges} through group handlers); ${result.outputLines} output lines, ${result.masked} left out as varying between plain runs (${result.varying.length} shapes); ${result.differences.length} differences, ${result.incomplete.length} inconclusive`);
      if (!SETS[name].wraps) console.log(`  group handlers not expected to run: ${SETS[name].whyNotWrapped}`);
      for (const shape of result.varying) console.log(`  varies without the tap: ${shape}`);
      for (const span of result.spans) console.log(`  a word varies without the tap (${result.spanMasked} lines in all runs): ${span.prefix}\u00abvaries\u00bb${span.suffix}`);
      for (const difference of result.differences) console.log(difference.test ? `  differs (${difference.check}): ${difference.test} (plain ${difference.baseline}, tapped ${difference.recorded})` : `  differs (${difference.check}): ${difference.detail}`);
      for (const entry of result.incomplete) console.log(`  inconclusive (${entry.check})${entry.file ? ` ${entry.file}` : ''}: ${entry.detail}`);
    }
    // A difference is a failure whatever else is inconclusive.
    exit = differences ? EXIT.differs : incomplete ? EXIT.inconclusive : EXIT.holds;
    console.log(`tap harmlessness ${exit === EXIT.holds ? `holds on ${names.length} sets` : exit === EXIT.differs ? 'FAILED' : 'INCONCLUSIVE'}: ${differences} differences, ${incomplete} inconclusive`);
    return exit;
  } finally {
    run.finish(exit === EXIT.holds ? 'passed' : 'failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
