// Copied beside the pinned Meridian bundle. No application imports: this runs
// inside the managed OpenCode process as well as the standalone proxy fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
// Meridian's UPSTREAM_IDLE_MS (DevRyan sets 90 s) bounds silence within one SDK
// attempt. High-effort reasoning can stream nothing for longer than that.
export const HIGH_EFFORT_UPSTREAM_IDLE_MS = 180_000;
const HIGH_EFFORTS = new Set(['high', 'xhigh', 'max']);
// The response-level guard is only a backstop: the attempt guard must fire
// first so a stalled step can be retried before the response fails.
const UPSTREAM_IDLE_BACKSTOP_GRACE_MS = 5_000;
export const STALL_RETRY_MARKER = Object.freeze({ type: 'devryan_stall_retry' });

/** Zero (or less) keeps Meridian's guard disabled. */
export function upstreamIdleBudget(baseMs, effort) {
  if (!(baseMs > 0)) return baseMs;
  return HIGH_EFFORTS.has(effort) ? Math.max(baseMs, HIGH_EFFORT_UPSTREAM_IDLE_MS) : baseMs;
}

export function upstreamIdleBackstop(baseMs, effort) {
  const budget = upstreamIdleBudget(baseMs, effort);
  return budget > 0 ? budget + UPSTREAM_IDLE_BACKSTOP_GRACE_MS : budget;
}

function reportCheckpoint(queryOptions, diagnostic, event, detail) {
  const observe = Reflect.get(globalThis, '__DEVRYAN_CLAUDE_CHECKPOINT_DIAGNOSTIC');
  if (typeof observe === 'function') {
    try { observe(queryOptions?.env?.DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE, event, detail); } catch { /* Observation only. */ }
  }
  diagnostic(event, detail);
}

// Claude Agent SDK 0.2.141's project path encoding (including long paths).
// This is paired with the managed SDK/version tuple and the bundle hash gate.
export function sdkProjectDirectory(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export function validatePersistedCheckpoint(records, { sessionId, assistantUuid, toolCallIds, cwd }) {
  const expected = new Set(toolCallIds);
  if (!expected.size || expected.size !== toolCallIds.length) return false;
  const byUuid = new Map(records.filter(row => row && typeof row.uuid === 'string').map(row => [row.uuid, row]));
  const target = byUuid.get(assistantUuid);
  if (target?.type !== 'assistant' || typeof target.message?.id !== 'string') return false;
  const assistantUuids = new Set();
  const actual = new Set();
  let row = target;
  while (row?.type === 'assistant' && row.message?.id === target.message.id) {
    if (assistantUuids.has(row.uuid) || row.sessionId !== sessionId || (typeof row.cwd !== 'string' || row.cwd.normalize('NFC') !== cwd)
      || !Array.isArray(row.message.content)) return false;
    assistantUuids.add(row.uuid);
    for (const block of row.message.content) {
      if (!block || block.type !== 'tool_use') continue;
      if (!expected.has(block.id) || actual.has(block.id)) return false;
      actual.add(block.id);
    }
    row = byUuid.get(row.parentUuid);
  }
  if (actual.size !== expected.size) return false;
  const resolved = new Set();
  for (const entry of records) {
    if (!entry || entry.type !== 'user' || entry.sessionId !== sessionId || (typeof entry.cwd !== 'string' || entry.cwd.normalize('NFC') !== cwd)
      || !assistantUuids.has(entry.parentUuid) || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type !== 'tool_result') continue;
      if (!expected.has(block.tool_use_id) || resolved.has(block.tool_use_id)) return false;
      resolved.add(block.tool_use_id);
    }
  }
  return resolved.size === expected.size;
}

