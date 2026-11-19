// The arms a scenario runs against (BH2; design file 31 §5.1, §5.2). An arm
// is a process the driver starts on a data root, sends requests to, asks
// about quiescence and stops; the driver itself freezes, kills and walks it by
// process group. Both arms lead a process group of their own.
//
// The arm interface (what the driver uses, nothing more):
//   role                  'reference' | 'candidate'
//   label                 for records and deadlines
//   capabilities          { principals: Set (the principal names it can be given), tap (records the
//                         group's exchange from inside), admissible (the driver may run every order of a
//                         concurrent step on it), envelope (it takes the principal as an envelope header),
//                         edgeFiles (data-root files its edge writes, not the group) }
//   start({ dataRoot, home, stubs }) -> { pid, pgid, listen }   on the same roots after a restart
//   prepare(request, { seq, envelope }) -> request      what goes on the wire (a candidate gets the
//                         envelope and sequence headers; the reference gets the request as the client sent it)
//   seqFor(result)        the arm's sequence number of an exchange the driver made (the reference:
//                         the tap's, found by the connection's local port; a candidate: the driver's own)
//   quiescent(seq, ms)    the arm's claim: { seq, quiescent, pending, blind, crossed }
//   lastSeq()             the last sequence number the arm knows of
//   records()             what the tap wrote since this process started (reference), or []
//   stop() -> { code, signal, escalated }   asks the arm to stop and waits; escalates to SIGTERM then
//                         SIGKILL of the group, and says so
//   exited                a promise of the process's exit
//
// Both arms get the same environment (design §7): the guard's, plus a time
// zone, a locale and a HOME (with the XDG folders under it) the driver gives
// them, and umask 022. The HOME is a directory of the run, tracked like the
// data root (held, frozen, walked).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { REPOSITORY_ROOT } from './edge.mjs';
import { startGroupHost } from './host-launch.mjs';
import { onceFinished } from './child-finish.mjs';
import { HARNESS_HEADERS, encodeEnvelope } from './scenario.mjs';
import { DeadlineError, signalGroup } from './tree.mjs';

export const ARM_LIMITS = Object.freeze({ readyMs: 120_000, controlMs: 60_000, quiescentMs: 120_000, stopMs: 60_000 });
/** The fixed environment both arms get on top of the guard's (design §7). */
export const ARM_ENVIRONMENT = Object.freeze({ TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
export const ARM_UMASK = 0o022;
/** HOME and the XDG folders under `home` (the folders themselves are not created). */
export const homeVariables = (home) => ({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache') });
/** Runs `action` (a spawn) with the arms' umask, so the child starts with it; the harness's own is restored at once. */
export const withArmUmask = (action) => { const previous = process.umask(ARM_UMASK); try { return action(); } finally { process.umask(previous); } };

/** Reads a tap record file, leaving out a last line still being written. */
export function readRecords(file) {
  if (!file) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = text.split('\n');
  lines.pop(); // empty after a final newline, or an unterminated line
  return lines.filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`${file}:${index + 1}: not a JSON record`); } });
}

/**
 * Files of the data root the reference's edge writes, not the group: the
 * multi-user runtime's vault (`multi-user-vault.json`, new ciphertext at
 * every start; its `.key`, written once, never changes and is the group's
 * tree like any other file). A candidate has no edge and never writes them. Snapshots mark them
 * `edge: true`; the driver's own tree comparisons (restore, admissible
 * serialisations) leave them out, and so must a comparer of R against C.
 */
export const REFERENCE_EDGE_FILES = Object.freeze(['multi-user-vault.json']);

/**
 * The reference arm: the landed group host (BH1) with the tap, for group
 * `name` of `table` (a group table module in this folder, or the default).
 */
