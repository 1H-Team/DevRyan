// The git shim: an observation of ledger ref moves made from outside the
// implementation under test. Each arm's PATH starts with a folder whose `git`
// is this shell script. Every Git command but `update-ref` is exec'ed
// unchanged (same process, same arguments, stdin and stdout). For
// `update-ref` the shim appends one line before and one after the real Git
// runs, naming the calling process ($PPID: the ledger's process), the bytes of
// the ledger's owner.lock at that moment (or `-`), Git's exit code and the
// arguments; and it can kill or hold the caller at the Nth such move, so a
// crash point exists for any implementation that moves its refs through Git.
//
//   LEDGER_DUAL_RUN_GIT_LOG=<file>      where the lines go
//   LEDGER_DUAL_RUN_GIT_CRASH='<phase> <nth> <action> <marker> <armFile> <ref>'
//     phase before|after, action kill|hold; counts only moves of <ref> once
//     <armFile> exists; once <marker> exists the shim no longer acts.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCRIPT = String.raw`#!/bin/sh
# ledger dual-run git shim (scripts/ledger-dual-run/dual-run-git-shim.mjs)
REAL='@REAL@'
case " $* " in
  *" update-ref "*) ;;
  *) exec "$REAL" "$@" ;;
esac
gitdir=''; prev=''; ref=''; seen=''
for arg in "$@"; do
  if [ "$prev" = '--git-dir' ]; then gitdir="$arg"; fi
  if [ -n "$seen" ] && [ -z "$ref" ]; then case "$arg" in -*) ;; *) ref="$arg" ;; esac; fi
  if [ "$arg" = 'update-ref' ]; then seen=1; fi
  prev="$arg"
done
lock=''
if [ -n "$gitdir" ]; then lock="$(dirname "$gitdir")/owner.lock"; fi
state() { if [ -n "$lock" ] && [ -f "$lock" ]; then tr -d '\n\t' < "$lock"; else printf -- '-'; fi; }
act() {
  [ -n "$LEDGER_DUAL_RUN_GIT_CRASH" ] || return 0
  set -- $LEDGER_DUAL_RUN_GIT_CRASH "$1"
  phase="$1"; nth="$2"; action="$3"; marker="$4"; armed="$5"; target="$6"; now="$7"
  [ "$phase" = "$now" ] && [ "$ref" = "$target" ] && [ -f "$armed" ] && [ ! -f "$marker" ] || return 0
  echo x >> "$marker.count"
  [ "$(wc -l < "$marker.count" | tr -d ' ')" = "$nth" ] || return 0
  printf '%s %s %s %s\n' "$now" "$nth" "$ref" "$PPID" > "$marker"
  if [ "$action" = hold ]; then while kill -0 "$PPID" 2>/dev/null; do sleep 0.2; done; exit 137; fi
  kill -9 "$PPID"; exit 137
}
if [ -n "$LEDGER_DUAL_RUN_GIT_LOG" ]; then printf 'before\t%s\t%s\t-\t%s\n' "$PPID" "$(state)" "$*" >> "$LEDGER_DUAL_RUN_GIT_LOG"; fi
act before
"$REAL" "$@"; code=$?
if [ -n "$LEDGER_DUAL_RUN_GIT_LOG" ]; then printf 'after\t%s\t%s\t%s\t%s\n' "$PPID" "$(state)" "$code" "$*" >> "$LEDGER_DUAL_RUN_GIT_LOG"; fi
[ "$code" = 0 ] && act after
exit $code
`;

let realGit = null;
/** The Git executable the shim forwards to, resolved once from the harness's own PATH. */
export function resolveRealGit() {
  realGit ??= execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  if (!realGit || realGit.includes("'")) throw new Error(`ledger dual run: cannot resolve git (${realGit})`);
  return realGit;
}

/** Writes the shim into `<runRoot>/bin/git`; returns that folder (to put first on PATH). */
export function installGitShim(runRoot) {
  const bin = path.join(runRoot, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(bin, 'git'), SCRIPT.replace('@REAL@', resolveRealGit()), { mode: 0o700 });
  chmodSync(path.join(bin, 'git'), 0o700);
  return bin;
}

const parseLock = (text) => { if (text === '-') return null; try { return JSON.parse(text); } catch { return { unparseable: text }; } };
/**
 * The shim's lines as events: { phase, pid, lock (parsed owner.lock or null),
 * code (after only), args, gitDir, ref, values (the arguments after the ref) }.
 */
export function readGitLog(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => {
    const [phase, pid, lock, code, args = ''] = line.split('\t');
    const words = args.split(' ');
    const gitDir = words.includes('--git-dir') ? words[words.indexOf('--git-dir') + 1] : null;
    const rest = words.slice(words.indexOf('update-ref') + 1);
    const deleting = rest.includes('-d');
    const operands = rest.filter((word) => !word.startsWith('-'));
    return { phase, pid: Number(pid), lock: parseLock(lock), code: code === '-' ? null : Number(code), args, gitDir, deleting,
      ref: operands[0] ?? null, values: operands.slice(1) };
  });
}
