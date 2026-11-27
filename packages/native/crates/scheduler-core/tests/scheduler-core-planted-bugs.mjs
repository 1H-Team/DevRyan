#!/usr/bin/env node
// Planted bugs in the Rust scheduler core: each entry changes one thing in the
// crate's Rust (a launch a job early or late, a save skipped or added, two
// inputs swapped, an await merged or split, a timer delay off by one, a retry
// timer added, object identity lost), and the scheduler conformance harness
// must report the named scenario `different` by the named replay check or
// comparer rule. The run copies the workspace's three crates and the ledger
// sources the JavaScript layer compiles by path into a private scratch folder
// under the OS temp dir (removed on success, failure and interruption;
// --keep-artifacts keeps it), records the scenarios once, builds the
// candidate (cargo on PATH, the pinned toolchain) unchanged and then once per
// bug, and replays the recording against each build. One cargo build or one
// replay at a time.
//
//   node packages/native/crates/scheduler-core/tests/scheduler-core-planted-bugs.mjs [--only <id>,...] [--keep-artifacts]
//
// Exit code 1 when a planted bug survives (or is caught by another check or in
// another scenario than the one named), when the unchanged build does not
// reproduce every scenario, or when a planting site no longer exists.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRoot, scratchParent } from '../../../../../scripts/qa/run-root.mjs';
import { recordQuick } from '../../../../../scripts/scheduler-conformance/closure.mjs';
import { runProcess } from '../../../../../scripts/scheduler-conformance/process-run.mjs';
import { prepareCopy } from '../../../../../scripts/scheduler-conformance/replay.mjs';
import { PLANT_SCENARIOS, PLANTED_BUGS, plantingProblems } from './scheduler-core-plants.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const NATIVE = path.join(REPOSITORY_ROOT, 'packages', 'native');
const CRATE = path.join(NATIVE, 'crates', 'scheduler-core');

export { PLANT_SCENARIOS, PLANTED_BUGS, plantingProblems };

/** Whether a plant run caught the bug where it is expected: the named scenario `different` by the named check or rule. */
export function judgePlant(results, expected) {
  const [scenario, check] = expected.split(':');
  const hit = results.find((result) => result.id.includes(` ${scenario} #`) && result.outcome === 'different');
  const named = Boolean(hit && (hit.check === check || hit.rule === check));
  const different = results.filter((result) => result.outcome === 'different').map((result) => `${/ (\S+(?: crash at save \d+ \w+)?) #\d+$/.exec(result.id)?.[1] ?? result.id}: ${result.check}${result.rule ? `/${result.rule}` : ''}`);
  return { caught: named, hit: hit ? `${hit.check}${hit.rule ? `/${hit.rule}` : ''} at #${hit.at}, comparer rules ${hit.compare?.rules?.join(',') || 'none'}` : null, different };
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(',')) : null;
  const problems = plantingProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'scheduler-core-planted-', owner: 'scheduler-core-planted-bugs' });
  let status = 'failed';
  try {
    const root = path.join(run.dir, 'repo');
    const workspace = path.join(root, 'packages', 'native');
    mkdirSync(path.join(workspace, 'crates'), { recursive: true });
    for (const file of ['Cargo.lock', 'rust-toolchain.toml']) cpSync(path.join(NATIVE, file), path.join(workspace, file));
    const manifest = readFileSync(path.join(NATIVE, 'Cargo.toml'), 'utf8').replace(/^members = \[[^\]]*\]/m, 'members = ["crates/js-layer", "crates/scheduler-policy", "crates/scheduler-core"]');
    writeFileSync(path.join(workspace, 'Cargo.toml'), manifest);
    for (const crate of ['js-layer', 'scheduler-policy']) cpSync(path.join(NATIVE, 'crates', crate), path.join(workspace, 'crates', crate), { recursive: true, filter: (source) => !source.includes(`${path.sep}tests${path.sep}vectors`) });
    for (const source of ['ledger-core/src/js', 'ledger/ledger-native/src/js.rs']) {
      cpSync(path.join(REPOSITORY_ROOT, 'packages', 'harness-runtime', 'native', source), path.join(root, 'packages', 'harness-runtime', 'native', source), { recursive: true });
    }
    const copy = path.join(workspace, 'crates', 'scheduler-core');
    cpSync(CRATE, copy, { recursive: true });
    const target = path.join(run.dir, 'target');
    const binary = path.join(target, 'debug', 'scheduler-candidate');
    const build = () => spawnSync('cargo', ['build', '--offline', '--quiet', '-p', 'devryan-scheduler-core', '--bin', 'scheduler-candidate'], { cwd: workspace, encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: target } });
    const baselineBuild = build();
    if (baselineBuild.status !== 0) throw new Error(`the unmodified copy does not build:\n${baselineBuild.stderr.slice(0, 3000)}`);
    const recorded = await recordQuick({ workDir: path.join(run.dir, 'record'), scenarios: [...PLANT_SCENARIOS] });
    if (recorded.problems.length || recorded.scenarios.length !== 1) throw new Error(`the scenarios did not record: ${recorded.problems.join('; ')}`);
    const copyDir = prepareCopy(run.dir);
    const replay = () => runProcess({ files: recorded.scenarios, copyDir, command: binary });
    const baseline = await replay();
    const unreproduced = baseline.filter((result) => result.outcome !== 'reproduced');
    if (baseline.length !== PLANT_SCENARIOS.length || unreproduced.length) throw new Error(`the unmodified build does not reproduce every plant scenario: ${unreproduced.map((result) => `${result.id}: ${result.outcome} ${result.detail ?? ''}`).join('; ') || `${baseline.length} cases`}`);
    console.log(`baseline: ${baseline.length} scenarios reproduced whole`);
    const survivors = [];
    let ran = 0;
    for (const [id, file, find, replacement, expected] of PLANTED_BUGS) {
      if (only && !only.has(id)) continue;
      ran += 1;
      const planted = path.join(copy, 'src', file);
      const original = readFileSync(planted, 'utf8');
      writeFileSync(planted, original.replace(find, () => replacement));
      let built;
      let results = [];
      try {
        built = build();
        if (built.status === 0) results = await replay();
      } finally {
        writeFileSync(planted, original);
      }
      if (built.status !== 0) throw new Error(`${id}: the planted copy does not build:\n${built.stderr.slice(0, 3000)}`);
      const judged = judgePlant(results, expected);
      console.log(`${judged.caught ? 'caught  ' : 'SURVIVED'} ${id} (expected ${expected}; ${judged.hit ? `${expected.split(':')[0]}: ${judged.hit}` : 'not different there'}; different: ${judged.different.join(', ') || 'none'})`);
      if (!judged.caught) survivors.push(id);
    }
    if (survivors.length) throw new Error(`planted bugs not caught where named: ${survivors.join(', ')}`);
    console.log(`Every planted bug is caught where named (${ran}).`);
    status = 'passed';
  } finally {
    run.finish(status);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