export function referenceArm({ run, name, group, table = null, label, env = process.env, limits = ARM_LIMITS }) {
  let host = null;
  let starts = 0;
  const tapFiles = [];
  return {
    role: 'reference', label,
    capabilities: { principals: new Set(['local-admin', 'remote-unauthenticated']), tap: true, admissible: true, envelope: false, edgeFiles: REFERENCE_EDGE_FILES },
    async start({ dataRoot, home, stubs = {} }) {
      starts += 1;
      // The host checks the guard's isolation with the guard's HOME, then takes the run's (--home): group-host.mjs.
      host = await withArmUmask(() => startGroupHost({ run, name, group, label: `${label}/process-${starts}`, table, env: { ...env, ...ARM_ENVIRONMENT }, dataRoot, home, stubs, processGroup: true, limits: { readyMs: limits.readyMs, controlMs: limits.controlMs, stopMs: limits.stopMs } }));
      tapFiles.push(host.tapFile);
      return { pid: host.child.pid, pgid: host.child.pid, listen: host.ready.listen, control: host.ready.control };
    },
    prepare: (request) => request,
    seqFor(result) {
      const start = readRecords(host.tapFile).find((record) => record.type === 'exchange-start' && record.peer?.port === result.localPort && /^(?:::ffff:)?127\.0\.0\.1$/.test(record.peer?.address ?? ''));
      return start ? start.seq : null;
    },
    async quiescent(seq, deadlineMs = limits.quiescentMs) {
      try { return (await host.quiescent(seq, deadlineMs)).body; } catch (error) {
        // Only the call's own timeout is a deadline; a refused or reset connection (a dying host) is not.
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new DeadlineError(`the reference's quiescence answer for exchange ${seq}`, deadlineMs + 5_000);
        throw new Error(`the reference's quiescence answer for exchange ${seq} failed: ${error?.cause?.code ?? error?.message ?? error}`);
      }
    },
    async lastSeq() { return (await host.control('/status', {}, { timeoutMs: limits.controlMs })).body.lastSeq; },
    records: () => readRecords(host?.tapFile),
    /** Every tap file of every process this arm ran (a killed process's records stay readable). */
    tapFiles: () => [...tapFiles],
    async stop() {
      const exit = await host.stop();
      return { code: exit.code, signal: exit.signal, escalated: exit.signal === 'SIGKILL' ? 'SIGKILL' : exit.signal === 'SIGTERM' ? 'SIGTERM' : null };
    },
    get exited() { return host.exit; },
    get pid() { return host?.child.pid ?? null; },
  };
}

/**
 * A candidate arm: any executable that speaks the candidate protocol (§5.2):
 * started as `<command> --listen 127.0.0.1:0 --control 127.0.0.1:0
 * --data-root <dir> --home <dir> [--stub name=URL ...]`, it prints one line
 * `{"ready":{"listen":port,"control":port}}`; requests carry the envelope and
 * sequence headers; `GET /quiescent?seq=n` is its claim; `POST /stop` stops it.
 */
