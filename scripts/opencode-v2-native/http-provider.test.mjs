import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpProvider, createHttpProviderConfiguration } from './http-provider.mjs';

const body = { model: 'smoke-write', stream: true, messages: [{ role: 'user', content: 'owned fixture' }] };
const invoke = (fixture, value = body, options = {}) => fetch(`${fixture.baseURL}/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(value), signal: options.signal,
});
const packets = text => text.split('\n\n').filter(Boolean).map(value => value.slice(6)).map(value => value === '[DONE]' ? value : JSON.parse(value));

test('builtin provider fixture declares only the owned HTTP transport and both real native model routes', () => {
  const config = createHttpProviderConfiguration('http://127.0.0.1:12345/v1');
  const provider = config.providers['devryan-smoke'];
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
  assert.deepEqual(provider.env, []); assert.equal(Object.hasOwn(provider.settings, 'apiKey'), false);
  assert.deepEqual(Object.keys(provider.models), ['smoke-write', 'gpt-5-native-smoke']);
  assert.equal(config.agents.orchestrator.mode, 'primary'); assert.equal(config.agents.fixer.mode, 'subagent');
  assert.throws(() => createHttpProviderConfiguration('https://example.invalid/v1'), /configuration_invalid/);
});

test('configured HTTP provider emits exact native tool call and final OpenAI SSE packets', async () => {
  const observations = [];
  const fixture = await createHttpProvider({ responder: request => {
    assert.equal(request.body.model, 'smoke-write');
    return { items: [{ type: 'toolCall', index: 0, id: 'native_write', name: 'write', input: { path: 'x', content: 'y' } }], reason: 'tool-calls' };
  }, onRequest: row => observations.push(row) });
  try {
    const response = await invoke(fixture); assert.equal(response.status, 200);
    const chunks = packets(await response.text());
    assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"path":"x","content":"y"}');
    assert.equal(chunks.at(-2).choices[0].finish_reason, 'tool_calls'); assert.equal(chunks.at(-1), '[DONE]');
    await fixture.setResponder(() => ({ items: [{ type: 'textDelta', text: 'actual continuation' }], reason: 'stop' }));
    const final = packets(await (await invoke(fixture)).text());
    assert.equal(final[1].choices[0].delta.content, 'actual continuation');
    assert.equal(final.at(-2).choices[0].finish_reason, 'stop');
    assert.equal(observations.length, 2); assert.ok(observations.every(row => row.requestSha256 && row.completedAt));
    assert.equal(observations.some(row => Object.hasOwn(row, 'body')), false);
  } finally { await fixture.close(); }
});

test('held model response aborts on owned controller disconnect and permits a fresh responder', async () => {
  let entered;
  const held = new Promise(resolve => { entered = resolve; });
  const fixture = await createHttpProvider({ responder: () => { entered(); return new Promise(() => {}); }, timeoutMs: 1000 });
  try {
    const abort = new AbortController();
    const request = invoke(fixture, body, { signal: abort.signal });
    await held; abort.abort(); await assert.rejects(request);
    await new Promise(resolve => setTimeout(resolve, 10));
    await fixture.setResponder(() => ({ items: [{ type: 'textDelta', text: 'same notice' }], reason: 'stop' }));
    assert.equal((await invoke(fixture)).status, 200); fixture.check();
  } finally { await fixture.close(); }
});

test('declared real HTTP 429 reaches native failover without poisoning the fixture', async () => {
  const observations = [];
  const fixture = await createHttpProvider({ responder: () => ({ rateLimited: true }), onRequest: row => observations.push(row) });
  try {
    const response = await invoke(fixture); assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'rate_limit_exceeded');
    await fixture.setResponder(() => ({ items: [{ type: 'textDelta', text: 'fallback completed' }], reason: 'stop' }));
    const recovered = await invoke(fixture); assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /fallback completed/);
    assert.deepEqual(observations.map(row => row.reason), ['rate-limit', 'stop']); fixture.check();
  } finally { await fixture.close(); }
});

test('malformed responder output and inherited provider credentials fail without successful SSE', async () => {
  for (const options of [{ responder: () => ({ items: [{ type: 'fake-tool-result' }], reason: 'stop' }) },
    { responder: () => ({ items: [], reason: 'stop' }), headers: { authorization: 'Bearer fixture-only-unexpected' } }]) {
    const fixture = await createHttpProvider(options);
    const response = await invoke(fixture, body, options);
    assert.equal(response.status, 500); assert.match(response.headers.get('content-type'), /json/);
    assert.throws(fixture.check); await assert.rejects(fixture.close());
  }
});

test('shutdown settles an intentionally held model response without keeping sockets alive', async () => {
  let entered; const held = new Promise(resolve => { entered = resolve; });
  const fixture = await createHttpProvider({ responder: () => { entered(); return new Promise(() => {}); } });
  const request = invoke(fixture); await held;
  await fixture.close(); await assert.rejects(request); assert.throws(fixture.check, /closed/);
});

test('streaming is opt-in and real text is visible before finish without manufacturing a terminal packet', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reply = () => ({ items: (async function* () {
    yield { type: 'textDelta', text: 'original progressing text' }; await gate;
    yield { type: 'textDelta', text: ' final text' };
  })(), reason: 'stop' });
  const disabled = await createHttpProvider({ responder: reply });
  try {
    assert.equal((await invoke(disabled)).status, 500); assert.throws(disabled.check, /reply_invalid/);
  } finally { await assert.rejects(disabled.close()); }
  const fixture = await createHttpProvider({ responder: reply, allowStreaming: true });
  try {
    const response = await invoke(fixture), reader = response.body.getReader();
    let first = '';
    while (!first.includes('original progressing text')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      first += new TextDecoder().decode(chunk.value);
    }
    assert.match(first, /original progressing text/); assert.doesNotMatch(first, /\[DONE\]|"finish_reason":"stop"/);
    release(); let text = first;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
    reader.releaseLock();
    const rows = packets(text); assert.equal(rows.at(-2).choices[0].finish_reason, 'stop'); assert.equal(rows.at(-1), '[DONE]');
    fixture.check();
  } finally { release(); await fixture.close(); }
});

test('stalled streaming iterator cannot retain sockets on close or bypass absolute response timeout', { timeout: 5000 }, async () => {
  for (const closeEarly of [true, false]) {
    let returns = 0;
    const fixture = await createHttpProvider({ allowStreaming: true, timeoutMs: closeEarly ? 1000 : 20,
      responder: () => ({ reason: 'stop', items: { [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}), return: () => { returns++; return new Promise(() => {}); },
      }) } }) });
    const response = await invoke(fixture), text = response.text().then(value => {
      assert.doesNotMatch(value, /\[DONE\]|"finish_reason":"stop"/); return value;
    }, () => null);
    if (closeEarly) await fixture.close();
    else { await text; assert.throws(fixture.check, /responder_timeout/); await assert.rejects(fixture.close()); }
    await text; assert.equal(returns, 1);
  }
});
