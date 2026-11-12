// Dual runs of the mutation ledger: record a scenario through the product
// host, replay it against one or more implementations on fresh twins of the
// fixture, and compare everything each run returned and left on disk.
//
// Every run executes at the same stage path (<run root>/stage), one after the
// other, and its stage is then moved aside to <run root>/runs/<name>, so
// absolute paths the ledger stores are the same in every run and need no
// normalisation. HOME, the XDG folders, TMPDIR and the Git configuration of
// each arm are inside the stage, and every arm's PATH starts with the git
// shim (dual-run-git-shim.mjs), which logs each run's ref moves.
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { auditNotes, commitSignature, compareIndexes, compareRefMoves, compareSnapshots, compareTraces, createDifferences, createMasker, refMoves } from './dual-run-compare.mjs';
import { cloneDirectory } from './dual-run-fixture.mjs';
import { installGitShim, readGitLog } from './dual-run-git-shim.mjs';
import { createIdentityMap } from './dual-run-identity.mjs';
import { decodeValue } from './dual-run-codec.mjs';
import { prepareStageHome, recordScenario, replayRecording, resultMessage } from './dual-run-runner.mjs';
import { captureSnapshot, readIndexFile, runGit } from './dual-run-snapshot.mjs';

/** The run root: `<os tmpdir>/devryan-ledger-dual-run/run-*`, removed on pass, failure and interruption unless artifacts are kept. */
export function createWorkspace({ keepArtifacts, owner = 'ledger-dual-run' } = {}) {
  const run = createRunRoot({ parent: scratchParent('ledger-dual-run'), owner, keepArtifacts });
  const bin = installGitShim(run.dir);
  return { dir: run.dir, bin, finish: (status) => run.finish(status), keep: run.keepArtifacts };
}