export function candidateArm({ command, label, env = process.env, principals = ['local-admin', 'managed-admin', 'managed-developer'], limits = ARM_LIMITS }) {
  let child = null;
  let ready = null;
  let exited = null;
  let lastSeq = 0;
  // Each control call on a connection of its own (agent: false, Connection: close): a pooled keep-alive connection
  // the candidate's server has just closed as idle would fail a call with the candidate alive (seen at load 50).
  const control = (route, init = {}, timeoutMs = limits.controlMs) => new Promise((resolve, reject) => {
    const what = `the candidate's control answer to ${init.method ?? 'GET'} ${route}`;
    const request = http.request({ host: '127.0.0.1', port: ready.control, path: route, method: init.method ?? 'GET', agent: false, headers: { Connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
        resolve({ status: response.statusCode, body });
      });
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => { request.destroy(); reject(new DeadlineError(what, timeoutMs)); }, timeoutMs);
    request.on('error', (error) => { clearTimeout(timer); reject(new Error(`${what} failed: ${error.code ?? error.message}`)); });
    request.end();
  });
  const waitExit = (ms) => Promise.race([exited, new Promise((resolve) => { const timer = setTimeout(() => resolve(null), ms); timer.unref?.(); })]);
  return {
    role: 'candidate', label,
    capabilities: { principals: new Set(principals), tap: false, admissible: false, envelope: true, edgeFiles: [] },
    async start({ dataRoot, home, stubs = {} }) {
      const [file, ...args] = command;
      child = withArmUmask(() => spawn(file, [...args, '--listen', '127.0.0.1:0', '--control', '127.0.0.1:0', '--data-root', dataRoot, '--home', home, ...Object.entries(stubs).flatMap(([name, url]) => ['--stub', `${name}=${url}`])],
        { cwd: REPOSITORY_ROOT, env: { ...env, ...ARM_ENVIRONMENT, ...homeVariables(home) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
      child.stdin.on('error', () => {});
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
      // Settled when the candidate is gone and its stderr has been read to the end (child-finish.mjs).
      exited = new Promise((resolve) => { onceFinished(child, (code, signal) => resolve({ code, signal, stderr })); });
      let buffered = '';
      ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DeadlineError(`the candidate's ready line (${file})`, limits.readyMs)), limits.readyMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffered += chunk;
          const newline = buffered.indexOf('\n');
          if (newline < 0) return;
          const line = buffered.slice(0, newline);
          buffered = '';
          let parsed = null;
          try { parsed = JSON.parse(line).ready; } catch { parsed = null; }
          clearTimeout(timer);
          if (parsed && Number.isInteger(parsed.listen) && Number.isInteger(parsed.control)) resolve(parsed);
          else reject(new Error(`the candidate's first line is not a ready record: ${JSON.stringify(line.slice(0, 200))}`));
        });
        exited.then(({ code, signal }) => { clearTimeout(timer); reject(new Error(`the candidate exited (${code ?? signal}) before it was ready:\n${stderr}`)); });
      }).catch((error) => { signalGroup(child.pid, 'SIGKILL'); throw error; });
      // Later output (a candidate's log lines) is drained, never read as protocol.
      child.stdout.on('data', () => {});
      return { pid: child.pid, pgid: child.pid, listen: ready.listen, control: ready.control };
    },
    prepare(request, { seq, envelope }) {
      lastSeq = Math.max(lastSeq, seq);
      const headers = [...request.headers, [HARNESS_HEADERS.seq, String(seq)]];
      if (envelope) headers.push([HARNESS_HEADERS.envelope, encodeEnvelope(envelope)]);
      return { ...request, headers };
    },
    seqFor: (_result, seq) => seq,
    async quiescent(seq, deadlineMs = limits.quiescentMs) {
      const answer = await control(`/quiescent?seq=${seq}`, {}, deadlineMs);
      if (answer.status !== 200 || !answer.body || typeof answer.body !== 'object') throw new Error(`the candidate answered /quiescent?seq=${seq} with ${answer.status}`);
      return { blind: [], crossed: [], pending: [], ...answer.body };
    },
    lastSeq: async () => lastSeq,
    records: () => [],
    tapFiles: () => [],
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) { const exit = await exited; return { ...exit, escalated: null }; }
      await control('/stop', { method: 'POST' }, limits.stopMs).catch(() => null);
      let exit = await waitExit(limits.stopMs);
      if (exit) return { code: exit.code, signal: exit.signal, escalated: null };
      signalGroup(child.pid, 'SIGTERM');
      exit = await waitExit(limits.stopMs);
      if (exit) return { code: exit.code, signal: exit.signal, escalated: 'SIGTERM' };
      signalGroup(child.pid, 'SIGKILL');
      exit = await exited;
      return { code: exit.code, signal: exit.signal, escalated: 'SIGKILL' };
    },
    get exited() { return exited; },
    get pid() { return child?.pid ?? null; },
  };
}
