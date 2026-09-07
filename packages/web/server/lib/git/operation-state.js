import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const exists = async (file) => stat(file).then(() => true).catch((error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

// Resolve the per-worktree metadata directory through Git: linked worktrees
// have a .git pointer file, and their operation state is not in the common dir.
export async function readGitOperationState(git) {
  const gitDir = String(await git.raw(['rev-parse', '--absolute-git-dir'])).trim();
  const read = (name) => readFile(path.join(gitDir, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const [branch, merge, apply, mergeHead, rebaseHead, cherryPick, revert] = await Promise.all([
    git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((value) => value.trim()).catch(() => ''),
    exists(path.join(gitDir, 'rebase-merge')),
    exists(path.join(gitDir, 'rebase-apply')),
    read('MERGE_HEAD'),
    read('REBASE_HEAD'),
    exists(path.join(gitDir, 'CHERRY_PICK_HEAD')),
    exists(path.join(gitDir, 'REVERT_HEAD')),
  ]);
  let rebaseInProgress = null;
  if (merge || apply) {
    const backend = merge ? 'rebase-merge' : 'rebase-apply';
    // Directory presence is authoritative; optional labels must not hide an
    // active rebase when Git cannot provide them.
    const [headName, onto] = await Promise.all([read(`${backend}/head-name`).catch(() => ''), read(`${backend}/onto`).catch(() => '')]);
    rebaseInProgress = { headName: headName.trim().replace(/^refs\/heads\//, ''), onto: onto.trim().slice(0, 7) };
  }
  const mergeMessage = mergeHead.trim() ? await read('MERGE_MSG') : '';
  const mergeInProgress = mergeHead.trim()
    ? { head: mergeHead.trim().slice(0, 7), message: mergeMessage.split('\n')[0] }
    : null;
  const head = await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).then((value) => value.trim()).catch(() => '');
  let headState = 'unborn';
  if (head) headState = branch ? 'branch' : 'detached';
  let attentionReason = null;
  if (rebaseInProgress) attentionReason = 'rebase';
  else if (mergeInProgress) attentionReason = 'merge';
  else if (cherryPick) attentionReason = 'cherry-pick';
  else if (revert) attentionReason = 'revert';
  return {
    branch: branch || null,
    head: head || null,
    headState,
    rebaseInProgress,
    mergeInProgress,
    mergeHead: mergeHead.trim(),
    mergeMessage,
    rebaseHead: rebaseHead.trim(),
    attentionReason,
  };
}

export function gitStateError(code, message) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

export async function assertGitRemoteReady(git) {
  const state = await readGitOperationState(git);
  if (state.rebaseInProgress) {
    throw gitStateError('GIT_REBASE_IN_PROGRESS', 'Rebase in progress. Resolve conflicts and continue or abort the rebase before pushing or pulling.');
  }
  if (state.headState === 'detached') {
    throw gitStateError('GIT_DETACHED_HEAD', 'HEAD is detached. Check out a branch before pushing or pulling.');
  }
  return state;
}
