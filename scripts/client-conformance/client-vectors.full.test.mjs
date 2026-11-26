// The client-engine vectors' answers regenerated (docs/TESTING.md,
// "Client-engine differential and vectors"), in the full suite: each ported family's
// TypeScript bundled and run under V8 (Electron's Node) on the tracked
// inputs, and the sort vectors regenerated under the same Node. INFORMATIONAL:
// a stale file is reported (a diagnostic naming the family and the first call
// answered otherwise, and the command that regenerates it) and the test
// passes, because nothing a change under packages/ui/src/sync triggers may
// block before the native client ships (the owner's GD11): a TypeScript change
// that changes a family's behaviour makes the Rust crate's cargo test over the
// tracked vectors fail only once the vectors are regenerated, which is the
// port's work, not the TypeScript author's. `node client-vectors.mjs --check`
// is the same comparison as a command that exits 1.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { REPOSITORY_ROOT } from './record.mjs';

test('the tracked client-engine vectors are still what the TypeScript answers under V8 (informational)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const ran = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts', 'client-conformance', 'client-vectors.mjs'), '--check'], { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 14 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  const said = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split('\n').filter((line) => /client vectors/.test(line)).join('\n');
  t.diagnostic(ran.status === 0 ? said : `INFORMATIONAL, not a failure (GD11): ${said || `client-vectors.mjs --check exited ${ran.status ?? ran.signal}`}`);
  const { referenceRuntime } = await import(path.join(REPOSITORY_ROOT, 'scripts', 'ledger-native', 'reference-runtime.mjs'));
  const runtime = referenceRuntime();
  const sort = spawnSync(runtime.command, [path.join(REPOSITORY_ROOT, 'packages', 'native', 'crates', 'client-engine', 'tests', 'generate-sort-vectors.mjs'), '--check', `--engine-label=V8 (${runtime.electron ? "Electron's Node" : 'this Node'})`], { cwd: REPOSITORY_ROOT, encoding: 'utf8', env: { ...process.env, ...runtime.env }, timeout: 5 * 60 * 1000 });
  t.diagnostic(`${sort.status === 0 ? '' : 'INFORMATIONAL, not a failure: '}${(sort.stdout ?? '').trim()}`);
});
