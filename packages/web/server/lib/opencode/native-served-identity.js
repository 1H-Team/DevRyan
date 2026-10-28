import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { EXECUTION_VIEW_ENV } from '@devryan/harness-runtime/lib/session-execution.js';
import { parseLsofListeners } from '../processes/runtime.js';

// Which process serves a loopback address a call names, and whether its files
// are current. An execution's processes carry their lease's marker
// (DEVRYAN_EXECUTION_VIEW, session-execution.js). A server started by an
// earlier call keeps serving the copy of the project that call was prepared
// with, so once a later change is published it shows old code
// (viewFreshness). macOS and Linux only. A listener without a readable marker
// is external: its freshness is unknown.

// A loopback host with a scheme (default port) or with an explicit port.
const LOOPBACK = /(?:(?<scheme>https?|wss?):\/\/|(?<![\w.@/:-]))(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(?<port>\d{1,5}))?(?![\w.-])/gi;
const MAX_PORTS = 8;

export const loopbackPorts = (text) => {
  const ports = new Set();
  if (typeof text !== 'string') return [];
  for (const match of text.matchAll(LOOPBACK)) {
    const { scheme, port } = match.groups;
    const value = port !== undefined ? Number(port) : scheme ? (/^(?:https|wss)$/i.test(scheme) ? 443 : 80) : null;
    if (Number.isInteger(value) && value > 0 && value <= 65535) ports.add(value);
    if (ports.size >= MAX_PORTS) break;
  }
  return [...ports];
};

// What devryan_browser would open: `open` and the open steps of a sequence,
// each the first argument that is not a flag, as the plugin reads it. Other
// navigation (tab, clicks, eval, pushstate) is not seen.
export const browserOpenTargets = (input) => {
  const steps = input?.command === 'sequence' && Array.isArray(input.steps) ? input.steps : [input];
  return steps.filter((step) => String(step?.command ?? '').trim().toLowerCase() === 'open' && Array.isArray(step.args))
    .map((step) => step.args.find((argument) => typeof argument === 'string' && !argument.startsWith('-')))
    .filter(Boolean).join('\n');
};

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    // lsof and ps exit 1 when nothing matches.
    if (error && error.code !== 1) reject(error); else resolve(stdout ?? '');
  });
});
const MARKER = new RegExp(String.raw`(?:^|\s)${EXECUTION_VIEW_ENV}=([a-f0-9]{16})(?=\s|$)`, 'g');

// `views.get(marker)` names the lease a marker belongs to ({ token, directory,
// sessionID, callID }); `freshness(view)` asks the ledger about its view.
export const createServedIdentity = ({ views, freshness, platform = process.platform, exec = run, readFile = fs.readFile }) => {
  const markerOf = async (pid) => {
    if (platform === 'linux') {
      const entries = String(await readFile(`/proc/${pid}/environ`)).split('\0');
      return entries.findLast((entry) => new RegExp(`^${EXECUTION_VIEW_ENV}=[a-f0-9]{16}$`).test(entry))?.slice(EXECUTION_VIEW_ENV.length + 1) ?? null;
    }
    // `ps -E` appends the environment to the command line, so the last match
    // is the environment's (Apple platform binaries hide theirs).
    const output = await exec('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
    return [...output.matchAll(MARKER)].at(-1)?.[1] ?? null;
  };
  return async (port) => {
    if (platform !== 'darwin' && platform !== 'linux') return { port, identity: 'external', freshness: 'unknown' };
    let pids;
    try { pids = [...parseLsofListeners(await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'])).keys()]; }
    catch { return { port, identity: 'unresolved', freshness: 'unknown' }; }
    if (!pids.length) return { port, identity: 'none' };
    for (const pid of pids) {
      const marker = await markerOf(pid).catch(() => null);
      if (!marker) continue;
      const view = views.get(marker);
      if (!view) return { port, pid, identity: 'orphaned', freshness: 'unknown' };
      const state = await freshness(view).catch(() => null);
      return { port, pid, identity: 'owned', sessionID: view.sessionID, callID: view.callID, view,
        freshness: ['fresh', 'stale'].includes(state?.state) ? state.state : 'unknown', ...(state?.behind ? { behind: state.behind } : {}) };
    }
    return { port, pid: pids[0], identity: 'external', freshness: 'unknown' };
  };
};

// One value for the addresses a call named: stale if an owned view is behind,
// unknown if a listener is not tied to a current view, fresh otherwise
// (nothing listening yet means the call starts its own server); undefined
// when it named none.
export const servedFreshness = (targets) => !targets?.length ? undefined
  : targets.some((target) => target.freshness === 'stale') ? 'stale'
    : targets.some((target) => target.identity !== 'none' && target.freshness !== 'fresh') ? 'unknown' : 'fresh';

// Tool metadata: never the lease token.
export const publicServedIdentity = (targets) => targets.map(({ view: _view, ...target }) => target);

export const previewStaleMessage = (target) => `preview_stale: the server on port ${target.port} was started by call ${target.callID} and serves`
  + ` the project as it was when that call started; ${target.behind ?? 'later'} change${target.behind === 1 ? ' has' : 's have'} been published since,`
  + ` so it shows old code. Stop it, then start the server and run the check in one foreground call (start it, wait until it answers, check,`
  + ` stop it), on another port if ${target.port} stays taken.`;
