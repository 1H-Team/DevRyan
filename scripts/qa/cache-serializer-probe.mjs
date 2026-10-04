// Explicit real-binary, loopback-only verification; never part of offline suites.
import { pathToFileURL } from 'node:url';

export function gradeSerializedPrefix(first, second) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return { instructionsStable: same(first.instructions, second.instructions), toolsStable: same(first.tools, second.tools),
    priorHistoryStable: first.history?.length > 0 && same(first.history, second.history?.slice(0, first.history.length)),
    cacheParametersStable: first.cacheParametersHash === second.cacheParametersHash };
}
export function respond(res, body, ordinal, inputTokens = 10000) {
  const emit = event => res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (body.model.startsWith('grok')) {
    emit({ id: `chat_${ordinal}`, object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 15,
        prompt_tokens_details: { cached_tokens: 6000 }, completion_tokens_details: { reasoning_tokens: 5 } } });
    res.end('data: [DONE]\n\n'); return;
  }
  const item = { id: `msg_${ordinal}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
  const response = { id: `resp_${ordinal}`, object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] };
  emit({ type: 'response.created', response });
  emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'done' });
  emit({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'done' });
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: {
    input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10, input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 3000 }, output_tokens_details: { reasoning_tokens: 2 },
  } } });
  res.end();
}

export async function runCacheSerializerProbe() {
  throw Object.assign(new Error('The v1 serializer runtime probe is retired; native v2 serializer qualification is unavailable in this historical lane'),
    { code: 'qa_native_diagnostic_unavailable' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCacheSerializerProbe();
