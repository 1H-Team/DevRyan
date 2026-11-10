// Loaded before any test in a test process: the Bun `preload` of every
// bunfig.toml in this repository, and `node --import` for node:test runs
// (scripts/test-scripts.mjs, scripts/test-electron.mjs, the startup contract).
//
// The common case is cheap: a process a runner started carries the guard's
// marker, and the check (scripts/test-isolation-check.mjs) reads it and returns.
// A Node process started without it (`node --import=… --test file`) builds the
// private environment in-process now, before any test or product module loads,
// because Node's os.homedir() follows HOME on every call. A Bun process cannot
// be moved after it started and its preload cannot see the command line to run
// it again, so it stops here with the command that works.
import { ISOLATION_ROOT_VARIABLE, isolationProblems, refusalMessage } from './test-isolation-check.mjs';

const refuse = (problems) => {
  process.stderr.write(`\n${refusalMessage(problems)}\n\n`);
  process.exit(1);
};

let problems = isolationProblems();
if (problems.length && !process.versions.bun && process.env[ISOLATION_ROOT_VARIABLE] === undefined) {
  const { isolateCurrentProcess } = await import('./test-isolation-guard.mjs');
  isolateCurrentProcess();
  problems = isolationProblems();
}
if (problems.length) refuse(problems);
