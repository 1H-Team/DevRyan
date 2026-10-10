import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Schema, Stream } from 'effect';
import { LLMRequest } from '@opencode/ai/schema/index';
import * as OpenAI from '@opencode/ai/providers/openai';
import * as XAI from '@opencode/ai/providers/xai';
import * as OpenAIResponses from '@opencode/ai/protocols/openai-responses';
import * as XAIResponses from '@opencode/ai/protocols/xai-responses';
import { Framing } from '@opencode/ai/route/framing';
import plugin from '../../packages/web/server/default-config/plugins/devryan-openai-oauth.mjs';
import { providerErrorDetails, isSafeErrorType } from '../../packages/shared-runtime/lib/provider-error-details.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const quotaHeaders = ['x-codex-primary-used-percent', 'x-codex-primary-window-minutes', 'x-codex-primary-reset-at',
  'x-codex-secondary-used-percent', 'x-codex-secondary-window-minutes', 'x-codex-secondary-reset-at'];
const providers = [
  { id: 'openai', method: 'chatgpt-siwc', model: 'gpt-6-astra', effort: 'low', url: 'https://api.openai.com/v1/responses', api: OpenAI, protocol: OpenAIResponses.protocol },
  { id: 'xai', method: 'device', model: 'grok-4.6', effort: 'high', url: 'https://api.x.ai/v1/responses', api: XAI, protocol: XAIResponses.protocol },
];

export async function inspectProviderResponse(response, provider) {
  const output = { status: response.status, quotaHeadersPresent: quotaHeaders.filter(name => response.headers.has(name)) };
  let stage = 'stream-policy';
  try {
  if (provider.id === 'openai' && response.ok && response.headers.has('content-type') && !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const media = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const reader = response.body?.getReader(), chunks = [];
    let bytes = 0;
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) break;
        chunks.push(value);
      }
    } finally { await reader?.cancel().catch(() => {}); }
    const body = Buffer.concat(chunks).toString('utf8');
    let bodyKind = 'other';
    try { JSON.parse(body); bodyKind = 'json'; } catch {
      if (/^(?:event:|data:|:)/m.test(body)) bodyKind = 'sse';
      else if (/^\s*<(?:!doctype|html)/i.test(body)) bodyKind = 'html';
    }
    return { ...output, outcome: 'failed', stage, policyCode: 'chatgpt_siwc_stream_required',
      mediaType: !media ? 'missing' : ['text/event-stream', 'application/json', 'text/html', 'text/plain', 'application/octet-stream'].includes(media) ? media : 'other',
      hasBody: Boolean(response.body), bodyKind, bodyTruncated: bytes > 65536, ...providerErrorDetails(body),
      ...(bodyKind === 'sse' && bytes <= 65536 && provider.protocol && provider.api ? {
        replayWithSseHeader: await inspectProviderResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), provider),
      } : {}) };
  }
  const body = provider.id === 'openai' ? plugin.siwcPolicy.completedResponse(response) : response;
  stage = 'body-read';
  const reader = body.body?.getReader(), chunks = [];
  let bytes = 0;
  try {
    if (reader) for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('response_limit');
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); }
  const data = Buffer.concat(chunks);
  if (!response.ok) return { ...output, outcome: 'provider-refused', ...providerErrorDetails(data.toString('utf8')) };
  stage = 'sse-framing';
  const frames = await Effect.runPromise(Stream.runCollect(Framing.sse.frame(Stream.fromIterable([data]))));
  let state = provider.protocol.stream.initial(new LLMRequest({ model: provider.api.responses(provider.model), system: [], messages: [], tools: [] }));
  let finished = false, answer = '', quotaEventSeen = false;
  for (const frame of frames) {
    stage = 'native-event-decode';
    let event;
    try { event = Schema.decodeUnknownSync(provider.protocol.stream.event)(frame); } catch (error) {
      const fields = new Set(['type', 'response', 'status', 'error', 'code', 'param', 'message', 'usage', 'input_tokens', 'output_tokens', 'total_tokens', 'output', 'id', 'model', 'created_at', 'sequence_number', 'item', 'content', 'delta']);
      const schemaFields = [...new Set([...String(error?.message ?? '').matchAll(/\["([a-z_]+)"\]/g)].map(match => match[1]).filter(field => fields.has(field)))];
      return { ...output, outcome: 'failed', stage, schemaFields, ...providerErrorDetails(frame) };
    }
    if (event.type === 'rate_limits.updated' || event.type === 'account.rateLimits.updated') quotaEventSeen = true;
    stage = 'native-event-step';
    const stepped = await Effect.runPromise(Effect.exit(provider.protocol.stream.step(state, event)));
    if (stepped._tag === 'Failure') {
      const failure = Cause.squash(stepped.cause);
      return { ...output, outcome: 'provider-refused', stage,
      ...(isSafeErrorType(failure.type) ? { errorType: failure.type } : {}),
      ...providerErrorDetails(failure.response?.body), ...providerErrorDetails(frame) };
    }
    const [next, events] = stepped.value;
    state = next;
    for (const item of events) {
      if (item.type === 'text-delta') answer += item.text ?? item.delta ?? '';
      if (item.type === 'step-finish' && item.reason?.normalized === 'stop') finished = true;
    }
  }
  return { ...output, outcome: finished ? 'completed' : 'incomplete', nativeParserAccepted: true,
    answerWasOk: answer.trim() === 'OK', quotaEventSeen, frames: frames.length };
  } catch (error) {
    const policyCodes = ['chatgpt_siwc_stream_required', 'chatgpt_siwc_stream_invalid', 'chatgpt_siwc_stream_failed', 'chatgpt_siwc_stream_interrupted'];
    return { ...output, outcome: 'failed', stage, ...(policyCodes.includes(error?.code) ? { policyCode: error.code } : {}) };
  }
}

