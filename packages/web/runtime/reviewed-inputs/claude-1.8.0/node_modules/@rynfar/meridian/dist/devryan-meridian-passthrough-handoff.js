// Copied beside the pinned Meridian bundle. No application imports: this runs
// inside the managed OpenCode process as well as the standalone proxy fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

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
    const configDirectory = options.env?.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    file = await fs.open(path.join(configDirectory, 'projects', sdkProjectDirectory(cwd), `${boundary.sessionId}.jsonl`), 'r');
    const { size } = await file.stat();
    const offset = Math.max(0, size - MAX_CHECKPOINT_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_CHECKPOINT_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (offset > 0) lines.shift();
    if (lines.at(-1) !== '' || lines.length > 4096) return false;
    const records = lines.filter(Boolean).map(line => JSON.parse(line));
    return validatePersistedCheckpoint(records, { ...boundary, cwd });
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
} = {}) {
  if (typeof checkpoint !== 'function') {
    yield* query;
    return;
  }

  let requested = false;
  let terminal = false;
  let timedOut = false;
  let drainTimer;
  let interrupt;
  let sessionId;
  let boundary;
  const report = (event, reason) => diagnostic(event, {
    reason,
    toolCount: boundary?.toolCallIds.length ?? 0,
  });

  try {
    for await (const message of query) {
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
