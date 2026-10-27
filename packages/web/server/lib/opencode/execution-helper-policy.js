// Pinned native Git discovery and VcsGit.info only; never accept arbitrary -c.
export const nativeVcsGitFlags = Object.freeze([
  '--no-optional-locks', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false',
  '-c', 'core.longpaths=true', '-c', 'core.symlinks=true', '-c', 'core.quotepath=false',
]);
const discovery = new Set([
  JSON.stringify(['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']),
  JSON.stringify(['remote', 'get-url', 'origin']), JSON.stringify(['rev-list', '--max-parents=0', 'HEAD']),
  JSON.stringify(['worktree', 'list', '--porcelain']),
]);
const info = new Set([
  JSON.stringify(['symbolic-ref', '--quiet', '--short', 'HEAD']), JSON.stringify(['remote']),
  JSON.stringify(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  JSON.stringify(['config', 'init.defaultBranch']),
]);
export function isReviewedControllerGitArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return false;
  if (discovery.has(JSON.stringify(args))) return true;
  if (!nativeVcsGitFlags.every((flag, index) => args[index] === flag)) return false;
  const body = args.slice(nativeVcsGitFlags.length);
  if (info.has(JSON.stringify(body))) return true;
  // VcsGit.defaultBranch reads a remote name returned by `git remote`.
  return body.length === 2 && body[0] === 'symbolic-ref'
    && /^refs\/remotes\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\/HEAD$/.test(body[1])
    && !body[1].includes('..') && !body[1].includes('//');
}
