import { withBotAbort } from '../request-lifetime.js';

/** Telegram transport. Only the fixed public Bot API is reachable; errors never contain tokens or remote bodies. */
export class TelegramError extends Error {
  constructor(code, { statusCode = 502, uncertain = false, retryAfter = null } = {}) {
    super({ telegram_token_invalid: 'The Telegram token is invalid', telegram_webhook_active: 'This Telegram bot already uses a webhook; remove it in its current application first', telegram_consumer_conflict: 'Another application is polling this Telegram bot', telegram_rate_limited: 'Telegram has requested a delivery delay' }[code] || 'Telegram operation failed; inspect the connection or delivery status');
    Object.assign(this, { name: 'TelegramError', code, statusCode, uncertain, retryAfter });
  }
}

export const TELEGRAM_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export function validateTelegramToken(token) {
  if (typeof token !== 'string' || !/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,100}$/.test(token)) {
    throw new TelegramError('telegram_token_invalid', { statusCode: 400 });
  }
  return token;
}

export function telegramNumericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  throw new TelegramError('telegram_identity_invalid', { statusCode: 400 });
}

export async function readBoundedTelegramBody(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new TelegramError('telegram_payload_too_large', { statusCode: 413 });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TelegramError('telegram_response_invalid');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await withBotAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new TelegramError('telegram_payload_too_large', { statusCode: 413 });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* An aborted custom reader may still be completing its read. */ }
  }
}

export function splitTelegramText(text) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length) {
    let length = Math.min(4000, remaining.length);
    // Telegram limits UTF-16 code units; do not split a surrogate pair.
    if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1])) length -= 1;
    chunks.push(remaining.slice(0, length));
    remaining = remaining.slice(length);
  }
  return chunks;
}

export function createTelegramClient({ token, fetchImpl = fetch } = {}) {
  validateTelegramToken(token);
  const acknowledge = (value) => {
    if (!Number.isSafeInteger(value?.message_id) || value.message_id < 1) throw new TelegramError('telegram_response_invalid', { uncertain: true });
    return value;
  };
  const call = async (method, body = {}, { signal, timeoutMs = 30_000, write = false } = {}) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    try {
      if (controller.signal.aborted) throw new TelegramError('telegram_cancelled');
      const response = await withBotAbort(fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }), controller.signal);
      let payload;
      try { payload = JSON.parse((await readBoundedTelegramBody(response, 2 * 1024 * 1024, controller.signal)).toString('utf8')); }
      catch { throw new TelegramError('telegram_response_invalid', { uncertain: write }); }
      if (!response.ok || payload?.ok !== true) {
        const status = Number(payload?.error_code || response.status);
        const code = status === 401 ? 'telegram_token_invalid' : status === 409 ? 'telegram_consumer_conflict' : status === 429 ? 'telegram_rate_limited' : 'telegram_api_rejected';
        throw new TelegramError(code, { statusCode: status === 401 ? 400 : 502, uncertain: write && status >= 500, retryAfter: status === 429 ? Math.max(1, Math.min(3600, Number(payload?.parameters?.retry_after) || 30)) : null });
      }
      return payload.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError('telegram_transport_failed', { uncertain: write });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  return Object.freeze({
    async validate(options) {
      const identity = await call('getMe', {}, options);
      if (identity?.is_bot !== true || !/^[A-Za-z0-9_]{5,32}$/.test(identity.username || '')) throw new TelegramError('telegram_identity_invalid');
      const webhook = await call('getWebhookInfo', {}, options);
      if (webhook?.url) throw new TelegramError('telegram_webhook_active', { statusCode: 409 });
      return { id: telegramNumericId(identity.id), username: identity.username };
    },
    getUpdates: ({ offset, timeout = 20, signal }) => call('getUpdates', { offset, timeout, limit: 25, allowed_updates: ['message'] }, { signal, timeoutMs: (timeout + 10) * 1000 }),
    sendText: async ({ chatId, text, signal }) => acknowledge(await call('sendMessage', { chat_id: telegramNumericId(chatId), text, link_preview_options: { is_disabled: true } }, { signal, write: true })),
    async download({ fileId, signal }) {
      if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(fileId)) throw new TelegramError('telegram_file_invalid', { statusCode: 400 });
      const metadata = await call('getFile', { file_id: fileId }, { signal });
      if (Number(metadata?.file_size) > TELEGRAM_MEDIA_MAX_BYTES) throw new TelegramError('telegram_payload_too_large', { statusCode: 413 });
      const filePath = metadata?.file_path;
      if (typeof filePath !== 'string' || !/^[A-Za-z0-9_./-]{1,1024}$/.test(filePath) || filePath.split('/').some((part) => !part || part === '.' || part === '..' || part.length > 255)) throw new TelegramError('telegram_file_invalid');
      const timeout = AbortSignal.timeout(30_000);
      const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        downloadSignal.throwIfAborted();
        const response = await withBotAbort(fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`, { redirect: 'error', signal: downloadSignal }), downloadSignal);
        if (!response.ok) throw new TelegramError('telegram_file_download_failed');
        return await readBoundedTelegramBody(response, TELEGRAM_MEDIA_MAX_BYTES, downloadSignal);
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        throw new TelegramError('telegram_file_download_failed');
      }
    },
    async sendFile({ chatId, bytes, contentType, filename, voice = false, signal }) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > TELEGRAM_MEDIA_MAX_BYTES) throw new TelegramError('telegram_payload_too_large', { statusCode: 413 });
      const form = new FormData();
      form.set('chat_id', telegramNumericId(chatId));
      form.set(voice ? 'voice' : 'document', new Blob([bytes], { type: contentType || 'application/octet-stream' }), String(filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120));
      return acknowledge(await call(voice ? 'sendVoice' : 'sendDocument', form, { signal, timeoutMs: 60_000, write: true }));
    },
  });
}
