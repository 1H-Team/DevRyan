import { createHash } from 'node:crypto';
import { normalizeUsageObservation } from '../../packages/shared-runtime/lib/usage-observation.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)
  && !/^(?:sk-[a-zA-Z0-9_-]{16,}|xai-[a-zA-Z0-9_-]{32,}|gh[opusr]_|github_pat_|eyJ)/.test(value) ? value : null;
export function projectWireRequest(body, headers) {
  // Do not consume/clone a Request stream, or buffer arbitrary uploads. Native
  // adapters normally pass serialized JSON. Other shapes remain opaque.
  if (typeof body !== 'string' || Buffer.byteLength(body) > 2 * 1024 * 1024) return { capture: 'opaque' };
  let value;
  try { value = JSON.parse(body); } catch { return { capture: 'opaque' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { capture: 'opaque' };
  const messages = Array.isArray(value.messages) ? value.messages : Array.isArray(value.input) ? value.input
    : typeof value.input === 'string' ? [value.input] : [];
  const instructions = [value.instructions, value.system, ...messages.filter(m => ['system', 'developer'].includes(m?.role))].filter(v => v !== undefined);
  const cache = Object.fromEntries(Object.entries(value).filter(([key]) => ['prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention'].includes(key)));
  const markers = [];
  let visited = 0, markerGap = false;
  const visit = (entry, location, depth = 0) => {
    if (!entry || typeof entry !== 'object') return;
    if (++visited > 4096 || depth > 32) { markerGap = true; return; }
    if (Object.hasOwn(entry, 'cache_control')) markers.push({ locationHash: hash(location), hash: hash(entry.cache_control) });
    if (Object.hasOwn(entry, 'prompt_cache_breakpoint')) markers.push({ locationHash: hash(location), hash: hash(entry.prompt_cache_breakpoint) });
    for (const [key, child] of Object.entries(entry)) if (child && typeof child === 'object') visit(child, `${location}/${key}`, depth + 1);
  };
  visit(value, 'request');
  const conv = new Headers(headers).get('x-grok-conv-id');
  return { capture: 'serialized', bodyHash: hash(body), bytes: Buffer.byteLength(body), model: label(value.model),
    instructions: instructions.map(hash), tools: (Array.isArray(value.tools) ? value.tools : []).map(hash),
    history: messages.map(hash), cacheParametersHash: hash(cache), cacheMarkers: markers, markerGap,
    conversationIdentifier: conv ? hash(conv) : typeof value.prompt_cache_key === 'string' ? hash(value.prompt_cache_key) : null,
    reasoningEffort: label(value.reasoning_effort ?? value.reasoning?.effort) };
}

// Only numeric usage and model/response identity escape this parser. Responses
// and Messages stream events can split identity and usage across several frames.
export function createWireUsageParser({ route, metadata, maximumFrameBytes = 256 * 1024, maximumBytes = 32 * 1024 * 1024, sse = true }) {
  const decoder = new TextDecoder();
  let pending = '', bytes = 0, gap = null, responseModel = null, responseID = null, raw = {}, firstTokenAt = null, firstResponseDataAt = null, frameAt = null;
  let providerError = false, effortError = false;
  let costTicks = null;
  const hasText = value => typeof value === 'string' && value.length > 0;
  const n = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const merge = values => { for (const [key, value] of Object.entries(values)) if (n(value) !== undefined) raw[key] = value; };
  const parse = text => {
    if (text === '[DONE]' || !text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch { gap ??= 'invalid_response_frame'; return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { gap ??= 'invalid_response_frame'; return; }
    if (firstTokenAt === null && (['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(event.type) && hasText(event.delta)
      || event.type === 'content_block_delta' && [event.delta?.text, event.delta?.thinking, event.delta?.partial_json].some(hasText)
      || [event.choices?.[0]?.delta?.content, event.choices?.[0]?.delta?.reasoning_content,
        ...(event.choices?.[0]?.delta?.tool_calls ?? []).map(call => call?.function?.arguments)].some(hasText))) firstTokenAt = frameAt;
    const response = event.response ?? event.message ?? event;
    if (event.type === 'error' || event.type === 'response.failed' || response.status === 'failed' || response.error) providerError = true;
    // Attribute only structured parameter identity; error messages can contain
    // arbitrary user text and are neither searched nor retained.
    if (['reasoning_effort', 'reasoning.effort'].includes((response.error ?? event.error)?.param)) effortError = true;
    responseModel = label(response.model) ?? responseModel;
    responseID = label(response.id) ?? responseID;
    const usage = response.usage ?? event.usage;
    if (!usage) return;
    if (route.provider === 'xai' && n(usage.cost_in_usd_ticks) !== undefined) costTicks = usage.cost_in_usd_ticks;
    if (route.provider === 'anthropic') merge({ input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens, cacheWrite5m: usage.cache_creation?.ephemeral_5m_input_tokens,
      cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens, output: usage.output_tokens });
    else if (route.transport === 'responses') merge({ input: usage.input_tokens, output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens, cacheRead: usage.input_tokens_details?.cached_tokens,
      cacheWrite: usage.input_tokens_details?.cache_write_tokens });
    else merge({ input: usage.prompt_tokens, output: usage.completion_tokens, reasoning: usage.completion_tokens_details?.reasoning_tokens,
      cacheRead: usage.prompt_tokens_details?.cached_tokens, cacheWrite: usage.prompt_tokens_details?.cache_write_tokens });
  };
  const frames = () => {
    if (!sse) return;
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame) > maximumFrameBytes) { gap = 'response_frame_limit'; pending = ''; return; }
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) parse(data);
    }
  };
  return {
    push(chunk, at) {
      if (gap) return;
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) { gap = 'response_byte_limit'; pending = ''; return; }
      if (firstResponseDataAt === null) firstResponseDataAt = at;
      frameAt = at;
      pending += decoder.decode(chunk, { stream: true });
      frames();
      if (Buffer.byteLength(pending) > maximumFrameBytes) { gap = 'response_frame_limit'; pending = ''; }
    },
    finish(status, completedAt) {
      if (!gap) {
        pending += decoder.decode(); frames();
        if (!sse) parse(pending);
        else if (pending.trim()) gap = 'truncated_response_frame';
      }
      return { gap, providerError, effortError, usageObservation: normalizeUsageObservation({ ...metadata, source: 'provider_request', responseModel, responseID,
        status: providerError && status === 'complete' ? 'failed' : status, observedAt: completedAt, raw,
        semantics: { input: route.provider === 'anthropic' ? 'uncached' : 'inclusive',
          output: route.provider === 'xai' && route.transport === 'chat_completions' ? 'exclusive' : 'inclusive' },
        cost: { amount: costTicks === null ? null : costTicks / 1e10, currency: costTicks === null ? null : 'USD',
          provenance: costTicks !== null && route.auth === 'api_key' ? 'provider_billed' : 'unknown' },
        timing: { ...metadata.timing, firstToken: { at: firstTokenAt, origin: 'client_wire' }, completion: { at: completedAt, origin: 'client_wire' } } }),
      firstResponseDataAt };
    },
  };
}
