import test from 'node:test';
import assert from 'node:assert/strict';
import * as OpenAI from '@opencode/ai/providers/openai';
import * as OpenAIResponses from '@opencode/ai/protocols/openai-responses';
import { Effect } from 'effect';
import { inspectProviderResponse, toolScenarioRequest, toolScenarios } from './provider-access-smoke.mjs';

test('live smoke diagnostics never retain response bodies or arbitrary headers', async () => {
  const result = await inspectProviderResponse(Response.json({ error: { code: 'insufficient_quota', param: 'tools', message: 'private sentinel' } }, {
    status: 429, headers: { 'set-cookie': 'private sentinel', 'x-codex-primary-used-percent': '100' },
  }), { id: 'openai' });
  assert.equal(result.outcome, 'provider-refused');
  assert.equal(result.providerCode, 'insufficient_quota');
  assert.deepEqual(result.quotaHeadersPresent, ['x-codex-primary-used-percent']);
  assert.equal(JSON.stringify(result).includes('private sentinel'), false);
});

test('incomplete stream does not receive a response adapter', async () => {
  const result = await inspectProviderResponse(new Response('data: {"type":"response.created"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.nativeParserAccepted, true);
});

test('native parser failure exposes only known provider fields', async () => {
  const result = await inspectProviderResponse(new Response('data: {"type":"error","error":{"code":"subscription_sharing_usage_limit_exceeded","param":"tools","message":"private sentinel"}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol });
  assert.equal(result.outcome, 'provider-refused');
  assert.equal(result.stage, 'native-event-step');
  assert.equal(result.providerCode, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(result.providerParam, 'tools');
  assert.equal(JSON.stringify(result).includes('private sentinel'), false);
});

test('native parser smoke recognizes a completed OK response', async () => {
  const events = [{ type: 'response.output_item.added', item: { type: 'message', id: 'fixture', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'fixture', delta: 'OK' },
    { type: 'response.completed', response: { status: 'completed' } }];
  const result = await inspectProviderResponse(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  }), { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.answerWasOk, true);
  assert.equal(result.nativeParserAccepted, true);
  const mislabelled = await inspectProviderResponse(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers:{'content-type':'text/plain'}}),
    { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol });
  assert.equal(mislabelled.replayWithSseHeader.outcome, 'completed');
  assert.equal(mislabelled.replayWithSseHeader.answerWasOk, true);
  const headerless = await inspectProviderResponse(new Response(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))),
    { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol });
  assert.equal(headerless.outcome, 'completed');
  assert.equal(headerless.answerWasOk, true);
});

test('non-SSE success response is classified without retaining its body', async () => {
  const result = await inspectProviderResponse(Response.json({ error: { code: 'subscription_sharing_usage_unavailable', message: 'private sentinel' } }), { id: 'openai' });
  assert.equal(result.mediaType, 'application/json');
  assert.equal(result.bodyKind, 'json');
  assert.equal(result.providerCode, 'subscription_sharing_usage_unavailable');
  assert.equal(JSON.stringify(result).includes('private sentinel'), false);
  const mislabelled = await inspectProviderResponse(new Response('data: {"type":"response.completed"}\n\n', {headers:{'content-type':'text/plain'}}), { id: 'openai' });
  assert.equal(mislabelled.bodyKind, 'sse');
});

test('tool scenarios send the native tool-bearing body with flat tools', async () => {
  const provider = { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol };
  assert.deepEqual(toolScenarios.map(scenario => scenario.id), ['tools-available', 'tool-call', 'tool-result']);
  for (const scenario of toolScenarios) {
    const native = await Effect.runPromise(provider.protocol.body.from(toolScenarioRequest(provider, scenario)));
    assert.deepEqual(native.tools.map(tool => tool.name), ['lookup_code']);
    const sent = JSON.parse(JSON.stringify(native));
    assert.deepEqual(sent.tools.map(tool => tool.name), ['lookup_code']);
    assert.equal(sent.input.some(item => item.type === 'additional_tools'), false);
    assert.equal(sent.input.every(item => item.type === 'additional_tools' || item.type !== 'message' || typeof item.role === 'string'), true);
  }
  const result = await Effect.runPromise(provider.protocol.body.from(toolScenarioRequest(provider, toolScenarios[2])));
  assert.deepEqual(result.input.map(item => item.type), ['message', 'function_call', 'function_call_output']);
});

test('native parser smoke recognizes the requested tool call', async () => {
  const provider = { id: 'openai', api: OpenAI, model: 'fixture', protocol: OpenAIResponses.protocol };
  const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup_code', arguments: '{"ticket":"A1"}', status: 'completed' };
  const events = [{ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_fixture', output_index: 0, delta: call.arguments },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { status: 'completed', output: [call] } }];
  const result = await inspectProviderResponse(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  }), provider, toolScenarioRequest(provider, toolScenarios[1]));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.lookupCalled, true);
  assert.equal(result.answerWasOk, false);
});
