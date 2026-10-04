import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseV2EventBlock } from '../../packages/web/server/lib/opencode/opencode-client/v2.js';

const failureTypes = new Set(['session.execution.failed', 'session.step.failed', 'session.tool.failed']);
const errorTypes = new Set(['unknown', 'aborted', 'provider.auth', 'provider.error', 'provider.invalid-request', 'provider.content-filter', 'provider.invalid-output']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value) ? value : null;
const code = value => typeof value === 'string' && /^(?:native|controller|execution|context|permission|opencode|harness)_[a-z0-9_]{1,112}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Project only actual native failure frames; never retain error text or bodies. */
export function projectPackageFailureEvent(block, receivedAt) {
  if (/^data:\s*\[DONE\]\s*$/.test(block)) return null;
  const parsed = parseV2EventBlock(block);
  if (!parsed) throw new Error('package_native_failure_sse_invalid');
  if (parsed.kind !== 'event' || !failureTypes.has(parsed.envelope.type)) return null;
  const event = parsed.envelope, data = record(event.data) ? event.data : {};
  const error = record(data.error) ? data.error : {};
  const message = typeof error.message === 'string' ? error.message : '';
  return { phase: 'native_failure_event', type: event.type, eventID: identity(event.id),
    sessionID: identity(data.sessionID), messageID: identity(data.messageID ?? data.stepID), callID: identity(data.callID),
    directory: parsed.directory, sequence: finite(event.seq), created: finite(event.created), receivedAt: finite(receivedAt),
    error: { type: errorTypes.has(error.type) ? error.type : null, code: code(error.code) ?? code(message),
      codeSource: code(error.code) ? 'error.code' : code(message) ? 'exact-error-message' : null,
      messageSha256: createHash('sha256').update(message).digest('hex'), messageBytes: Buffer.byteLength(message) } };
}

/** One observer for the actual initial compiled controller, sharing its SSE. */
export async function capturePackageFailureEvents({ client, getAuthHeaders, controller, observations }) {
  const abort = new AbortController();
  const response = await fetch(client.events.url(), { headers: await getAuthHeaders(), signal: abort.signal });
  assert.ok(response.ok && response.body, 'package_native_failure_sse_unavailable');
  let streamFailure, bytes = 0, blocks = 0, failures = 0, ended = false;
  const work = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      bytes += chunk.byteLength; pending += decoder.decode(chunk, { stream: true });
      assert.ok(Buffer.byteLength(pending) <= 4 * 1024 * 1024, 'package_native_failure_sse_block_limit');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        if (!block.trim()) continue;
        const projected = projectPackageFailureEvent(block, performance.now()); blocks++;
        if (projected) {
          assert.ok(++failures <= 256, 'package_native_failure_sse_record_limit');
          observations.push({ ...projected, controllerInstanceID: controller.instanceID });
        }
      }
    }
    ended = true;
    if (!abort.signal.aborted && !controller.hasExited()) throw new Error('package_native_failure_sse_ended');
  })().catch(error => { if (!abort.signal.aborted && !controller.hasExited()) streamFailure = error; });
  let closing;
  return { close: () => closing ??= (async () => {
    abort.abort(); await work;
    observations.push({ phase: 'native_failure_sse_coverage', controllerInstanceID: controller.instanceID,
      scope: 'startup-through-interview', bytes, blocks, failures, ended, failed: Boolean(streamFailure) });
    if (streamFailure) throw streamFailure;
  })() };
}
