import http from 'node:http';
import { randomUUID } from 'node:crypto';

// A deterministic model transport exercises the real provider, dispatcher and
// file tools without contacting a provider or reading credentials.
export async function startRevertModelFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages || [];
    requests.push(body);
    const user = messages.findLast((message) => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : user?.content?.map((part) => part.text || '').join('\n') || '';
    const match = /DEVRYAN_FIXTURE_TOOL:([^\n]+)/.exec(text);
    const last = messages.at(-1);
    const tool = match && last?.role === 'user' ? JSON.parse(match[1]) : null;
    const call = tool ? { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) } } : null;
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    const message = { role: 'assistant', ...(call ? { content: null, tool_calls: [call] } : { content: 'Fixture complete.' }) };
    const finish_reason = call ? 'tool_calls' : 'stop';
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'chat.completion', model: 'fixture', created,
        choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, reason) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'fixture', created,
      choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    frame(call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : message, null);
    frame({}, finish_reason); response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, config: { npm: '@ai-sdk/openai-compatible', name: 'Revert fixture',
    options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-fixture' },
    models: { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } } },
    stop: () => new Promise((resolve) => server.close(resolve)) };
}
