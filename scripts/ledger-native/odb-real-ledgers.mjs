// The native object database on the ledgers the product writes (plan
// package L3a, "real ledgers"): the aged-profile corpus (written by
// aged-writer.mjs in a child process), and every scenario of the ledger
// dual-run harness recorded once through the product host (its run A). Every
// ledger repository they leave is read by Git and by the Rust probe, as
// written, after `repack -d` and after `repack -a -d` (odb-oracle.mjs). It is
// part of the extended run, outside the gate:
//
//   node scripts/build-ledger-native.mjs --extended
//
// Started alone (with the isolation preload) it builds the probe itself
// unless LEDGER_NATIVE_ODB_PROBE names one, and
// LEDGER_NATIVE_ODB_SCENARIOS=<name>,<name> narrows the dual-run scenarios
// (the extended run refuses that variable).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProbe, EXTENDED_VARIABLE, ODB_PROBE_VARIABLE } from '../build-ledger-native.mjs';
import { createWorkspace, dualRun } from '../ledger-dual-run/dual-run.mjs';
import { SCENARIOS } from '../ledger-dual-run/dual-run-scenarios.mjs';
import { COVERAGE_SCENARIOS } from '../ledger-dual-run/dual-run-scenarios-coverage.mjs';
import { scratchParent } from '../qa/run-root.mjs';
import { compareRepository } from './odb-oracle.mjs';
import { gitEnvironment, gitVersion, runGit } from './odb-repos.mjs';

let probe = process.env[ODB_PROBE_VARIABLE];
let disposeProbe = () => {};
const parent = scratchParent('ledger-native');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(path.join(parent, 'odb-ledgers-'));
const env = gitEnvironment(path.join(scratch, 'git-home'));
const workspace = createWorkspace({ keepArtifacts: false, owner: 'ledger-native-odb' });
let failed = false;
const cleanup = () => { rmSync(scratch, { recursive: true, force: true }); workspace.finish(failed ? 'failed' : 'passed'); };
const interrupted = (signal) => { failed = true; cleanup(); disposeProbe(); process.exit(signal === 'SIGINT' ? 130 : 143); };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
before(() => {
  console.log(`Git: ${gitVersion(env)}`);
  if (!probe) ({ odbProbe: probe, dispose: disposeProbe } = buildProbe());
  assert.ok(existsSync(probe), `${ODB_PROBE_VARIABLE}=${probe} does not exist`);
});
after(() => { cleanup(); disposeProbe(); });

/** Every ledger repository under a parked run: `<storage>/<root>/git`. */
function ledgersIn(dir) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > 4 || !existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === 'git' && existsSync(path.join(child, 'HEAD')) && existsSync(path.join(child, 'objects'))) found.push(child);
      else if (!['views', 'view-standby', 'objects', 'project', 'home', 'tmp'].includes(entry.name)) walk(child, depth + 1);
    }
  };
  walk(dir, 0);
  return found.sort();
}

const selected = process.env.LEDGER_NATIVE_ODB_SCENARIOS?.split(',').filter(Boolean);
if (selected && process.env[EXTENDED_VARIABLE] === '1') throw new Error('The extended run reads every scenario; unset LEDGER_NATIVE_ODB_SCENARIOS');
const scenarios = [...SCENARIOS, ...COVERAGE_SCENARIOS].filter((scenario) => !selected || selected.includes(scenario.name));
if (selected) assert.equal(scenarios.length, selected.length, `unknown scenario among ${selected.join(', ')}`);

const AGED_WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ledger-dual-run', 'aged-writer.mjs');
/** The last `limit` characters of a child's output, for a failure message. */
const tail = (text, limit = 4000) => (text && text.length > limit ? `…${text.slice(-limit)}` : text || '(nothing)');