export async function freshStage(workspace) {
  const stage = path.join(workspace.dir, 'stage');
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  await prepareStageHome(stage);
  return stage;
}
export async function parkStage(workspace, name) {
  const target = path.join(workspace.dir, 'runs', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(path.join(workspace.dir, 'stage'), target);
  return target;
}

/** Index entries of a Git index inside a parked stage, read by Git. */
const readIndex = (snapshot, relative) => {
  const file = path.join(snapshot.dir, relative);
  const gitDir = relative.endsWith('/state.metadata-index') ? path.join(path.dirname(file), 'git') : path.dirname(file);
  return readIndexFile(gitDir, file);
};

function alignResult(recording, run, label, identities) {
  const recorded = recording.calls[label], replayed = run.calls[label];
  if (!recorded || !replayed || !run.generations[replayed.generation]) return;
  const a = resultMessage(recording.generations[recorded.generation].entries, recorded.seamID);
  const b = resultMessage(run.generations[replayed.generation].entries, replayed.seamID);
  if (a && b && !a.failed && !b.failed) identities.align(decodeValue(a.value ?? null), decodeValue(b.value ?? null), `${label}.result`);
}

/** A run's ref moves (git shim log), keyed by ledger root, with the storage folder at the stage path both runs used. */
const movesOf = (log, stage, storage) => refMoves(readGitLog(log), path.join(stage, storage));

/** Compares run A (the recording) and run B (a replay of it); returns the list of differences. */
export async function compareRuns({ recording, run, dirA, dirB, storage = 'ledger', gitLogA, gitLogB, auditA, auditB, concurrent = false, seeded = false }) {
  const differences = createDifferences();
  const identities = createIdentityMap();
  // Pairs learned during the replay seed the map; conflicts there are differences too.
  for (const pair of run.identities.pairs) identities.learn(pair.a, pair.b, pair.where);
  const maskers = {
    a: createMasker({ timeline: recording.timeline, observations: recording.observations, mapPath: (text) => identities.substituteText(text) }),
    b: createMasker({ timeline: run.timeline, observations: run.observations }),
  };
  // Results first teach identifiers (lease tokens, transaction IDs); the disk
  // then teaches the rest (record IDs), which later calls' payloads carry.
  for (const label of Object.keys(recording.calls)) alignResult(recording, run, label, identities);
  const a = { ...(await captureSnapshot(dirA, { storage })), dir: dirA }, b = { ...(await captureSnapshot(dirB, { storage })), dir: dirB };
  const { objectPairs } = await compareSnapshots({ a, b, identities, maskers, differences, seeded: seeded && !concurrent });
  if (gitLogA && gitLogB) {
    compareRefMoves({ movesA: movesOf(gitLogA, recording.stage, storage), movesB: movesOf(gitLogB, recording.stage, storage), a, b, identities, maskers, differences, objectPairs, concurrent, seeded });
  }
  await compareIndexes({ a, b, readIndex, identities, differences, objectPairs });
  compareTraces({ recording, run, identities, maskers, differences, seeded });
  let census = null;
  if (auditA && auditB && existsSync(auditA) && existsSync(auditB)) census = auditNotes({ auditA: readFileSync(auditA, 'utf8'), auditB: readFileSync(auditB, 'utf8'), differences }).census;
  for (const conflict of [...run.identities.conflicts, ...identities.conflicts]) differences.add('identity', conflict.where, `${conflict.a} cannot pair with ${conflict.b} (already ${conflict.had ?? conflict.hadBack})`);
  return { differences: differences.list, notes: differences.notes, identities: identities.size, census, snapshots: { a, b } };
}

export const SERIAL_ATTEMPTS = 20;

/** Builds a scenario's fixture once, outside any stage; `place(stage)` clones it into a stage. */
export async function prepareFixture(workspace, scenario, label = scenario.name) {
  const template = path.join(workspace.dir, 'fixtures', label);
  await fs.rm(template, { recursive: true, force: true });
  await fs.mkdir(template, { recursive: true, mode: 0o700 });
  if (scenario.buildAtStage) {
    // A fixture that records absolute paths (a ledger) is written at the stage
    // path every run uses, then moved aside.
    const stage = await freshStage(workspace);
    await scenario.fixture(stage, workspace);
    for (const name of await fs.readdir(stage)) if (!['home', 'tmp'].includes(name)) await fs.rename(path.join(stage, name), path.join(template, name));
  } else await scenario.fixture(template, workspace);
  return { template, place: async (stage) => { for (const name of await fs.readdir(template)) cloneDirectory(path.join(template, name), path.join(stage, name)); } };
}

/** Draw sites the identifier protocol does not name (dual-run-ids.cjs), from a JavaScript run's ID log. */
const unlistedSites = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

/**
 * One scenario: record on a fresh fixture, then replay against each
 * implementation on its own fresh twin. Returns per implementation the
 * differences against the recording and an outcome: `passed`, `failed`, or
 * `inconclusive` (the calls of a concurrent scenario never committed in the
 * recording's order, as observed in each run's own Git history, so the runs
 * are not comparable byte for byte). `env` reaches every arm (and its ledger).
 */
export async function dualRun({ workspace, scenario, implementations, label = scenario.name, recording: given, dirA: givenDirA, fixture }) {
  fixture ??= await prepareFixture(workspace, scenario, label);
  const file = (kind, name) => path.join(workspace.dir, 'audit', `${label}-${name}.${kind}`);
  await fs.mkdir(path.join(workspace.dir, 'audit'), { recursive: true });
  let recording = given, dirA = givenDirA ?? path.join(workspace.dir, 'runs', `${label}-A`);
  if (!recording) {
    const stage = await freshStage(workspace);
    await fixture.place(stage);
    recording = await recordScenario({ stage, scenario, audit: file('jsonl', 'A'), shim: { bin: workspace.bin, log: file('git', 'A') }, idLog: file('ids', 'A') });
    recording.files = { audit: file('jsonl', 'A'), git: file('git', 'A'), ids: file('ids', 'A') };
    dirA = await parkStage(workspace, `${label}-A`);
  }
  const storage = path.relative(recording.stage, decodeValue(recording.options).directory);
  const windowOf = (timeline) => [timeline[0]?.start ?? 0, timeline.at(-1)?.end ?? 0];
  const signatureOf = async (log, dir, map) => commitSignature({ moves: movesOf(log, recording.stage, storage), storageDir: path.join(dir, storage), map, runGit });
  const outcomes = [];
  for (const implementation of implementations) {
    // Calls issued together race for the ledger lock: the order the ledger
    // served them is part of what it writes (sequence numbers, which lease
    // waited). A replay is compared only when its implementation committed
    // the same calls in the same order as the recording, which the harness
    // reads from each run's own Git history (which records each move of the
    // state ref changed); up to SERIAL_ATTEMPTS replays are made to meet that.
    let attempt = 0, run, dirB, orderMatched = true, signatures = null;
    for (;;) {
      attempt += 1;
      const twin = await freshStage(workspace);
      await fixture.place(twin);
      for (const kind of ['jsonl', 'git', 'ids']) await fs.rm(file(kind, implementation.name), { force: true });
      run = await replayRecording({ stage: twin, recording, libDir: implementation.libDir, implementation: implementation.endpoint,
        audit: implementation.audit === false ? undefined : file('jsonl', implementation.name), ids: implementation.ids, env: implementation.env,
        shim: { bin: workspace.bin, log: file('git', implementation.name) }, idLog: file('ids', implementation.name) });
      dirB = await parkStage(workspace, `${label}-${implementation.name}`);
      if (!scenario.concurrent) break;
      const pairs = createIdentityMap();
      for (const pair of run.identities.pairs) pairs.learn(pair.a, pair.b, pair.where);
      const sigA = await signatureOf(recording.files.git, dirA, (text) => pairs.substituteText(text)), sigB = await signatureOf(file('git', implementation.name), dirB);
      signatures = { a: sigA, b: sigB };
      orderMatched = sigA.join('\n') === sigB.join('\n');
      // Not a reordering of the same commits: no other order would match either.
      const permutation = [...sigA].sort().join('\n') === [...sigB].sort().join('\n');
      if (orderMatched || !permutation || attempt >= SERIAL_ATTEMPTS) { if (!permutation) orderMatched = null; break; }
    }
    const compared = await compareRuns({ recording, run, dirA, dirB, storage, concurrent: scenario.concurrent === true,
      gitLogA: recording.files.git, gitLogB: file('git', implementation.name),
      // Both runs drew the protocol's identifiers from the same seed.
      seeded: implementation.ids !== null && implementation.seededIds !== false,
      ...(implementation.audit === false ? {} : { auditA: recording.files.audit, auditB: file('jsonl', implementation.name) }) });
    const differences = [...compared.differences];
    for (const [name, log] of [['A', recording.files.ids], ['B', file('ids', implementation.name)]]) {
      for (const line of unlistedSites(log)) differences.push({ category: 'protocol', where: `identifier draw in run ${name}`, detail: `site not named by the identifier protocol: ${line}` });
    }
    // Inconclusive only where the race explains it: a reordering of the same commits.
    const outcome = orderMatched === false ? 'inconclusive' : differences.length === 0 && !run.crashed ? 'passed' : 'failed';
    const [startB, endB] = windowOf(run.timeline);
    outcomes.push({ implementation: implementation.name, outcome, crashed: run.crashed, differences, notes: compared.notes,
      identities: compared.identities, census: compared.census, ms: endB - startB, dirB, attempts: attempt, orderMatched, signatures, run });
  }
  const [startA, endA] = windowOf(recording.timeline);
  return { scenario: scenario.name, recording, dirA, msA: endA - startA, outcomes, fixture };
}