// Explicit attended command only. No credential owner, refresh operation or login runs here.
export async function runProviderAccessSmoke({ bundleRoot, output, onlyProvider }) {
  if (!path.isAbsolute(bundleRoot) || !path.resolve(output).startsWith(path.join(repository, '.cache') + path.sep)) throw new Error('Explicit bundle and repository evidence paths required');
  const { Database } = await import('bun:sqlite');
  const selector = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'selection.json'), 'utf8'));
  const descriptor = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'bundles', selector.selectedBundleID, 'descriptor.json'), 'utf8'));
  if (!descriptor.launch.opencodeDatabasePath.startsWith(path.join(bundleRoot, 'bundles') + path.sep)) throw new Error('Unexpected selected database');
  const db = new Database(descriptor.launch.opencodeDatabasePath, { readonly: true, create: false });
  db.exec('PRAGMA query_only = ON');
  const evidence = { scope: 'one direct live request per provider through the installed native parser; no UI or credential refresh', at: new Date().toISOString(), results: [] };
  try {
    for (const provider of providers.filter(item => !onlyProvider || item.id === onlyProvider)) {
      const rows = db.query('SELECT id, value FROM credential WHERE integration_id = ? AND active = 1').all(provider.id);
      const row = rows.length === 1 ? rows[0] : null;
      const credential = row ? JSON.parse(row.value) : null;
      if (credential?.type !== 'oauth' || credential.methodID !== provider.method || typeof credential.access !== 'string'
        || !credential.access || !Number.isFinite(credential.expires) || credential.expires <= Date.now()) {
        evidence.results.push({ provider: provider.id, outcome: 'not-run', reason: 'current_access_token_unavailable_or_expired' }); continue;
      }
      const current = () => db.query('SELECT value FROM credential WHERE id = ? AND integration_id = ? AND active = 1').get(row.id, provider.id)?.value === row.value;
      if (!current()) throw new Error('Selected credential changed before request');
      let result;
      try {
        const body = { model: provider.model, input: [{ role: 'user', content: 'Reply exactly OK. Do not use tools.' }], reasoning: { effort: provider.effort }, stream: true, store: false };
        const response = await fetch(provider.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
          headers: { authorization: `Bearer ${credential.access}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: provider.id === 'openai' ? plugin.siwcPolicy.encodeBody(body) : JSON.stringify(body) });
        result = await inspectProviderResponse(response, provider);
      } catch { result = { outcome: 'failed', reason: 'bounded_transport_or_native_parser_failure' }; }
      evidence.results.push({ provider: provider.id, model: provider.model, ...result, credentialUnchanged: current() });
    }
  } finally { db.close(); }
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [approval, bundleRoot, output, onlyProvider, ...extra] = process.argv.slice(2);
  if (approval !== '--allow-live' || !bundleRoot || !output || extra.length || (onlyProvider && !['openai', 'xai'].includes(onlyProvider))) throw new Error('Requires --allow-live BUNDLE_ROOT REPOSITORY_CACHE_OUTPUT after explicit user authorization');
  console.log(JSON.stringify(await runProviderAccessSmoke({ bundleRoot, output, onlyProvider })));
}
