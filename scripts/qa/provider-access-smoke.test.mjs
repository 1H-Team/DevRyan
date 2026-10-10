import test from 'node:test';
import assert from 'node:assert/strict';
import * as OpenAI from '@opencode/ai/providers/openai';
import * as OpenAIResponses from '@opencode/ai/protocols/openai-responses';
import { inspectProviderResponse } from './provider-access-smoke.mjs';

test('live smoke diagnostics never retain response bodies or arbitrary headers', async () => {
  const result = await inspectProviderResponse(Response.json({ error: { code: 'insufficient_quota', param: 'tools', message: 'private sentinel' } }, {
    status: 429, headers: { 'set-cookie': 'private sentinel', 'x-codex-primary-used-percent': '100' },
  }), { id: 'openai' });
  assert.equal(result.outcome, 'provider-refused');
  assert.equal(result.providerCode, 'insufficient_quota');
  assert.deepEqual(result.quotaHeadersPresent, ['x-codex-primary-used-percent']);
  assert.equal(JSON.stringify(result).includes('private sentinel'), false);
});

test('stream policy failure retains safe stage and code', async () => {
  const result = await inspectProviderResponse(new Response('data: {"type":"response.created"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), { id: 'openai' });
  assert.deepEqual(result, { status: 200, quotaHeadersPresent: [], outcome: 'failed', stage: 'body-read', policyCode: 'chatgpt_siwc_stream_interrupted' });
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
  const mislabelled = await inspectProviderResponse(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
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
  const mislabelled = await inspectProviderResponse(new Response('data: {"type":"response.completed"}\n\n'), { id: 'openai' });
  assert.equal(mislabelled.bodyKind, 'sse');
});
