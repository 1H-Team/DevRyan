import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finishReasons = { stop: 'stop', 'tool-calls': 'tool_calls', length: 'length', 'content-filter': 'content_filter' };
const failure = code => Object.assign(new Error(code), { code });

export function createHttpProviderConfiguration(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || !url.port
    || url.username || url.password || url.search || url.hash) throw failure('http_provider_configuration_invalid');
  const model = () => ({ capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 32768, input: 16384, output: 4096 } });
  return { model: 'devryan-smoke/smoke-write', providers: { 'devryan-smoke': {
    package: '@opencode/ai/providers/openai-compatible', env: [], settings: { baseURL, transport: 'http' },
    models: { 'smoke-write': model(), 'gpt-5-native-smoke': model() },
  } }, agents: { orchestrator: { mode: 'primary', model: 'devryan-smoke/smoke-write' },
    fixer: { mode: 'subagent', model: 'devryan-smoke/smoke-write' }, title: { disabled: true } } };
}

/** Fixture model output over the configured production HTTP provider. No SDK overrides or tool execution. */
export async function createHttpProvider({ responder, timeoutMs = 60_000, maxRequests = 512,
  maxBodyBytes = 1024 * 1024, onRequest = () => {}, allowStreaming = false } = {}) {
  if (typeof responder !== 'function' || ![timeoutMs, maxRequests, maxBodyBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Invalid HTTP provider fixture bounds');
  }
  if (typeof allowStreaming !== 'boolean') throw new TypeError('Invalid HTTP provider streaming option');
  let currentResponder = responder, firstFailure, closed = false;
  const requests = [], active = new Set(), controllers = new Set(), sockets = new Set();
  const check = () => { if (firstFailure) throw firstFailure; if (closed) throw failure('http_provider_closed'); };
  const serve = async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end(); return;
    }
    const abort = new AbortController(); controllers.add(abort);
    const disconnected = () => { if (!response.writableEnded) abort.abort(failure('http_provider_disconnected')); };
    response.once('close', disconnected);
    let timer;
    let observation;
    try {
      check();
      // This lane must never discover or transmit an inherited provider key.
      if (request.headers.authorization || request.headers['x-api-key']) throw failure('http_provider_credentials_unexpected');
      let bytes = 0; const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) throw failure('http_provider_body_bound');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(body) || typeof body.model !== 'string' || !body.model || body.stream !== true || !Array.isArray(body.messages)) {
        throw failure('http_provider_request_invalid');
      }
      if (requests.length >= maxRequests) throw failure('http_provider_request_bound');
      const id = `http_${requests.length + 1}`;
      const invocation = { id, url: `http://127.0.0.1:${server.address().port}${request.url}`, body };
      observation = { requestID: id, model: body.model, startedAt: Date.now(),
        requestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
      requests.push(invocation);
      const aborted = new Promise((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
        timer = setTimeout(() => abort.abort(failure('http_provider_responder_timeout')), timeoutMs);
        if (abort.signal.aborted) reject(abort.signal.reason);
      });
      const reply = await Promise.race([Promise.resolve().then(() => currentResponder(invocation, abort.signal)), aborted]);
      if (abort.signal.aborted) throw abort.signal.reason;
      if (record(reply) && reply.rateLimited === true && Object.keys(reply).length === 1) {
        response.writeHead(429, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: { message: 'Fixture provider rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
        observation.completedAt = Date.now(); observation.reason = 'rate-limit';
        return;
      }
      if (!record(reply) || !Object.hasOwn(finishReasons, reply.reason)) throw failure('http_provider_reply_invalid');
      const streaming = allowStreaming && typeof reply.items?.[Symbol.asyncIterator] === 'function';
      if (!Array.isArray(reply.items) && !streaming) throw failure('http_provider_reply_invalid');
      // Buffered replies validate every item before headers. The opt-in
      // correctness stream validates each delta before writing that delta.
      const deltaFor = item => {
        if (record(item) && item.type === 'textDelta' && typeof item.text === 'string') return { content: item.text };
        if (record(item) && item.type === 'toolCall' && Number.isSafeInteger(item.index) && item.index >= 0
          && typeof item.id === 'string' && item.id && typeof item.name === 'string' && item.name && Object.hasOwn(item, 'input')) {
          return { tool_calls: [{ index: item.index, id: item.id, type: 'function',
            function: { name: item.name, arguments: JSON.stringify(item.input) } }] };
        }
        throw failure('http_provider_reply_item_invalid');
      };
      const packet = (delta, finish_reason = null) => ({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk',
        created: Math.floor(observation.startedAt / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] });
      if (streaming) {
        let outputBytes = 0;
        const write = value => {
          abort.signal.throwIfAborted();
          outputBytes += Buffer.byteLength(value);
          if (outputBytes > maxBodyBytes) throw failure('http_provider_output_bound');
          response.write(value);
        };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
        write(`data: ${JSON.stringify(packet({ role: 'assistant' }))}\n\n`);
        const iterator = reply.items[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done) break;
            write(`data: ${JSON.stringify(packet(deltaFor(next.value)))}\n\n`);
          }
        } finally {
          // An uncooperative fixture iterator must not hold the provider's
          // original socket/active-request shutdown barrier indefinitely.
          try {
            Promise.resolve(iterator.return?.()).catch(() => { firstFailure ??= failure('http_provider_stream_cleanup_failed'); });
          } catch { firstFailure ??= failure('http_provider_stream_cleanup_failed'); }
        }
        write(`data: ${JSON.stringify(packet({}, finishReasons[reply.reason]))}\n\ndata: [DONE]\n\n`);
        response.end(); observation.completedAt = Date.now(); observation.reason = reply.reason;
        return;
      }
      const deltas = reply.items.map(deltaFor);
      const stream = [{ role: 'assistant' }, ...deltas].map(delta => packet(delta));
      stream.push(packet({}, finishReasons[reply.reason]));
      const output = `${stream.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`;
      if (Buffer.byteLength(output) > maxBodyBytes) throw failure('http_provider_output_bound');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
      response.end(output);
      observation.completedAt = Date.now(); observation.reason = reply.reason;
    } catch (error) {
      if (error?.code === 'http_provider_disconnected' || error?.code === 'http_provider_closed') {
        if (observation) observation.aborted = true;
      } else {
        firstFailure ??= error;
        if (observation) observation.error = error?.code ?? 'http_provider_fixture_failed';
        if (!response.destroyed) {
          if (response.headersSent) response.destroy();
          else response.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
            .end(JSON.stringify({ error: { message: error?.code ?? 'http_provider_fixture_failed', type: 'fixture_error' } }));
        }
      }
    } finally {
      clearTimeout(timer); controllers.delete(abort); response.off('close', disconnected);
      if (observation) onRequest({ ...observation });
    }
  };
  const server = createServer((request, response) => {
    const work = serve(request, response).catch(error => { firstFailure ??= error; response.destroy(); })
      .finally(() => active.delete(work));
    active.add(work);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, check,
    setResponder: async next => {
      check(); if (typeof next !== 'function') throw new TypeError('HTTP provider responder required');
      await Promise.all(active); check(); currentResponder = next;
    },
    close: async () => {
      if (!closed) {
        closed = true;
        for (const controller of controllers) controller.abort(failure('http_provider_closed'));
        const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
        await stopped;
      }
      await Promise.allSettled(active);
      if (firstFailure) throw firstFailure;
    },
  };
}
