import { expect, test } from 'vitest';
import { registerBotTelegramRoutes } from './telegram-routes.js';

const BOT = 'b4000000-0000-4000-8000-000000000001';
const principal = { id: 'a4000000-0000-4000-8000-000000000001' };
function routes(service) {
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((verb) => [verb, (path, ...middleware) => handlers.set(`${verb}:${path}`, middleware.at(-1))]));
  registerBotTelegramRoutes(app, { getService: () => service });
  return async (verb, suffix = '', actor = principal, body = undefined) => {
    const result = { status: 200, body: null };
    const response = { status(code) { result.status = code; return response; }, json(body) { result.body = body; return result; } };
    await handlers.get(`${verb}:/api/bots/:botId/telegram${suffix}`)({ principal: actor, params: { botId: BOT }, body }, response);
    return result;
  };
}

test('Telegram routes fail closed without a managed principal or supported backend', async () => {
  expect((await routes(null)('get', '', null)).status).toBe(401);
  expect((await routes(null)('get')).status).toBe(503);
});

test('Telegram routes retain principal and exact Bot scope across manager/member operations', async () => {
  const calls = [];
  const service = Object.fromEntries(['status', 'configure', 'disconnect', 'createPairing', 'confirmPairing', 'revokePairing', 'setPreferences', 'deliveries', 'retryDelivery'].map((method) => [method, async (...args) => { calls.push({ method, args }); return { enabled: false }; }]));
  const request = routes(service);
  for (const [verb, suffix, method, body] of [
    ['get', '', 'status'], ['put', '', 'configure', { enabled: true }], ['delete', '', 'disconnect'],
    ['post', '/pairing', 'createPairing'], ['post', '/pairing/confirm', 'confirmPairing', { pairingId: 'candidate' }], ['delete', '/pairing', 'revokePairing'],
    ['put', '/preferences', 'setPreferences', { routineDelivery: false, voiceReplies: true }], ['get', '/deliveries', 'deliveries'], ['post', '/deliveries/retry', 'retryDelivery', { deliveryId: 'delivery' }],
  ]) {
    expect((await request(verb, suffix, principal, body)).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method, args: body ? [principal, BOT, body] : [principal, BOT] });
  }
});

test('Telegram routes never surface internal upstream error messages', async () => {
  const request = routes({ status: async () => { throw Object.assign(new Error('private upstream token'), { code: 'telegram_transport_failed', statusCode: 502 }); } });
  const response = await request('get'); expect(response.status).toBe(502); expect(JSON.stringify(response.body)).not.toContain('private upstream');
});
