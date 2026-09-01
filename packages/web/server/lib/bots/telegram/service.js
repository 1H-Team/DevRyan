import crypto from 'node:crypto';
import path from 'node:path';
import { createBotCredentialVault } from '../credential-vault.js';
import { decryptBotJson, encryptBotJson } from '../encryption.js';
import { messageAssociatedData } from '../channels.js';
import { withBotAbort } from '../request-lifetime.js';
import { assertExactObject, validateUuid } from '../validation.js';
import { createTelegramClient, splitTelegramText, telegramNumericId, TelegramError, TELEGRAM_MEDIA_MAX_BYTES } from './client.js';
import { createTelegramStore, telegramMissingSchema, TELEGRAM_REQUIRED_MIGRATION } from './store.js';
import { createTelegramJobScheduler } from './jobs.js';

const terminalRuns = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const activeInbox = new Set(['received', 'preparing', 'transcribing', 'ready', 'admitting', 'admission_uncertain', 'admitted', 'quota_rejected']);
const error = (code, statusCode = 409) => new TelegramError(code, { statusCode });
const safeCode = (value) => typeof value === 'string' && /^[a-z0-9_]{1,100}$/.test(value) ? value : 'telegram_operation_failed';
const isDuplicate = (value) => (value?.code || value?.payload?.code) === '23505';
const selectedUpdate = (update) => {
  const msg = update.message;
  const media = (value) => value ? Object.fromEntries(['file_id', 'file_size', 'file_name', 'mime_type', 'duration'].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) : undefined;
  const message = { date: msg.date };
  if (typeof msg.text === 'string') message.text = msg.text;
  if (typeof msg.caption === 'string') message.caption = msg.caption;
  if (msg.voice) message.voice = media(msg.voice);
  else if (msg.document) message.document = media(msg.document);
  else if (Array.isArray(msg.photo) && msg.photo.length) message.photo = [media(msg.photo.at(-1))];
  return { update_id: update.update_id, message };
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const idFor = (value) => { const hash = sha256(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const stateMetadata = (row) => row ? { id: row.id, state: row.state, errorCode: row.error_code, kind: row.kind, partIndex: row.part_index, createdAt: row.created_at, updatedAt: row.updated_at } : null;

/** Native transport adapter. It never calls a model/provider directly and never changes execution models. */
export async function createBotTelegramService({
  supabase, store, authorization, channels, blobStore, encryption, dataDirectory,
  resolvePrincipal, getDispatcher, speech = null, fetchImpl = fetch, now = Date.now,
  logger = null, repository = null, credentialVault = null, isOwner = () => true,
} = {}) {
  if (!authorization || !channels || !store || typeof resolvePrincipal !== 'function' || typeof getDispatcher !== 'function') throw new TypeError('Telegram requires Bot authorization, channels, durable store, principal resolver and dispatcher');
  const db = repository || createTelegramStore({ supabase });
  const vault = credentialVault || await createBotCredentialVault({
    dataDirectory: path.join(dataDirectory, 'bot-integrations', 'telegram'),
    getBotEncryptionKey: () => encryption.getKey(),
  });
  const ownerId = crypto.randomUUID();
  const controllers = new Map();
  const locks = new Map();
  const pollBackoff = new Map();
  const jobs = createTelegramJobScheduler();
  const listWork = (name, keys, query) => db.listWork(name, keys, query);
  let scanCursor = 0;
  let connectionPageAfter = null;
  let pollAfter = null;
  let running = false;
  let stopped = false;
  let timer = null;
  let background = null;
  let migrationMissing = false;
  let lastPrune = 0;
  const timestamp = () => new Date(now()).toISOString();
  const abortOwnedWork = () => {
    const reason = error('telegram_owner_unavailable', 503);
    for (const controller of controllers.values()) controller.abort(reason);
    jobs.abortWhere(() => true, reason);
    return reason;
  };
  const assertOwner = async () => { if (stopped || !await isOwner()) throw abortOwnedWork(); };
  const waitForJob = (signal, operation) => {
    signal?.throwIfAborted();
    return withBotAbort(operation(), signal);
  };
  const serial = (key, action) => {
    const previous = locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    locks.set(key, pending);
    return pending.finally(() => { if (locks.get(key) === pending) locks.delete(key); });
  };
  const crypt = async (kind, id, value, decrypt = false) => {
    const provided = await encryption.getKey();
    const key = Buffer.from(provided || []);
    try {
      const associatedData = kind === 'message' ? id : `devryan:telegram:${kind}:${id}`;
      return decrypt ? decryptBotJson({ key, envelope: value, expectedKeyId: 'deployment-v1', associatedData }) : encryptBotJson({ key, value, keyId: 'deployment-v1', associatedData });
    } finally { key.fill(0); if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0); }
  };
  const freshAccount = async (userId) => {
    const principal = await resolvePrincipal(userId);
    if (!principal || principal.id !== userId || principal.status === 'suspended' || principal.status === 'deleted') throw error('telegram_access_revoked', 403);
    return principal;
  };
  const freshPrincipal = async (userId, botId) => {
    const principal = await freshAccount(userId);
    await authorization.requireActiveMembership(principal, botId);
    return principal;
  };
  const member = async (principal, botId, manager = false) => {
    const id = validateUuid(botId, 'botId');
    if (!principal?.id) throw error('telegram_authentication_required', 401);
    const current = await freshAccount(principal.id);
    if (manager) await authorization.requireManager(current, id);
    else await authorization.requireActiveMembership(current, id);
    return current;
  };
  const activePairing = (botId, userId, generation) => db.get('pairings', { bot_id: botId, user_id: userId, generation, state: 'confirmed' });
  const binding = async (row) => {
    const connection = await db.get('connections', { bot_id: row.bot_id });
    if (!connection?.enabled || connection.generation !== row.generation) throw error('telegram_connection_changed', 403);
    const pairing = await db.get('pairings', { id: row.pairing_id, bot_id: row.bot_id, generation: row.generation, state: 'confirmed' });
    if (!pairing || pairing.user_id !== row.user_id || pairing.channel_id !== row.channel_id) throw error('telegram_pairing_revoked', 403);
    const principal = await freshPrincipal(row.user_id, row.bot_id);
    await channels.authorizeChannelSend({ principal, channelId: row.channel_id });
    return { connection, pairing, principal };
  };
  const clientFor = async (connection) => {
    const { credential, secret } = await vault.read(connection.credential_id);
    if (credential.botId !== connection.bot_id || credential.provider !== 'telegram') throw error('telegram_credential_invalid');
    return createTelegramClient({ token: secret.token, fetchImpl });
  };
  const lease = async (connection) => {
    await assertOwner();
    const held = await db.lease(connection.bot_id, connection.generation, ownerId);
    if (held !== true) {
      const reason = error('telegram_owner_unavailable', 503);
      jobs.abortWhere((job) => job.botId === connection.bot_id, reason);
      throw reason;
    }
  };
  const queue = async ({ botId, generation, pairing, key, parts, kind = 'notice', voiceText = null }) => {
    const id = idFor(`telegram:${botId}:${generation}:${pairing.id}:${key}`);
    const body = { parts, voiceText };
    try {
      return await db.insert('outbox', { id, bot_id: botId, generation, pairing_id: pairing.id, user_id: pairing.user_id, channel_id: pairing.channel_id, source_key: key, kind, state: 'pending', payload_envelope: await crypt('outbox', id, body), part_index: 0, attempts: 0, next_attempt_at: timestamp(), error_code: null });
    } catch (failure) { if (!isDuplicate(failure)) throw failure; return db.get('outbox', { id }); }
  };
  const notice = (connection, pairing, key, text) => queue({ botId: connection.bot_id, generation: connection.generation, pairing, key, parts: splitTelegramText(text).map((text) => ({ type: 'text', text })) });
  const patchInbox = (row, changes) => db.patch('inbox', { id: row.id, state: row.state }, changes);

  const readCanonical = async (run, principal) => {
    await channels.authorizeChannelRead({ principal, channelId: run.channel_id });
    const row = await store.repositories.bot_messages.get({ run_id: run.id, channel_id: run.channel_id, role: 'assistant', assistant_phase: 'result' });
    if (!row?.finalized_at) return null;
    const body = await crypt('message', messageAssociatedData(row.channel_id, row.id), row.body_envelope, true);
    if (body?.version !== 1 || typeof body.text !== 'string' || !Array.isArray(body.attachmentIds)) throw error('telegram_canonical_result_invalid');
    return { text: body.text, attachmentIds: body.attachmentIds.map((id) => validateUuid(id, 'attachmentId')) };
  };

  const queueResult = async (connection, pairing, run, principal, voice = false) => {
    const result = await readCanonical(run, principal);
    if (!result && run.state === 'completed') return false; // Durable terminal message can land after the run state.
    const text = result?.text || (run.state === 'cancelled' ? 'This request was cancelled.' : run.state === 'completed' && result?.attachmentIds.length ? '' : 'The bot could not complete this request. Open this conversation in DevRyan for details.');
    const parts = [...splitTelegramText(text).map((text) => ({ type: 'text', text })), ...(result?.attachmentIds || []).map((objectId) => ({ type: 'file', objectId }))];
    await queue({ botId: connection.bot_id, generation: connection.generation, pairing, key: `run:${run.id}`, kind: 'result', parts,
      voiceText: voice && pairing.voice_replies && result?.text ? result.text : null });
    return true;
  };

  const reconcileInbox = async (row) => {
    const { connection, pairing, principal } = await binding(row);
    const run = await store.repositories.bot_runs.get({ id: row.run_id, channel_id: row.channel_id, bot_id: row.bot_id });
    if (!run) throw error('telegram_run_missing');
    if (['waiting_approval', 'waiting_control', 'needs_reconciliation'].includes(run.state)) {
      await notice(connection, pairing, `waiting:${run.id}:${run.state}`, 'Your bot needs attention. Open this conversation in authenticated DevRyan to review approvals or take control of the shared computer.');
    }
    if (!terminalRuns.has(run.state)) return;
    const payload = await crypt('inbox', row.id, row.payload_envelope, true);
    if (await queueResult(connection, pairing, run, principal, payload.prepared?.voice === true)) await patchInbox(row, { state: 'settled' });
  };

  const reconcileCancelledAdmission = async (row, knownMessage = null, signal) => {
    const ctx = await binding(row);
    const message = knownMessage || (row.run_id ? { run_id: row.run_id } : await store.repositories.bot_messages.get({ id: row.message_id, channel_id: row.channel_id, role: 'user' }));
    if (message?.run_id) {
      const run = await store.repositories.bot_runs.get({ id: message.run_id, channel_id: row.channel_id });
      if (!run || !terminalRuns.has(run.state)) {
        const dispatcher = getDispatcher();
        if (!dispatcher) { await patchInbox(row, { state: row.state === 'admitted' ? 'admitted' : 'admission_uncertain', next_attempt_at: new Date(now() + 5000).toISOString() }); return; }
        await lease(ctx.connection);
        await waitForJob(signal, () => dispatcher.cancelRun({ principal: ctx.principal, runId: message.run_id }));
      }
      await patchInbox(row, { state: row.state === 'settled' ? 'settled' : 'admitted', run_id: message.run_id, error_code: 'telegram_cancel_requested' });
    } else if (['admitting', 'admission_uncertain'].includes(row.state)) {
      // An uncertain admission is inspected only, never replayed after cancellation.
      const expired = now() - Date.parse(row.cancel_requested_at) > 24 * 60 * 60_000;
      await patchInbox(row, { state: expired ? 'rejected' : 'admission_uncertain', error_code: expired ? 'telegram_cancel_admission_unconfirmed' : 'telegram_cancel_requested', next_attempt_at: new Date(now() + 5000).toISOString() });
    } else await patchInbox(row, { state: 'rejected', error_code: 'telegram_request_cancelled' });
  };

  const cancelVoice = async (original, signal) => {
    let row = original;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!row || row.state === 'cancelled') return 'Voice reply cancelled. Your complete text answer remains available.';
      if (row.state === 'delivered') return 'The voice reply has already been delivered. Your complete text answer remains available.';
      if (!['pending', 'sending', 'synthesis_pending', 'synthesizing'].includes(row.state)) return 'Voice delivery has stopped, but earlier audio delivery may be uncertain. Check delivery status in DevRyan.';
      const ctx = await binding(row); await lease(ctx.connection); signal?.throwIfAborted();
      const uncertain = row.state === 'sending';
      const cancelled = await db.patch('outbox', { id: row.id, state: row.state, generation: row.generation, pairing_id: row.pairing_id }, { state: uncertain ? 'uncertain' : 'cancelled', error_code: uncertain ? 'telegram_voice_cancel_uncertain' : 'telegram_voice_cancelled' });
      if (cancelled) {
        jobs.abortWhere((job) => job.id === `outbox:${row.id}` && job.pairingId === row.pairing_id, error('telegram_voice_cancelled'));
        return uncertain ? 'Voice delivery cancellation requested, but the audio may already have arrived. Your complete text answer remains available.' : 'Voice reply cancelled. Your complete text answer remains available.';
      }
      // Synthesis or sending can advance during the cancellation write. Use
      // metadata only and retry the new state; never claim success after a miss.
      [row] = await listWork('outbox', { id: original.id, generation: original.generation, pairing_id: original.pairing_id }, { limit: 1 });
    }
    throw error('telegram_cancel_retry_required');
  };

  const command = async (row, payload, ctx, text, signal) => {
    const name = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    if (name === '/help' || name === '/start') {
      await notice(ctx.connection, ctx.pairing, `command:${row.id}`, 'Send text, a photo, a document, or a voice message to your bot. /status shows your latest Telegram request; /cancel cancels it. Approvals and shared computer access stay in authenticated DevRyan.');
    } else if (name === '/status' || name === '/cancel') {
      const requests = await listWork('inbox', { bot_id: row.bot_id, generation: row.generation, pairing_id: row.pairing_id }, { request_kind: 'not.in.(command)', state: 'not.in.(rejected,quota_rejected)', update_id: `lt.${row.update_id}`, order: 'update_id.desc', limit: 25 });
      let latest = null;
      let voiceCancellation = null;
      for (const request of requests) {
        if (!['admitted', 'settled'].includes(request.state)) { latest = { request, state: request.state }; break; }
        const run = request.run_id && await store.repositories.bot_runs.get({ id: request.run_id, channel_id: row.channel_id });
        if (run && !terminalRuns.has(run.state)) { latest = { request, run, state: run.state }; break; }
        const [voice] = request.run_id ? await listWork('outbox', { bot_id: row.bot_id, generation: row.generation, pairing_id: row.pairing_id, source_key: `run:${request.run_id}`, kind: 'voice' }, { state: 'in.(pending,sending,synthesis_pending,synthesizing)', limit: 1 }) : [];
        if (voice) { latest = { request, voice, state: 'preparing_voice_reply' }; break; }
      }
      if (latest && name === '/cancel') {
        if (latest.voice) {
          voiceCancellation = await cancelVoice(latest.voice, signal);
        } else {
          // State may advance while the command is waiting on the database. Set
          // only the cancellation marker, then act on the authoritative row.
          const cancelled = await db.patch('inbox', { id: latest.request.id, pairing_id: row.pairing_id, generation: row.generation }, { cancel_requested_at: timestamp(), error_code: 'telegram_cancel_requested', next_attempt_at: timestamp() });
          if (cancelled) {
            jobs.abortWhere((job) => job.id === `inbox:${latest.request.id}` && job.pairingId === row.pairing_id);
            await reconcileCancelledAdmission(cancelled, null, signal);
          }
        }
      }
      await notice(ctx.connection, ctx.pairing, `command:${row.id}`, latest ? name === '/cancel' ? voiceCancellation || 'Cancellation requested for your latest Telegram request.' : `Your latest Telegram request is ${String(latest.state).replaceAll('_', ' ')}.` : 'You have no active Telegram request.');
    } else await notice(ctx.connection, ctx.pairing, `command:${row.id}`, 'Unknown command. Send /help for available commands.');
    await patchInbox(row, { state: 'settled' });
  };

  const processInbox = async (original, signal) => {
    let row = original;
    if (row.state === 'quota_rejected') {
      const ctx = await binding(row); await lease(ctx.connection);
      await notice(ctx.connection, ctx.pairing, `quota:${row.id}`, row.error_code === 'telegram_control_limit' ? 'This command was not performed because too many Telegram commands are queued. Please retry it shortly or open DevRyan to control the request.' : 'Your request was not submitted because this bot’s Telegram queue is full. Please resend it later. You can still use /cancel for your latest pending request.');
      await patchInbox(row, { state: 'rejected' }); return;
    }
    if (row.cancel_requested_at && row.state !== 'admitted') return reconcileCancelledAdmission(row, null, signal);
    if (row.state === 'admitted') {
      if (row.cancel_requested_at) await reconcileCancelledAdmission(row, null, signal);
      return reconcileInbox(row);
    }
    if (row.state === 'transcribing') throw error('telegram_transcription_uncertain');
    if (row.state === 'received') {
      row = await patchInbox(row, { state: 'preparing' });
      if (!row) return;
    }
    const ctx = await binding(row);
    // Admission identity is authoritative even if the response was lost before the inbox was updated.
    const existing = await store.repositories.bot_messages.get({ id: row.message_id, channel_id: row.channel_id, role: 'user' });
    if (existing?.run_id) { await patchInbox(row, { state: 'admitted', run_id: existing.run_id }); return; }
    if (row.state === 'admitting') {
      await patchInbox(row, { state: 'admission_uncertain', error_code: 'telegram_admission_uncertain', next_attempt_at: new Date(now() + 5000).toISOString() });
      return;
    }
    if (row.state === 'admission_uncertain') return;
    const payload = await crypt('inbox', row.id, row.payload_envelope, true);
    const expiresAt = Number(payload.update?.message?.date || 0) * 1000 + 15 * 60_000;
    const expire = async (context) => {
      await notice(context.connection, context.pairing, `expired:${row.id}`, 'Your request expired before the bot could start. Please resend it if you still want it performed.');
      await patchInbox(row, { state: 'rejected', error_code: 'telegram_request_expired' });
    };
    if (now() > expiresAt) return expire(ctx);
    if (!payload.prepared) {
      const msg = payload.update.message;
      let text = msg.text || msg.caption || '';
      if (text.startsWith('/')) return command(row, payload, ctx, text, signal);
      if (!getDispatcher()) {
        await patchInbox(row, { state: 'ready', error_code: 'telegram_runtime_unavailable', next_attempt_at: new Date(now() + 5000).toISOString() });
        return;
      }
      const busy = await db.list('inbox', { bot_id: row.bot_id, pairing_id: row.pairing_id, state: 'admitted' }, { limit: 11 });
      if (busy.length >= 10) throw error('telegram_request_limit', 429);
      const prepared = { text, attachmentIds: [], voice: false };
      const media = msg.voice || msg.document || (Array.isArray(msg.photo) ? msg.photo.at(-1) : null);
      if (media) {
        if (Number(media.file_size) > TELEGRAM_MEDIA_MAX_BYTES) throw error('telegram_payload_too_large', 413);
        if (msg.voice && (!Number.isFinite(msg.voice.duration) || msg.voice.duration > 300 || msg.voice.duration < 0)) throw error('telegram_voice_duration_limit', 413);
        const client = await clientFor(ctx.connection);
        const bytes = await waitForJob(signal, () => client.download({ fileId: media.file_id, signal }));
        await binding(row); // Revocation during download cannot create a new conversation attachment.
        if (msg.voice) {
          if (!speech?.transcribe) throw error('telegram_speech_unavailable', 503);
          row = await patchInbox(row, { state: 'transcribing' });
          if (!row) return;
          const transcript = await waitForJob(signal, () => speech.transcribe({ botId: row.bot_id, principal: ctx.principal, bytes, contentType: media.mime_type || 'audio/ogg', operationId: `telegram-transcription:${row.id}`, signal }));
          if (typeof transcript?.text !== 'string' || !transcript.text.trim()) throw error('telegram_transcription_empty');
          prepared.text = transcript.text;
          prepared.voice = true;
        } else {
          const contentType = msg.photo ? 'image/jpeg' : media.mime_type || 'application/octet-stream';
          const object = await waitForJob(signal, () => blobStore.uploadPrivate({ principal: ctx.principal, botId: row.bot_id, channelId: row.channel_id, bytes, contentType, signal,
            provenance: { source: 'telegram', telegramInboxId: row.id, filename: String(media.file_name || (msg.photo ? 'photo.jpg' : 'document')).replace(/[\r\n\0/\\]/g, '_').slice(0, 120) },
            expiresAt: new Date(now() + 7 * 86400_000).toISOString() }));
          prepared.attachmentIds.push(object.id);
          if (!prepared.text.trim()) prepared.text = 'Please review the attached file.';
        }
      }
      if (!prepared.text.trim() || Buffer.byteLength(prepared.text) > 64 * 1024) throw error('telegram_message_invalid', 400);
      payload.prepared = prepared;
      row = await patchInbox(row, { state: 'ready', payload_envelope: await crypt('inbox', row.id, payload) });
      if (!row) return;
    }
    await binding(row);
    await lease(ctx.connection);
    if (signal?.aborted) return;
    const dispatcher = getDispatcher();
    if (!dispatcher) {
      await patchInbox(row, { state: 'ready', error_code: 'telegram_runtime_unavailable', next_attempt_at: new Date(now() + 5000).toISOString() });
      return;
    }
    row = await patchInbox(row, { state: 'admitting', attempts: (row.attempts || 0) + 1 });
    if (!row) return;
    // The durable transition itself can outlive revocation or an owner handoff.
    const admission = await binding(row);
    await lease(admission.connection);
    if (signal?.aborted) return;
    // Preparation, transcription and persistence never extend the original deadline.
    if (now() > expiresAt) return expire(admission);
    const accepted = await waitForJob(signal, () => dispatcher.enqueueMessage({ principal: admission.principal, channelId: row.channel_id,
      message: { messageId: row.message_id, idempotencyKey: `telegram:${row.bot_id}:${row.generation}:${row.update_id}`, text: payload.prepared.text, attachmentIds: payload.prepared.attachmentIds } }));
    if (!accepted?.run?.id) throw error('telegram_admission_uncertain');
    const current = await db.get('inbox', { id: row.id });
    if (current?.cancel_requested_at) return reconcileCancelledAdmission(current, { run_id: accepted.run.id }, signal);
    await patchInbox(row, { state: 'admitted', run_id: accepted.run.id, error_code: null });
  };

  const receive = async (connection, client, signal, timeout) => {
    await lease(connection);
    const updates = await client.getUpdates({ offset: Number(connection.update_offset), timeout, signal });
    if (!Array.isArray(updates) || updates.length > 25) throw error('telegram_response_invalid', 502);
    const records = [];
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw error('telegram_response_invalid', 502);
      const msg = update.message;
      const id = idFor(`telegram-inbox:${connection.bot_id}:${connection.generation}:${update.update_id}`);
      const content = msg?.text || msg?.caption || '';
      const requestKind = typeof content === 'string' && content.startsWith('/') ? 'command' : msg?.voice ? 'voice' : msg?.document || msg?.photo ? 'media' : 'message';
      const base = { id, update_id: update.update_id, message_id: idFor(`telegram-message:${id}`), request_kind: requestKind, state: 'rejected', error_code: 'telegram_message_unsupported', payload_envelope: await crypt('inbox', id, { update: { update_id: update.update_id } }) };
      base.rejection_envelope = base.payload_envelope;
      if (msg?.chat?.type === 'private' && msg.from?.is_bot === false && msg.from.id === msg.chat.id && Number.isSafeInteger(msg.date)) {
        const telegramId = telegramNumericId(msg.from.id);
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (/^\/start [A-Za-z0-9_-]{43}$/.test(text)) {
          const nonce = text.slice(7);
          const candidate = await db.get('pairings', { bot_id: connection.bot_id, generation: connection.generation, nonce_hash: sha256(nonce), state: 'pending' });
          if (candidate && Date.parse(candidate.expires_at) > now()) {
            try {
              await freshPrincipal(candidate.user_id, connection.bot_id);
              await db.patch('pairings', { id: candidate.id, state: 'pending' }, { state: 'claimed', telegram_user_id: telegramId, chat_id: telegramId, display_name: [msg.from.first_name, msg.from.last_name].filter((value) => typeof value === 'string').join(' ').replace(/[\r\n\0]/g, '').slice(0, 100), nonce_hash: null });
            } catch { base.error_code = 'telegram_access_revoked'; }
          }
          base.error_code = 'telegram_pairing_confirmation_required';
        } else {
          const pairing = await db.get('pairings', { bot_id: connection.bot_id, generation: connection.generation, telegram_user_id: telegramId, state: 'confirmed' });
          if (pairing) {
            try {
              await freshPrincipal(pairing.user_id, connection.bot_id);
              const selected = selectedUpdate(update);
              if (Buffer.byteLength(JSON.stringify(selected)) > 128 * 1024) throw error('telegram_payload_too_large', 413);
              Object.assign(base, { pairing_id: pairing.id, user_id: pairing.user_id, channel_id: pairing.channel_id, state: 'received', error_code: null, payload_envelope: await crypt('inbox', id, { update: selected }) });
            } catch { base.error_code = 'telegram_access_revoked'; }
          } else base.error_code = 'telegram_pairing_required';
        }
      }
      records.push(base);
    }
    // One transaction inserts all inbox rows then advances offset. Never acknowledge before durable acceptance.
    await assertOwner();
    if (records.length && !await db.ingest(connection.bot_id, connection.generation, ownerId, records)) throw error('telegram_owner_unavailable', 503);
  };

  const deliver = async (original, signal) => {
    let row = original;
    if (['sending', 'synthesizing'].includes(row.state)) {
      await db.patch('outbox', { id: row.id, state: row.state }, { state: 'uncertain', error_code: row.state === 'sending' ? 'telegram_delivery_uncertain' : 'telegram_synthesis_uncertain' }); return;
    }
    const ctx = await binding(row);
    await lease(ctx.connection);
    const payload = await crypt('outbox', row.id, row.payload_envelope, true);
    const client = await clientFor(ctx.connection);
    while (row.part_index < payload.parts.length) {
      if (signal?.aborted) return;
      await binding(row); await lease(ctx.connection);
      const part = payload.parts[row.part_index];
      // Fetch/decrypt attachments before marking a potentially side-effectful Telegram send.
      let file;
      if (part.type === 'file') {
        file = await waitForJob(signal, () => blobStore.download({ principal: ctx.principal, botId: row.bot_id, objectId: part.objectId, signal }));
        if (file.bytes.length > TELEGRAM_MEDIA_MAX_BYTES) throw error('telegram_payload_too_large', 413);
      }
      await binding(row);
      await assertOwner();
      row = await db.patch('outbox', { id: row.id, state: 'pending', part_index: row.part_index }, { state: 'sending', attempts: row.attempts + 1 });
      if (!row) return;
      try {
        const destination = await binding(row);
        await lease(destination.connection);
        signal?.throwIfAborted();
        if (part.type === 'text') await client.sendText({ chatId: destination.pairing.chat_id, text: part.text, signal });
        else if (part.type === 'file') await client.sendFile({ chatId: destination.pairing.chat_id, bytes: file.bytes, contentType: file.object.content_type, filename: file.object.provenance?.filename || `file-${part.objectId}`, signal });
        else if (part.type === 'audio') await client.sendFile({ chatId: destination.pairing.chat_id, bytes: Buffer.from(part.base64, 'base64'), contentType: part.contentType, filename: part.contentType === 'audio/ogg' ? 'reply.ogg' : 'reply.mp3', voice: true, signal });
        else throw error('telegram_delivery_invalid');
      } catch (failure) {
        await db.patch('outbox', { id: row.id, state: 'sending' }, { state: failure.uncertain ? 'uncertain' : failure.statusCode === 403 ? 'cancelled' : failure.retryAfter || failure.code === 'telegram_owner_unavailable' ? 'pending' : 'failed', error_code: safeCode(failure.code), next_attempt_at: new Date(now() + (failure.retryAfter || 30) * 1000).toISOString() });
        return;
      }
      // If this persistence fails, retain 'sending': restart surfaces uncertainty instead of duplicating the part.
      row = await db.patch('outbox', { id: row.id, state: 'sending' }, { state: 'pending', part_index: row.part_index + 1, error_code: null, next_attempt_at: new Date(now() + 1100).toISOString() });
      if (!row) return;
      if (row.part_index < payload.parts.length) return;
    }
    if (payload.voiceText) {
      const text = payload.voiceText;
      if (text.length > 4000 || !speech?.synthesize) {
        payload.voiceText = null;
        payload.parts.push({ type: 'text', text: text.length > 4000 ? 'The complete answer is above. Automatic voice replies are limited to 4,000 characters.' : 'The text answer is complete. Voice replies are unavailable until speech is configured in DevRyan.' });
        await db.patch('outbox', { id: row.id, state: 'pending' }, { payload_envelope: await crypt('outbox', row.id, payload) });
        return;
      }
      // Preserve text progress, but release the delivery lane before optional TTS.
      await db.patch('outbox', { id: row.id, state: 'pending', part_index: row.part_index }, { state: 'synthesis_pending', kind: 'voice', next_attempt_at: timestamp() });
      return;
    }
    await db.patch('outbox', { id: row.id, state: 'pending' }, { state: 'delivered', error_code: null });
  };

  const synthesize = async (original, signal) => {
    if (original.state === 'synthesizing') {
      await db.patch('outbox', { id: original.id, state: 'synthesizing' }, { state: 'uncertain', error_code: 'telegram_synthesis_uncertain' }); return;
    }
    const ctx = await binding(original);
    const payload = await crypt('outbox', original.id, original.payload_envelope, true);
    if (typeof payload.voiceText !== 'string' || !payload.voiceText || !speech?.synthesize) throw error('telegram_speech_unavailable', 503);
    const row = await db.patch('outbox', { id: original.id, state: 'synthesis_pending' }, { state: 'synthesizing' });
    if (!row) return;
    await binding(row); await lease(ctx.connection);
    if (signal.aborted) throw error('telegram_cancelled');
    const audio = await waitForJob(signal, () => speech.synthesize({ botId: row.bot_id, principal: ctx.principal, text: payload.voiceText, operationId: `telegram-synthesis:${row.id}`, signal }));
    if (!Buffer.isBuffer(audio?.bytes) || audio.bytes.length > TELEGRAM_MEDIA_MAX_BYTES || !['audio/ogg', 'audio/mpeg', 'audio/mp4'].includes(audio.contentType)) throw error('telegram_synthesis_invalid');
    payload.voiceText = null;
    payload.parts.push({ type: 'audio', base64: audio.bytes.toString('base64'), contentType: audio.contentType });
    await db.patch('outbox', { id: row.id, state: 'synthesizing' }, { state: 'pending', payload_envelope: await crypt('outbox', row.id, payload), next_attempt_at: new Date(now() + 1100).toISOString() });
  };

  const handleInboxFailure = async (row, failure) => {
    const latest = await db.get('inbox', { id: row.id });
    if (!latest || ['settled', 'rejected'].includes(latest.state)) return;
    if (latest.state === 'quota_rejected') {
      await patchInbox(latest, failure.statusCode === 403 ? { state: 'rejected', error_code: safeCode(failure.code) } : { next_attempt_at: new Date(now() + 30_000).toISOString() }); return;
    }
    if (latest.cancel_requested_at) {
      if (latest.state !== 'admitted') await db.patch('inbox', { id: row.id }, { state: 'admission_uncertain', error_code: 'telegram_cancel_requested', next_attempt_at: new Date(now() + 5000).toISOString() });
      return;
    }
    // Unknown admission is inspected using its stable identity, never resubmitted.
    if (latest.state === 'admitting' && ![400, 401, 403, 404].includes(failure.statusCode)) {
      await db.patch('inbox', { id: row.id }, { state: 'admission_uncertain', error_code: 'telegram_admission_uncertain', next_attempt_at: new Date(now() + 5000).toISOString() }); return;
    }
    if (failure.code === 'telegram_owner_unavailable' && latest.state !== 'transcribing') {
      await db.patch('inbox', { id: row.id }, { next_attempt_at: new Date(now() + 5000).toISOString() }); return;
    }
    await db.patch('inbox', { id: row.id }, { state: 'rejected', error_code: safeCode(failure.code) });
    if (row.pairing_id) {
      try { const ctx = await binding(row); await notice(ctx.connection, ctx.pairing, `failed:${row.id}`, 'This Telegram request could not be processed. Open your bot in DevRyan to inspect the connection and delivery status; resend only if no request was admitted.'); } catch { /* Revoked destinations never receive a notice. */ }
    }
  };

  const launchRow = (connection, table, row, lane) => jobs.start({
    id: `${table}:${row.id}`, botId: row.bot_id, pairingId: row.pairing_id, userId: row.user_id, generation: row.generation, lane,
    operation: async (signal) => {
      try {
        await lease(connection);
        const current = await db.get(table, { id: row.id, generation: connection.generation });
        if (!current || signal.aborted) return;
        if (table === 'inbox') {
          if (activeInbox.has(current.state)) await processInbox(current, signal);
          if (lane === 'reconcile') await db.patch('inbox', { id: row.id, state: current.state, next_attempt_at: current.next_attempt_at }, { next_attempt_at: new Date(now() + 1000).toISOString() });
        }
        else if (!['cancelled', 'delivered', 'failed', 'uncertain'].includes(current.state)) await (lane === 'synthesis' ? synthesize : deliver)(current, signal);
      } catch (failure) {
        if (table === 'inbox') return handleInboxFailure(row, failure);
        const current = await db.get('outbox', { id: row.id });
        if (!current || ['cancelled', 'delivered', 'uncertain'].includes(current.state)) return;
        await db.patch('outbox', { id: row.id, state: current.state }, { state: ['sending', 'synthesizing'].includes(current.state) ? 'uncertain' : failure.statusCode === 403 ? 'cancelled' : 'failed', error_code: safeCode(failure.code) });
      }
    },
  });

  const drain = async (connection, signal, phase) => {
    await lease(connection);
    const started = [];
    const keys = { bot_id: connection.bot_id, generation: connection.generation };
    const excluded = (table) => {
      const ids = jobs.active().filter((job) => job.botId === connection.bot_id && job.id.startsWith(`${table}:`)).map((job) => job.id.slice(table.length + 1));
      return ids.length ? { id: `not.in.(${ids.join(',')})` } : {};
    };
    const query = (table) => ({ next_attempt_at: `lte.${timestamp()}`, order: table === 'inbox' ? 'update_id.asc' : 'created_at.asc', limit: 25, ...excluded(table) });
    if (phase === 'inbox') {
      const lanes = ['message', 'media', 'voice'];
      const offset = scanCursor % lanes.length;
      for (const lane of ['command', 'rejection', 'reconcile', ...lanes.slice(offset), ...lanes.slice(0, offset)]) {
        const rows = await listWork('inbox', ['reconcile', 'rejection'].includes(lane) ? keys : { ...keys, request_kind: lane }, {
          ...query('inbox'), ...(lane === 'reconcile' ? { order: 'next_attempt_at.asc,update_id.asc' } : {}), state: lane === 'rejection' ? 'in.(quota_rejected)' : lane === 'reconcile' ? 'in.(admitted,admission_uncertain)' : 'in.(received,preparing,transcribing,ready,admitting)',
        });
        for (const row of rows) {
          if (signal.aborted) return started;
          const work = launchRow(connection, 'inbox', row, lane === 'rejection' ? 'command' : lane);
          if (work) started.push(work);
        }
      }
    } else if (phase === 'outbox') {
      if (typeof db.routineResults === 'function') {
        const work = jobs.start({ id: `routine:${connection.bot_id}`, botId: connection.bot_id, generation: connection.generation, lane: 'reconcile', operation: async (jobSignal) => {
          await lease(connection);
          for (const run of await db.routineResults(connection.bot_id, connection.generation) || []) {
            if (jobSignal.aborted) return;
            try { await api.notifyRoutineCompleted({ run }); }
            catch (failure) { logger?.warn?.('[BotTelegram] routine delivery deferred', { code: safeCode(failure.code) }); }
          }
        } });
        if (work) started.push(work);
      }
      const destinations = new Set(jobs.active().filter((job) => job.lane === 'delivery').map((job) => job.pairingId));
      // At most two heads are needed for this Bot's two delivery slots. Requery
      // after selecting a destination so its backlog cannot hide other members.
      for (let pass = 0; pass < 2; pass += 1) {
        const before = destinations.size;
        const rows = await listWork('outbox', keys, { ...query('outbox'), ...(destinations.size ? { pairing_id: `not.in.(${[...destinations].join(',')})` } : {}), state: 'in.(pending,sending)' });
        for (const row of rows) {
          if (signal.aborted) return started;
          if (destinations.has(row.pairing_id)) continue;
          const work = launchRow(connection, 'outbox', row, 'delivery');
          if (work) { started.push(work); destinations.add(row.pairing_id); }
        }
        if (destinations.size === before) break;
      }
    } else if (phase === 'synthesis') {
      const rows = await listWork('outbox', keys, { ...query('outbox'), state: 'in.(synthesis_pending,synthesizing)', kind: 'eq.voice' });
      for (const row of rows) { if (signal.aborted) return started; const work = launchRow(connection, 'outbox', row, 'synthesis'); if (work) started.push(work); }
    }
    return started;
  };

  const runConnection = (connection, { poll = true, timeout = 0, phase = 'inbox' } = {}) => serial(`${poll ? 'poll' : 'drain'}:${connection.bot_id}`, async () => {
    if (stopped) return;
    if (poll && (pollBackoff.get(connection.bot_id)?.nextAt || 0) > now()) return;
    const controller = new AbortController();
    const key = `${poll ? 'poll' : 'drain'}:${connection.bot_id}`;
    controllers.set(key, controller);
    try {
      const current = await db.get('connections', { bot_id: connection.bot_id, generation: connection.generation, enabled: true });
      if (stopped || !current || current.state === 'conflict') return;
      if (poll) await receive(current, await clientFor(current), controller.signal, timeout);
      else return await drain(current, controller.signal, phase);
      if (poll) {
        pollBackoff.delete(current.bot_id);
        await db.patch('connections', { bot_id: current.bot_id, generation: current.generation }, { state: 'connected', error_code: null });
      }
    } catch (failure) {
      if (!controller.signal.aborted && failure.code !== 'telegram_owner_unavailable') {
        if (poll) { const attempt = Math.min(6, (pollBackoff.get(connection.bot_id)?.attempt || 0) + 1); pollBackoff.set(connection.bot_id, { attempt, nextAt: now() + Math.min(60_000, 1000 * 2 ** attempt) }); }
        await db.patch('connections', { bot_id: connection.bot_id, generation: connection.generation }, { state: failure.code === 'telegram_consumer_conflict' ? 'conflict' : 'error', error_code: safeCode(failure.code) }).catch(() => {});
      }
    } finally { if (controllers.get(key) === controller) controllers.delete(key); }
  });

  const api = {
    async status(principal, botId) {
      let canPair = true;
      try { await member(principal, botId); }
      catch (failure) {
        if (failure.code !== 'bot_membership_required') throw failure;
        await member(principal, botId, true);
        canPair = false;
      }
      let connection;
      try { connection = await db.get('connections', { bot_id: botId }); migrationMissing = false; }
      catch (failure) { if (!telegramMissingSchema(failure)) throw failure; migrationMissing = true; return { enabled: false, configured: false, canPair, state: 'migration_required', requiredMigration: TELEGRAM_REQUIRED_MIGRATION, hostOnline: running, executionReady: Boolean(getDispatcher()) && await isOwner(), pairing: null, preferences: { routineDelivery: false, voiceReplies: true }, deliveries: [] }; }
      const pairings = connection && canPair ? await db.list('pairings', { bot_id: botId, user_id: principal.id, generation: connection.generation }, { state: 'in.(pending,claimed,confirmed)', order: 'created_at.desc', limit: 5 }) : [];
      const pairing = pairings.find((row) => row.state !== 'confirmed' && Date.parse(row.expires_at) > now()) || pairings.find((row) => row.state === 'confirmed');
      const confirmed = pairings.find((row) => row.state === 'confirmed');
      return { enabled: connection?.enabled === true, configured: Boolean(connection?.credential_id), canPair, state: connection?.state || 'disabled', errorCode: connection?.error_code || null, username: connection?.username || null, botIdentity: connection?.telegram_bot_id || null,
        hostOnline: running || Boolean(connection?.lease_until && Date.parse(connection.lease_until) > now()), executionReady: Boolean(getDispatcher()) && await isOwner(),
        pairing: pairing ? { id: pairing.id, state: pairing.state, telegramUserId: pairing.telegram_user_id, displayName: pairing.display_name, expiresAt: pairing.expires_at, confirmedAt: pairing.confirmed_at } : null,
        preferences: { routineDelivery: confirmed?.routine_delivery === true, voiceReplies: confirmed?.voice_replies !== false },
        deliveries: connection && canPair ? await api.deliveries(principal, botId) : [] };
    },
    async configure(principal, botId, request) {
      await member(principal, botId, true);
      assertExactObject(request, { label: 'Telegram configuration', required: ['enabled'], optional: ['token'] });
      if (typeof request.enabled !== 'boolean') throw error('telegram_configuration_invalid', 400);
      return serial(`config:${botId}`, async () => {
        const existing = await db.get('connections', { bot_id: botId });
        let credentialId = existing?.credential_id;
        let identity = existing ? { id: existing.telegram_bot_id, username: existing.username } : null;
        if (request.token !== undefined) {
          identity = await createTelegramClient({ token: request.token, fetchImpl }).validate();
          const other = await db.get('connections', { telegram_bot_id: identity.id });
          if (other && other.bot_id !== botId) throw error('telegram_identity_in_use');
          credentialId = crypto.randomUUID();
          await vault.create({ id: credentialId, botId, provider: 'telegram', kind: 'transport-token', credentialScope: 'team', ownerUserId: null, createdBy: principal.id, secret: { token: request.token }, metadata: {} });
        }
        if (!credentialId || !identity) throw error('telegram_token_required', 400);
        if (request.enabled && request.token === undefined) await (await clientFor(existing)).validate();
        const changedIdentity = existing && existing.telegram_bot_id !== identity.id;
        // Enabling/disabling and token rotation revoke outstanding generation-bound work.
        const generation = crypto.randomUUID();
        const body = { generation, enabled: request.enabled, telegram_bot_id: identity.id, username: identity.username, credential_id: credentialId,
          update_offset: changedIdentity ? 0 : Number(existing?.update_offset || 0), state: request.enabled ? 'connecting' : 'disabled', error_code: null, lease_owner: null, lease_until: null };
        try {
          await member(principal, botId, true); // Credential validation can outlive a role change.
          const saved = existing ? await db.patch('connections', { bot_id: botId, generation: existing.generation }, body) : await db.insert('connections', { bot_id: botId, ...body });
          if (!saved) throw error('telegram_configuration_conflict');
        } catch (failure) { if (credentialId !== existing?.credential_id) await vault.deleteCreated(credentialId); throw failure; }
        for (const [key, controller] of controllers) if (key.endsWith(`:${botId}`)) controller.abort();
        jobs.abortWhere((job) => job.botId === botId && job.generation !== generation);
        pollBackoff.delete(botId);
        if (existing?.credential_id && credentialId !== existing.credential_id) await vault.revoke(existing.credential_id);
        return api.status(principal, botId);
      });
    },
    async disconnect(principal, botId) {
      await member(principal, botId, true);
      return serial(`config:${botId}`, async () => {
        const connection = await db.get('connections', { bot_id: botId });
        await member(principal, botId, true);
        if (connection) {
          await db.patch('connections', { bot_id: botId }, { enabled: false, generation: crypto.randomUUID(), state: 'disabled', credential_id: null, error_code: null, lease_owner: null, lease_until: null });
          for (const [key, controller] of controllers) if (key.endsWith(`:${botId}`)) controller.abort();
          jobs.abortWhere((job) => job.botId === botId);
          if (connection.credential_id) await vault.revoke(connection.credential_id);
        }
        return api.status(principal, botId);
      });
    },
    async createPairing(principal, botId) {
      await member(principal, botId);
      const connection = await db.get('connections', { bot_id: botId, enabled: true });
      if (!connection) throw error('telegram_not_configured');
      const channel = await channels.getOrCreateOwnerChannel({ principal, botId });
      const nonce = crypto.randomBytes(32).toString('base64url');
      await db.patch('pairings', { bot_id: botId, user_id: principal.id, state: 'pending' }, { state: 'revoked', nonce_hash: null });
      await db.patch('pairings', { bot_id: botId, user_id: principal.id, state: 'claimed' }, { state: 'revoked', nonce_hash: null });
      const expiresAt = new Date(now() + 10 * 60_000).toISOString();
      const row = await db.insert('pairings', { id: crypto.randomUUID(), bot_id: botId, generation: connection.generation, user_id: principal.id, channel_id: channel.id,
        nonce_hash: sha256(nonce), state: 'pending', routine_delivery: false, voice_replies: true, expires_at: expiresAt });
      return { pairingId: row.id, expiresAt, url: `https://t.me/${connection.username}?start=${nonce}` };
    },
    async confirmPairing(principal, botId, request) {
      await member(principal, botId);
      assertExactObject(request, { label: 'Telegram pairing confirmation', required: ['pairingId'] });
      const connection = await db.get('connections', { bot_id: botId, enabled: true });
      if (!connection) throw error('telegram_not_configured');
      if (!await db.confirm(botId, connection.generation, validateUuid(request.pairingId, 'pairingId'), principal.id)) throw error('telegram_pairing_expired');
      jobs.abortWhere((job) => job.botId === botId && job.userId === principal.id && job.pairingId !== request.pairingId);
      return api.status(principal, botId);
    },
    async revokePairing(principal, botId) {
      await member(principal, botId);
      for (const state of ['pending', 'claimed', 'confirmed']) await db.patch('pairings', { bot_id: botId, user_id: principal.id, state }, { state: 'revoked', nonce_hash: null });
      jobs.abortWhere((job) => job.botId === botId && job.userId === principal.id);
      return api.status(principal, botId);
    },
    async setPreferences(principal, botId, request) {
      await member(principal, botId);
      assertExactObject(request, { label: 'Telegram preferences', required: ['routineDelivery', 'voiceReplies'] });
      if (typeof request.routineDelivery !== 'boolean' || typeof request.voiceReplies !== 'boolean') throw error('telegram_preferences_invalid', 400);
      const connection = await db.get('connections', { bot_id: botId });
      const pairing = connection && await activePairing(botId, principal.id, connection.generation);
      if (!pairing) throw error('telegram_pairing_required');
      await db.patch('pairings', { id: pairing.id, state: 'confirmed' }, { routine_delivery: request.routineDelivery, routine_subscribed_at: request.routineDelivery ? pairing.routine_delivery ? pairing.routine_subscribed_at : timestamp() : null, voice_replies: request.voiceReplies });
      return api.status(principal, botId);
    },
    async deliveries(principal, botId) {
      await member(principal, botId);
      const [rows, inbox] = await Promise.all([listWork('outbox', { bot_id: botId, user_id: principal.id }, { order: 'created_at.desc', limit: 20 }), listWork('inbox', { bot_id: botId, user_id: principal.id }, { state: 'in.(rejected,quota_rejected,admission_uncertain)', order: 'created_at.desc', limit: 10 })]);
      return [...rows.map(stateMetadata), ...inbox.map((row) => ({ ...stateMetadata(row), kind: 'incoming', partIndex: 0 }))];
    },
    async retryDelivery(principal, botId, request) {
      await member(principal, botId);
      assertExactObject(request, { label: 'Telegram delivery retry', required: ['deliveryId'] });
      const row = await db.get('outbox', { id: validateUuid(request.deliveryId, 'deliveryId'), bot_id: botId, user_id: principal.id });
      if (!row || !['failed', 'uncertain'].includes(row.state)) throw error('telegram_delivery_not_retryable');
      await binding(row);
      await db.patch('outbox', { id: row.id, state: row.state }, { state: 'pending', error_code: null, next_attempt_at: timestamp() });
      return { retryQueued: true, mayDuplicateLastPart: row.state === 'uncertain' };
    },
    async notifyRoutineCompleted({ run } = {}) {
      if (!run?.context_snapshot?.routine || !terminalRuns.has(run.state)) return;
      const connection = await db.get('connections', { bot_id: run.bot_id, enabled: true });
      if (!connection) return;
      const pairings = await db.list('pairings', { bot_id: run.bot_id, generation: connection.generation, channel_id: run.channel_id, state: 'confirmed', routine_delivery: true });
      for (const pairing of pairings) {
        const principal = await freshPrincipal(pairing.user_id, run.bot_id);
        // No historical routine replay when a member newly subscribes.
        if (Date.parse(run.created_at) >= Date.parse(pairing.routine_subscribed_at || pairing.confirmed_at)) await queueResult(connection, pairing, run, principal);
      }
    },
    async tick({ pollTimeout = 0, waitForJobs = true } = {}) {
      if (stopped) return;
      if (!await isOwner()) { abortOwnedWork(); return; }
      let available = await db.list('connections', { enabled: true }, { order: 'bot_id.asc', limit: 100, ...(connectionPageAfter ? { bot_id: `gt.${connectionPageAfter}` } : {}) });
      if (!available.length && connectionPageAfter) available = await db.list('connections', { enabled: true }, { order: 'bot_id.asc', limit: 100 });
      connectionPageAfter = available.length === 100 ? available.at(-1).bot_id : null;
      const offset = available.length ? scanCursor++ % available.length : 0;
      const connections = [...available.slice(offset), ...available.slice(0, offset)];
      let pollSlots = 16 - [...controllers.keys()].filter((key) => key.startsWith('poll:')).length;
      const polls = [];
      // Poll order advances only when a slot is actually scheduled. Rotating
      // work pages while all long-poll slots are occupied can starve whole pages.
      for (let page = 0; page < 2 && pollSlots > 0; page += 1) {
        const candidates = await db.list('connections', { enabled: true }, { order: 'bot_id.asc', limit: 32, ...(pollAfter ? { bot_id: `gt.${pollAfter}` } : {}) });
        for (const connection of candidates) {
          if (pollSlots <= 0) break;
          pollAfter = connection.bot_id;
          if (controllers.has(`poll:${connection.bot_id}`) || (pollBackoff.get(connection.bot_id)?.nextAt || 0) > now() || connection.state === 'conflict') continue;
          pollSlots -= 1;
          const poll = runConnection(connection, { timeout: pollTimeout });
          void poll.catch(() => undefined); polls.push(poll);
        }
        if (candidates.length < 32 && pollSlots > 0) pollAfter = null;
        else break;
      }
      if (waitForJobs) await Promise.allSettled(polls);
      for (const phase of ['inbox', 'outbox', 'synthesis']) {
        const work = [];
        for (const connection of connections) work.push(...await runConnection(connection, { poll: false, phase }) || []);
        // Waiting is only for deterministic manual ticks; never hold the coordinator lock.
        if (waitForJobs) await Promise.allSettled(work);
      }
    },
    start() {
      if (running) return;
      stopped = false;
      running = true;
      const loop = async () => {
        try {
          if (now() - lastPrune > 60_000) { await db.prune?.(); lastPrune = now(); }
          migrationMissing = false;
          await api.tick({ pollTimeout: 20, waitForJobs: false });
        } catch (failure) { migrationMissing = telegramMissingSchema(failure); logger?.warn?.('[BotTelegram] background unavailable', { code: safeCode(failure.code), migrationRequired: migrationMissing }); }
        finally { if (running) { timer = setTimeout(() => { background = loop(); }, migrationMissing ? 30_000 : 1000); timer.unref?.(); } }
      };
      background = loop();
    },
    async stop() {
      running = false;
      stopped = true;
      clearTimeout(timer);
      abortOwnedWork();
      await background?.catch(() => {});
      await Promise.allSettled([...locks.values()]);
      await jobs.wait();
      await db.patch('connections', { lease_owner: ownerId }, { lease_owner: null, lease_until: null }).catch(() => {});
      pollBackoff.clear();
    },
    async purgeBot({ botId }) {
      validateUuid(botId, 'botId');
      for (const [key, controller] of controllers) if (key.endsWith(`:${botId}`)) controller.abort();
      jobs.abortWhere((job) => job.botId === botId);
      return serial(`config:${botId}`, async () => {
        try {
          const connection = await db.get('connections', { bot_id: botId });
          if (connection) await db.patch('connections', { bot_id: botId }, { enabled: false, generation: crypto.randomUUID() });
          // A configuration ahead of purge may have completed while we waited
          // for its lock. Abort any work that started under that new generation.
          for (const [key, controller] of controllers) if (key.endsWith(`:${botId}`)) controller.abort();
          jobs.abortWhere((job) => job.botId === botId);
          await db.remove('connections', { bot_id: botId });
        } catch (failure) { if (!telegramMissingSchema(failure)) throw failure; }
        await vault.deleteForBot(botId);
        return { deleted: true };
      });
    },
  };
  return Object.freeze(api);
}