describe('the aged-profile corpus, read by Git and by the Rust', () => {
  test('every ledger repository the product\'s writers leave, as written and after repack -d and repack -a -d', () => {
    const stage = mkdtempSync(path.join(scratch, 'aged-'));
    const home = path.join(stage, 'home');
    mkdirSync(path.join(stage, 'tmp'), { recursive: true });
    const writerEnv = {};
    for (const [name, value] of Object.entries(env)) if (!/^(DEVRYAN|OPENCHAMBER|OPENCODE|LEDGER_DUAL_RUN)_/.test(name)) writerEnv[name] = value;
    Object.assign(writerEnv, { HOME: home, TMPDIR: path.join(stage, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), DEVRYAN_LEDGER_WORKER: '0' });
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Ledger Tests\n\temail = tests@devryan.invalid\n');
    const started = Date.now();
    const written = spawnSync(process.execPath, [AGED_WRITER, stage], { env: writerEnv, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 26 });
    // A writer that dies says how: its exit code, the signal, a spawn error (ETIMEDOUT after the timeout) and the end of both streams.
    assert.ok(!written.error && written.status === 0, [`aged writer failed after ${Date.now() - started} ms: exit code ${written.status}, signal ${written.signal}`,
      `error: ${written.error?.message ?? '(none)'}`, `stdout: ${tail(written.stdout)}`, `stderr: ${tail(written.stderr)}`].join('\n'));
    const storage = path.join(stage, 'webdata/harness/session-mutations');
    const ledgers = readdirSync(storage).map((name) => path.join(storage, name, 'git')).filter((dir) => existsSync(path.join(dir, 'HEAD')));
    assert.ok(ledgers.length >= 1, 'the corpus holds a ledger');
    const totals = { ledgers: 0, objects: 0, names: 0, listings: 0, refs: 0 };
    for (const ledger of ledgers) {
      for (const [label, repack] of [['as written', null], ['repack -d', ['repack', '-d', '-q']], ['repack -a -d', ['repack', '-a', '-d', '-q']]]) {
        if (repack) runGit(env, ledger, repack);
        const { counts, differences } = compareRepository({ env, gitDir: ledger, probe, probeEnv: env, treeLimit: 15, prefixTrees: 3 });
        assert.deepEqual(differences, [], `${path.basename(path.dirname(ledger))} ${label}`);
        totals.ledgers += 1;
        for (const key of ['objects', 'names', 'listings', 'refs']) totals[key] += counts[key];
      }
    }
    console.log(`  aged corpus: ${JSON.stringify(totals)}`);
  });
});

describe('every ledger the dual-run scenarios write, read by Git and by the Rust', () => {
  const totals = { scenarios: 0, ledgers: 0, objects: 0, names: 0, listings: 0, refs: 0 };
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      try {
        const outcome = await dualRun({ workspace, scenario, implementations: [] });
        const ledgers = ledgersIn(outcome.dirA);
        assert.ok(ledgers.length >= 1, `${scenario.name} left no ledger repository`);
        for (const ledger of ledgers) {
          const copy = path.join(mkdtempSync(path.join(scratch, `${scenario.name}-`)), 'git');
          cpSync(ledger, copy, { recursive: true });
          for (const [label, repack] of [['as written', null], ['repack -d', ['repack', '-d', '-q']], ['repack -a -d', ['repack', '-a', '-d', '-q']]]) {
            if (repack) runGit(env, copy, repack);
            const { counts, differences } = compareRepository({ env, gitDir: copy, probe, probeEnv: env, treeLimit: 40, prefixTrees: 6 });
            assert.deepEqual(differences, [], `${scenario.name}: ${path.relative(outcome.dirA, ledger)} ${label}`);
            totals.ledgers += 1;
            for (const key of ['objects', 'names', 'listings', 'refs']) totals[key] += counts[key];
          }
        }
        totals.scenarios += 1;
        console.log(`  ${scenario.name}: ${ledgers.length} ledger(s); totals ${JSON.stringify(totals)}`);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  }
});
