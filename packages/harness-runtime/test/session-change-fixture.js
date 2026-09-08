import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../lib/session-changes-git.js';
import { changeKey, openChangeStore } from '../lib/session-changes-store.js';
import { changedEntries } from '../lib/session-changes-snapshot.js';

// Storage/restore stress tests execute every mutation themselves in disposable
// repositories. Their fixture executor can therefore attest those raw blobs,
// including binaries and modes, without copying giant contents into JS.
// Attribution tests do NOT use this helper: they independently supply actual
// per-call receipts and prove that ordinary snapshots cannot establish ownership.
export async function finishFixtureMutation(runtime, input, storage) {
  await runtime.finish(input);
  const directory = await fs.realpath((await git(input.directory, ['rev-parse', '--show-toplevel'])).toString().trim());
  const gitDir = path.join(storage, changeKey(directory), 'git');
  const db = await openChangeStore(storage, gitDir);
  const op = await db.get(`operations/${changeKey(`${input.sessionID}\0${input.callID}`)}.json`);
  if (!op || op.state !== 'complete' || !op.hasChanges || op.evidence === 'exact') return;
  if (op.overlap && !op.paths) throw new Error('Fixture executor cannot attest an overlapping whole-worktree observation');
  const repo = { storage, gitDir };
  const files = async function* () {
    for await (const change of changedEntries(repo, op.before, op.after)) yield { path: change.file, before: change.before, after: change.after };
  };
  await runtime.recordReceipt({ ...input, source: 'fixture-executor', files: files() });
}