export async function verifyPersistedCheckpoint(boundary, options = {}) {
  if (!UUID.test(boundary.sessionId) || !UUID.test(boundary.assistantUuid) || typeof options.cwd !== 'string') return false;
  let file;
  try {
    const cwd = (await fs.realpath(options.cwd)).normalize('NFC');
    const nativeScope = options.env?.DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE;
    const resolveNative = Reflect.get(globalThis, '__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY');
    if (nativeScope !== undefined && typeof resolveNative !== 'function') return false;
    const configDirectory = nativeScope === undefined
      ? options.env?.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
      : await resolveNative(nativeScope, cwd);
    if (typeof configDirectory !== 'string' || !path.isAbsolute(configDirectory)) return false;
    const projects = path.join(configDirectory, 'projects');
    const project = path.join(projects, sdkProjectDirectory(cwd));
    const canonical = async () => {
      for (const directory of [configDirectory, projects, project]) {
        if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) return false;
      }
      return true;
    };
    if (!await canonical()) return false;
    const transcript = path.join(project, `${boundary.sessionId}.jsonl`);
    if (await fs.realpath(transcript) !== transcript || !(await fs.lstat(transcript)).isFile()) return false;
    file = await fs.open(transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { size } = await file.stat();
    if (!(await file.stat()).isFile()) return false;
    const offset = Math.max(0, size - MAX_CHECKPOINT_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_CHECKPOINT_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (offset > 0) lines.shift();
    if (lines.at(-1) !== '' || lines.length > 4096) return false;
    const records = lines.filter(Boolean).map(line => JSON.parse(line));
    if (nativeScope !== undefined && await resolveNative(nativeScope, cwd) !== configDirectory) return false;
    return await canonical() && await fs.realpath(transcript) === transcript && validatePersistedCheckpoint(records, { ...boundary, cwd });
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

export async function* settlePassthroughQuery(query, {
  signal,
  checkpoint,
  diagnostic = () => {},
  queryOptions,
  verified = () => {},
  verify = verifyPersistedCheckpoint,
  drainTimeoutMs = 10_000,
  // Meridian's own guard ({ guard, error, ms, onStall }). It wraps the SDK
  // query inside this generator so a stall is observed, not just closed.
  idle,
} = {}) {
  const source = idle ? idle.guard(query, idle.ms, idle.onStall) : query;
  if (typeof checkpoint !== 'function') {
    yield* source;
    return;
  }

  let requested = false;
  let terminal = false;
  let timedOut = false;
  let drainTimer;
  let interrupt;
  let sessionId;
  let boundary;
  const report = (event, reason) => reportCheckpoint(queryOptions, diagnostic, event, {
    reason,
    toolCount: boundary?.toolCallIds.length ?? 0,
  });

  try {
    for await (const message of source) {
      if (timedOut) throw new Error('Meridian checkpoint drain timed out');
      if (typeof message.session_id === 'string') sessionId = message.session_id;
      if (message.type === 'result') terminal = true;
      // Meridian must first consume the assistant and all corresponding SDK
      // tool results, close every client block, and establish its checkpoint.
      yield message;
      if (requested || terminal || signal?.aborted) continue;
      const candidate = checkpoint();
      if (!candidate) continue;
      if (!sessionId || typeof candidate.assistantUuid !== 'string'
        || !candidate.assistantUuid || !Array.isArray(candidate.toolCallIds)
        || candidate.toolCallIds.length === 0
        || candidate.toolCallIds.some(id => typeof id !== 'string' || !id)
        || new Set(candidate.toolCallIds).size !== candidate.toolCallIds.length) {
        report('passthrough.checkpoint_rejected', 'invalid_boundary');
        continue;
      }
      boundary = candidate;
      requested = true;
      report('passthrough.checkpoint_settling', 'tool_results_complete');
      // A control interrupt settles the SDK query; it is deliberately not the
      // request abort signal. Keep draining to the real SDK terminal result.
      // Awaiting the control response here could deadlock event consumption.
      try {
        interrupt = Promise.resolve(query.interrupt()).catch(() => {
          report('passthrough.checkpoint_interrupt_failed', 'control_failed');
        });
      } catch {
        report('passthrough.checkpoint_interrupt_failed', 'control_failed');
      }
      drainTimer = setTimeout(() => {
        timedOut = true;
        report('passthrough.checkpoint_rejected', 'drain_timeout');
        try { query.close(); } catch { /* The enclosing SDK attempt also closes it. */ }
      }, drainTimeoutMs);
      drainTimer.unref?.();
    }
    if (timedOut) throw new Error('Meridian checkpoint drain timed out');
    if (requested) report(
      terminal && !signal?.aborted ? 'passthrough.checkpoint_settled' : 'passthrough.checkpoint_rejected',
      signal?.aborted ? 'client_abort' : terminal ? 'sdk_terminal' : 'missing_terminal',
    );
  } catch (error) {
    if (idle && error instanceof idle.error) {
      report('passthrough.checkpoint_aborted', 'upstream_idle');
      throw error;
    }
    // SDK 0.2.141 may discard its buffered result when Claude exits with the
    // tool-boundary interrupt diagnostic or max_turns. A durable, exact native
    // assistant + complete result set is an alternative checkpoint proof; it
    // is NOT a fabricated SDK result. Transport errors and user aborts never
    // qualify, and the normal eviction/recovery path handles failed proofs.
    const message = error instanceof Error ? error.message : '';
    const checkpointExit = /Reached maximum number of turns \(\d+\)/i.test(message)
      || message.startsWith('Claude Code returned an error result: [ede_diagnostic] result_type=user ');
    if (!requested || !checkpointExit || timedOut || signal?.aborted) {
      let reason = 'unrecognized_sdk_exit';
      if (signal?.aborted) reason = 'client_abort';
      else if (timedOut) reason = 'drain_timeout';
      else if (!requested) reason = 'incomplete_boundary';
      report('passthrough.checkpoint_rejected', reason);
      throw error;
    }
    query.close();
    const saved = { ...boundary, sessionId };
    if (!await verify(saved, queryOptions) || signal?.aborted) {
      report('passthrough.checkpoint_rejected', 'persisted_boundary_unverified');
      throw error;
    }
    verified(saved);
    report('passthrough.checkpoint_settled', 'persisted_tool_boundary');
  } finally {
    clearTimeout(drainTimer);
    // The SDK owns the control request lifetime. Its rejection is observed
    // above even when cancellation closes the generator before the reply.
    void interrupt;
  }
}

/**
 * Retry a step once when Meridian's idle guard stalls it, resuming the same
 * retained, verified checkpoint. `attempt` builds a fresh SDK attempt (and
 * prompt) per call. A retry is refused once anything but reasoning reached the
 * client (text or a tool call would be duplicated) and after a client abort;
 * then, and on a second stall, the original error reaches Meridian unchanged.
 */
export async function* retryStalledCheckpoint(attempt, {
  retained = false,
  isStall = () => false,
  forwarded = () => true,
  close = () => {},
  signal,
  queryOptions,
  diagnostic = () => {},
} = {}) {
  let retried = false;
  while (true) {
    try {
      yield* attempt();
      return;
    } catch (error) {
      if (retried || !retained || !isStall(error) || signal?.aborted || forwarded()) throw error;
      retried = true;
      // Close the partial reasoning block; the new attempt opens its own blocks.
      close();
      reportCheckpoint(queryOptions, diagnostic, 'passthrough.checkpoint_retry', { reason: 'upstream_idle', toolCount: 0 });
      // Restarts the response-level idle backstop before the next SDK attempt.
      yield STALL_RETRY_MARKER;
    }
  }
}
