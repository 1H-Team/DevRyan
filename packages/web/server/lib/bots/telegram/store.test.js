import { expect, test } from 'vitest';
import { createTelegramStore, telegramMissingSchema } from './store.js';

test('Telegram repositories use explicit selects and the actual Supabase RPC transport', async () => {
  const calls = [];
  const supabase = { async rest(table, options) { calls.push({ table, options }); return []; }, async rpc(name, body) { calls.push({ name, body }); return true; } };
  const store = createTelegramStore({ supabase });
  await store.get('connections', { bot_id: 'bot' });
  expect(calls[0].table).toBe('bot_telegram_connections');
  expect(calls[0].options.select).not.toContain('*');
  expect(calls[0].options.query).toEqual({ bot_id: 'eq.bot', limit: 1 });
  await store.lease('bot', 'generation', 'owner');
  expect(calls[1]).toEqual({ name: 'devryan_bot_telegram_lease', body: { p_bot_id: 'bot', p_generation: 'generation', p_owner: 'owner' } });
  await store.ingest('bot', 'generation', 'owner', []);
  expect(calls[2].name).toBe('devryan_bot_telegram_ingest');
  await store.routineResults('bot', 'generation'); expect(calls[3].name).toBe('devryan_bot_telegram_routine_results');
  await store.listWork('inbox', { bot_id: 'bot', request_kind: 'command' }, { state: 'in.(received,ready)', limit: 25 });
  expect(calls[4].options.select).toContain('request_kind,cancel_requested_at');
  expect(calls[4].options.select).not.toContain('payload_envelope');
  expect(calls[4].options.query).toMatchObject({ bot_id: 'eq.bot', request_kind: 'eq.command', state: 'in.(received,ready)', limit: 25 });
  await store.listWork('outbox', { bot_id: 'bot' });
  expect(calls[5].options.select).not.toContain('payload_envelope');
  expect(telegramMissingSchema({ payload: { code: '42P01' } })).toBe(true);
  expect(telegramMissingSchema({ code: 'network_failed' })).toBe(false);
});
