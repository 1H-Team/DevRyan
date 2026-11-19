#!/usr/bin/env node
// A driver run that waits to be interrupted (BH2 self-test only): an arm on a
// scenario, inside a run root whose interrupt handler is the driver's
// teardown. It prints one line when it is where the test wants it:
//   node toy/driver-child.mjs hang [--arm=fake|reference]      the never-answered request is in flight (fake),
//                                                              or the first request is answered (reference)
//   node toy/driver-child.mjs frozen [--arm=fake|reference]    the arm is frozen for the first S1
//   node toy/driver-child.mjs restart [--arm=fake|reference]   the restarted arm is frozen for its first snapshot
//   [--parent=<dir>] puts the run in a private parent of the test's own (no other run sweeps it)
//   {"waiting":{"pgid":<arm group>,"run":<run dir>,"log":<fake call log>,"held":<descriptors held>,"keeper":<keeper pid>}}
// and, before it, {"started":{"pgid":<arm group>,"keeper":<pid>}} for every arm process it starts (a failed test kills them).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateArm, referenceArm } from '../arms.mjs';
import { keeperPid } from '../arm-groups.mjs';
import { GROUPS } from '../groups.mjs';
import { heldDescriptorCount } from '../tree.mjs';
import { interruptTeardown, runScenario } from '../driver.mjs';
import { createBackendRun } from '../run-scratch.mjs';
import { RESTARTS, WRITE_LOCK } from '../scenarios/magic-prompts.mjs';
import { HANG, RESTART_HOLD } from './toy-scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const flags = Object.fromEntries(process.argv.slice(3).map((argument) => /^--(arm|parent)=(.+)$/.exec(argument)?.slice(1) ?? ['bad', argument]));
const armKind = flags.arm ?? 'fake';
if (!['hang', 'frozen', 'restart'].includes(mode) || !['fake', 'reference'].includes(armKind) || flags.bad) { process.stderr.write('usage: driver-child.mjs <hang|frozen|restart> [--arm=fake|reference] [--parent=<dir>]\n'); process.exit(64); }
const run = createBackendRun({ owner: 'backend-conformance-driver-child', onInterrupt: interruptTeardown, ...(flags.parent ? { parent: flags.parent } : {}) });
const log = path.join(run.dir, 'calls.ndjson');
const arm = armKind === 'fake'
  ? candidateArm({ command: [process.execPath, path.join(HERE, 'fake-candidate.mjs')], label: 'fake', env: { ...process.env, FAKE_CANDIDATE_LOG: log } })
  : referenceArm({ run, name: 'magic-prompts', group: GROUPS['magic-prompts'], label: 'reference' });
const scenario = armKind === 'fake' ? (mode === 'restart' ? RESTART_HOLD : HANG) : (mode === 'restart' ? RESTARTS : WRITE_LOCK);
const announce = (ctx) => process.stdout.write(`${JSON.stringify({ waiting: { pgid: ctx.proc.pgid, run: run.dir, log, held: heldDescriptorCount(), keeper: keeperPid() } })}\n`);
const forever = () => new Promise(() => {});
await runScenario({
  scenario, arm, run, label: armKind, limits: { exchangeMs: 600_000 },
  hooks: {
    afterStart: ({ proc }) => { process.stdout.write(`${JSON.stringify({ started: { pgid: proc.pgid, keeper: keeperPid() } })}\n`); },
    beforeStep: async ({ ctx, step }) => {
      if (mode !== 'hang') return;
      // The fake: the never-answered request is about to go out. The reference: its second step is next (one exchange done).
      if ((armKind === 'fake' && step.id === 'hang') || (armKind === 'reference' && ctx.seq === 1)) { announce(ctx); if (armKind === 'reference') await forever(); }
    },
    afterFreeze: async ({ ctx, what }) => {
      if ((mode === 'frozen' && what === 'S1') || (mode === 'restart' && what === 'started' && ctx.starts === 2)) { announce(ctx); await forever(); }
    },
  },
});
run.finish('failed');
