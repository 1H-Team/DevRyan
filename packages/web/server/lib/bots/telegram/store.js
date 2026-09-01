/** Service-only explicit selects. This repository intentionally does not join the model credential repositories. */
const COLUMNS = Object.freeze({
  connections: 'bot_id,generation,enabled,telegram_bot_id,username,credential_id,update_offset,state,error_code,lease_owner,lease_until,created_at,updated_at',
  pairings: 'id,bot_id,generation,user_id,nonce_hash,state,telegram_user_id,chat_id,display_name,channel_id,routine_delivery,routine_subscribed_at,voice_replies,expires_at,confirmed_at,created_at,updated_at',
  inbox: 'id,bot_id,generation,update_id,pairing_id,user_id,channel_id,message_id,run_id,state,request_kind,cancel_requested_at,payload_envelope,error_code,attempts,next_attempt_at,created_at,updated_at',
  outbox: 'id,bot_id,generation,pairing_id,user_id,channel_id,source_key,kind,state,payload_envelope,part_index,attempts,next_attempt_at,error_code,created_at,updated_at',
});
export const TELEGRAM_REQUIRED_MIGRATION = 'bot_telegram_transport';
const first = (value) => Array.isArray(value) ? value[0] || null : value || null;
export const telegramMissingSchema = (error) => ['42P01', 'PGRST205', 'PGRST202'].includes(error?.code || error?.payload?.code);
export function createTelegramStore({ supabase } = {}) {
  if (typeof supabase?.rest !== 'function') throw new TypeError('Telegram requires the service-only Supabase transport');
  const table = (name) => {
    if (!Object.hasOwn(COLUMNS, name)) throw new TypeError('Unknown Telegram repository');
    return `bot_telegram_${name}`;
  };
  const filters = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value === null ? 'is.null' : `eq.${value}`]));
  const call = (name, options) => supabase.rest(table(name), { select: COLUMNS[name], ...options });
  const rpc = (name, body) => supabase.rpc(`devryan_bot_telegram_${name}`, body);
  return Object.freeze({
    get: async (name, keys) => first(await call(name, { query: { ...filters(keys), limit: 1 }, maybeSingle: true })),
    list: async (name, keys = {}, query = {}) => (await call(name, { query: { ...filters(keys), order: 'created_at.asc', limit: 100, ...query } })) || [],
    listWork: async (name, keys = {}, query = {}) => (await call(name, { select: COLUMNS[name].split(',').filter((column) => column !== 'payload_envelope').join(','), query: { ...filters(keys), order: 'created_at.asc', limit: 50, ...query } })) || [],
    insert: async (name, body) => first(await call(name, { method: 'POST', body, maybeSingle: true })),
    patch: async (name, keys, body) => first(await call(name, { method: 'PATCH', query: filters(keys), body, maybeSingle: true })),
    remove: (name, keys) => call(name, { method: 'DELETE', query: filters(keys) }),
    lease: (botId, generation, ownerId) => rpc('lease', { p_bot_id: botId, p_generation: generation, p_owner: ownerId }),
    ingest: (botId, generation, ownerId, items) => rpc('ingest', { p_bot_id: botId, p_generation: generation, p_owner: ownerId, p_items: items }),
    confirm: (botId, generation, pairingId, userId) => rpc('confirm', { p_bot_id: botId, p_generation: generation, p_pairing_id: pairingId, p_user_id: userId }),
    prune: () => rpc('prune', {}),
    routineResults: (botId, generation) => rpc('routine_results', { p_bot_id: botId, p_generation: generation }),
  });
}
