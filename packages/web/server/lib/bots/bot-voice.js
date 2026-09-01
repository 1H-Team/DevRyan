import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { encryptBotJson, decryptBotJson } from './encryption.js';
import { validateUuid, assertExactObject } from './validation.js';
import { withBotAbort, botRequestSignal } from './request-lifetime.js';
import { createBotVoiceFetch, normalizeBotVoiceBaseUrl } from './bot-voice-transport.js';
import { inspectBotVoiceAudio } from './bot-voice-audio.js';

const LIMITS = Object.freeze({ maximumInputSeconds: 300, maximumInputBytes: 20 * 1024 * 1024, maximumReplyCharacters: 4_000 });
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const KEY_ID = 'deployment-v1';
const aad = (botId) => `devryan-bot-speech:${botId}:v1`;
const fail = (message, code = 'bot_voice_invalid', statusCode = 400) => {
  throw Object.assign(new Error(message), { code, statusCode });
};
const label = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$/.test(value)) {
    fail('Speech model or voice is invalid');
  }
  return value;
};
const localEndpoint = (value) => ['127.0.0.1', '[::1]'].includes(new URL(value).hostname);
const normalizeSurface = (input, previous, kind) => {
  if (input === undefined) return previous || null;
  if (input === null) return null;
  assertExactObject(input, { label: 'Speech provider', required: ['baseUrl', 'model'], optional: kind === 'tts' ? ['voice', 'apiKey'] : ['apiKey'] });
  const baseUrl = normalizeBotVoiceBaseUrl(input.baseUrl);
  let apiKey = input.apiKey;
  if (apiKey === undefined) apiKey = previous?.baseUrl === baseUrl ? previous.apiKey : '';
  if (typeof apiKey !== 'string' || apiKey.length > 8_192 || /[\r\n\0]/.test(apiKey)) fail('Speech API credential is invalid');
  return { baseUrl, model: label(input.model), ...(kind === 'tts' ? { voice: label(input.voice || 'coral') } : {}), apiKey };
};
const publicSurface = (surface) => surface ? Object.freeze({
  baseUrl: surface.baseUrl, model: surface.model,
  ...(surface.voice ? { voice: surface.voice } : {}),
  hasApiKey: Boolean(surface.apiKey),
  ready: Boolean(surface.apiKey || localEndpoint(surface.baseUrl)),
}) : null;
const project = (botId, config) => Object.freeze({
  botId, enabled: config.enabled, generation: config.generation,
  stt: publicSurface(config.stt), tts: publicSurface(config.tts), limits: LIMITS,
});

const boundedBody = async (response, maximum, signal) => {
  if (Number(response.headers?.get?.('content-length')) > maximum) {
    await response.body?.cancel?.().catch(() => undefined);
    fail('Speech provider response is too large', 'bot_voice_response_too_large', 502);
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail('Speech provider returned no response', 'bot_voice_response_invalid', 502);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withBotAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) fail('Speech provider response is too large', 'bot_voice_response_too_large', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
};

export function createBotVoiceService({ dataDirectory, encryption, authorization, resolvePrincipal = null, fetchImpl = createBotVoiceFetch() } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || typeof encryption?.getKey !== 'function' || typeof authorization?.requireManager !== 'function'
    || typeof authorization?.requireActiveMembership !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('Bot speech service is misconfigured');
  }
  const root = path.join(dataDirectory, 'bots', 'speech-credentials');
  const mutations = new Map();
  const lanes = new Map();
  const operations = new Map();
  let retainedBytes = 0;
  const lifetime = new AbortController();
  const botControllers = new Map();
  const botController = (botId) => {
    if (!botControllers.has(botId)) botControllers.set(botId, new AbortController());
    return botControllers.get(botId);
  };
  const member = async (principal, botId, manager = false) => {
    lifetime.signal.throwIfAborted();
    const id = validateUuid(principal?.id, 'principal.id');
    const current = resolvePrincipal ? await resolvePrincipal(id) : principal;
    if (!current || current.id !== id) fail('Speech access is no longer available', 'bot_voice_forbidden', 403);
    await (manager ? authorization.requireManager : authorization.requireActiveMembership)(current, botId);
    return current;
  };
  const withKey = async (operation) => {
    const supplied = await encryption.getKey();
    const key = Buffer.from(supplied || []);
    try { return await operation(key); } finally {
      key.fill(0);
      supplied?.fill?.(0);
    }
  };
  const filename = (botId) => path.join(root, `${botId}.v1.json`);
  const load = async (botId) => {
    let handle;
    try {
      handle = await fs.open(filename(botId), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      if ((await handle.stat()).size > 64 * 1024) fail('Speech configuration is invalid', 'bot_voice_storage_invalid', 503);
      const envelope = JSON.parse(await handle.readFile('utf8'));
      const config = await withKey((key) => decryptBotJson({ key, envelope, expectedKeyId: KEY_ID, associatedData: aad(botId) }));
      if (config.version !== 1 || typeof config.enabled !== 'boolean' || typeof config.generation !== 'string') {
        fail('Speech configuration is invalid', 'bot_voice_storage_invalid', 503);
      }
      return config;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, enabled: false, generation: 'unconfigured', stt: null, tts: null };
      fail('Speech configuration could not be read', 'bot_voice_storage_invalid', 503);
    } finally { await handle?.close(); }
  };
  const persist = async (botId, config) => {
    const envelope = await withKey((key) => encryptBotJson({ key, keyId: KEY_ID, value: config, associatedData: aad(botId) }));
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const temporary = path.join(root, `.${botId}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, filename(botId));
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  };
  const mutate = (botId, operation) => {
    const next = (mutations.get(botId) || Promise.resolve()).then(operation, operation);
    mutations.set(botId, next);
    void next.finally(() => { if (mutations.get(botId) === next) mutations.delete(botId); }).catch(() => undefined);
    return next;
  };
  const clearBotOperations = (botId) => {
    botControllers.get(botId)?.abort();
    botControllers.delete(botId);
    for (const [key, entry] of operations) {
      if (entry.botId !== botId || !entry.done) continue;
      retainedBytes -= entry.bytes;
      entry.result?.bytes?.fill(0);
      operations.delete(key);
    }
  };
  const cloneResult = (value) => value.bytes
    ? { contentType: value.contentType, bytes: Buffer.from(value.bytes) }
    : { text: value.text };
  const request = async (surface, endpoint, options, signal) => {
    const response = await withBotAbort(fetchImpl(`${surface.baseUrl}/${endpoint}`, {
      method: options.method || 'POST', redirect: 'error', signal,
      headers: { ...options.headers, ...(surface.apiKey ? { authorization: `Bearer ${surface.apiKey}` } : {}) },
      body: options.body,
    }), signal);
    if (!response.ok || response.redirected) {
      await response.body?.cancel?.().catch(() => undefined);
      const code = response.status === 401 || response.status === 403 ? 'bot_voice_authentication_failed'
        : response.status === 429 ? 'bot_voice_usage_limit' : 'bot_voice_provider_failed';
      fail('Speech provider request failed', code, 502);
    }
    return response;
  };
  const run = async ({ botId: rawBotId, principal, operationId, signal, kind, inputBytes, digest, execute }) => {
    const botId = validateUuid(rawBotId, 'botId');
    const current = await member(principal, botId);
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9:_.-]{1,180}$/.test(operationId)) fail('Speech operation identity is invalid');
    const config = await load(botId);
    const surface = config[kind];
    if (!config.enabled || !publicSurface(surface)?.ready) fail('Speech is not configured for this Bot', 'bot_voice_not_configured', 409);
    const key = `${botId}:${current.id}:${config.generation}:${kind}:${operationId}`;
    const existing = operations.get(key);
    if (existing) {
      if (existing.digest !== digest) fail('Speech operation input changed', 'bot_voice_operation_conflict', 409);
      const result = await withBotAbort(existing.promise, signal);
      await member(principal, botId);
      if ((await load(botId)).generation !== config.generation) fail('Speech configuration changed', 'bot_voice_configuration_changed', 409);
      return cloneResult(result);
    }
    // Bound both queued request buffers and completed idempotency results.
    for (const [cachedKey, entry] of operations) {
      if (entry.done && (Date.now() - entry.finishedAt > 15 * 60_000 || operations.size >= 64
        || retainedBytes + inputBytes > MAX_RETAINED_BYTES)) {
        retainedBytes -= entry.bytes;
        entry.result?.bytes?.fill(0);
        operations.delete(cachedKey);
      }
    }
    const laneKey = `${botId}:${kind}`;
    const lane = lanes.get(laneKey) || { tail: Promise.resolve(), count: 0 };
    if (lane.count >= 3 || operations.size >= 64 || retainedBytes + inputBytes > MAX_RETAINED_BYTES) {
      fail('Speech queue is full; try again later', 'bot_voice_busy', 429);
    }
    lane.count += 1;
    lanes.set(laneKey, lane);
    retainedBytes += inputBytes;
    const entry = { botId, digest, bytes: inputBytes, done: false, result: null, promise: null };
    const requestSignal = botRequestSignal(signal, AbortSignal.any([lifetime.signal, botController(botId).signal]), 120_000);
    const task = withBotAbort(lane.tail.catch(() => undefined), requestSignal).then(async () => {
      requestSignal.throwIfAborted();
      await member(principal, botId);
      if ((await load(botId)).generation !== config.generation) fail('Speech configuration changed', 'bot_voice_configuration_changed', 409);
      const result = await execute(surface, requestSignal, request);
      try {
        await member(principal, botId);
        requestSignal.throwIfAborted();
        if ((await load(botId)).generation !== config.generation) fail('Speech configuration changed', 'bot_voice_configuration_changed', 409);
      } catch (error) { result.bytes?.fill(0); throw error; }
      entry.result = result;
      retainedBytes -= entry.bytes;
      entry.bytes = result.bytes?.length || Buffer.byteLength(result.text, 'utf8');
      retainedBytes += entry.bytes;
      entry.done = true;
      entry.finishedAt = Date.now();
      return result;
    }).catch((error) => {
      retainedBytes -= entry.bytes;
      operations.delete(key);
      if ((typeof error?.code === 'string' && error.code.startsWith('bot_voice_')) || error?.statusCode === 403) throw error;
      if (requestSignal.aborted) fail('Speech request was cancelled or timed out', 'bot_voice_cancelled', 409);
      fail('Speech provider is unavailable', 'bot_voice_provider_failed', 502);
    }).finally(() => {
      lane.count -= 1;
      if (!lane.count) lanes.delete(laneKey);
    });
    entry.promise = task;
    operations.set(key, entry);
    // A cancelled queued caller cannot remove the still-running predecessor's
    // serialization fence and let a subsequent request overlap it.
    lane.tail = Promise.allSettled([lane.tail, task]).then(() => undefined);
    return cloneResult(await task);
  };

  return Object.freeze({
    async status(principal, rawBotId) {
      const botId = validateUuid(rawBotId, 'botId');
      try { await member(principal, botId); }
      catch (error) {
        if (error.code !== 'bot_membership_required') throw error;
        await member(principal, botId, true);
      }
      return project(botId, await load(botId));
    },
    async configure(principal, rawBotId, input) {
      const botId = validateUuid(rawBotId, 'botId');
      await member(principal, botId, true);
      assertExactObject(input, { label: 'Speech configuration', required: ['enabled'], optional: ['stt', 'tts'] });
      if (typeof input.enabled !== 'boolean') fail('Speech enabled must be a boolean');
      return mutate(botId, async () => {
        await member(principal, botId, true);
        const previous = await load(botId);
        const next = { version: 1, enabled: input.enabled, generation: randomUUID(),
          stt: normalizeSurface(input.stt, previous.stt, 'stt'),
          tts: normalizeSurface(input.tts, previous.tts, 'tts') };
        if (next.enabled && !publicSurface(next.stt)?.ready && !publicSurface(next.tts)?.ready) {
          fail('Configure at least one speech provider before enabling speech', 'bot_voice_not_configured', 409);
        }
        await persist(botId, next);
        clearBotOperations(botId);
        return project(botId, next);
      });
    },
    async check(principal, rawBotId) {
      const botId = validateUuid(rawBotId, 'botId');
      await member(principal, botId, true);
      const config = await load(botId);
      const checks = await Promise.all(['stt', 'tts'].map(async (kind) => {
        const surface = config[kind];
        if (!publicSurface(surface)?.ready) return [kind, { ready: false, code: 'bot_voice_not_configured' }];
        const signal = botRequestSignal(lifetime.signal, botController(botId).signal, 10_000);
        let bytes;
        try {
          const response = await request(surface, 'models', { method: 'GET' }, signal);
          bytes = await boundedBody(response, 256 * 1024, signal);
          const models = JSON.parse(bytes.toString('utf8'));
          if (!Array.isArray(models.data) || !models.data.some((model) => model.id === surface.model)) {
            return [kind, { ready: false, code: 'bot_voice_model_unavailable' }];
          }
          return [kind, { ready: true, code: null }];
        } catch (error) {
          return [kind, { ready: false, code: (typeof error?.code === 'string' && error.code.startsWith('bot_voice_')) ? error.code : 'bot_voice_provider_failed' }];
        } finally { bytes?.fill(0); }
      }));
      await member(principal, botId, true);
      return Object.freeze(Object.fromEntries(checks));
    },
    async transcribe({ botId, principal, bytes, contentType, operationId, signal }) {
      const audio = inspectBotVoiceAudio(bytes, contentType, LIMITS.maximumInputSeconds);
      const digest = createHash('sha256').update(bytes).update(audio.contentType).digest('hex');
      return run({ botId, principal, operationId, signal, kind: 'stt', inputBytes: bytes.length + 128 * 1024, digest,
        execute: async (surface, requestSignal, send) => {
          const form = new FormData();
          form.set('model', surface.model);
          form.set('response_format', 'json');
          form.set('file', new Blob([bytes], { type: audio.contentType }), `voice.${audio.extension}`);
          const encoded = new Request('http://127.0.0.1', { method: 'POST', body: form });
          const body = Buffer.from(await encoded.arrayBuffer());
          let responseBytes;
          try {
            const response = await send(surface, 'audio/transcriptions', { headers: { 'content-type': encoded.headers.get('content-type') }, body }, requestSignal);
            responseBytes = await boundedBody(response, 128 * 1024, requestSignal);
            let result;
            try { result = JSON.parse(responseBytes.toString('utf8')); } catch { fail('Speech provider returned invalid transcription', 'bot_voice_response_invalid', 502); }
            if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 64_000) {
              fail('No speech could be transcribed', 'bot_voice_transcript_empty', 422);
            }
            return { text: result.text.trim() };
          } finally { body.fill(0); responseBytes?.fill(0); }
        },
      });
    },
    async synthesize({ botId, principal, text, operationId, signal }) {
      if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.maximumReplyCharacters) {
        fail('Spoken replies are limited to 4,000 characters; the full text remains available', 'bot_voice_text_limit', 413);
      }
      return run({ botId, principal, operationId, signal, kind: 'tts', inputBytes: LIMITS.maximumInputBytes,
        digest: createHash('sha256').update(text).digest('hex'),
        execute: async (surface, requestSignal, send) => {
          const body = Buffer.from(JSON.stringify({ model: surface.model, voice: surface.voice, input: text, response_format: 'mp3' }));
          try {
            const response = await send(surface, 'audio/speech', { headers: { 'content-type': 'application/json' }, body }, requestSignal);
            const bytes = await boundedBody(response, LIMITS.maximumInputBytes, requestSignal);
            try { inspectBotVoiceAudio(bytes, 'audio/mpeg', 20 * 60); } catch (error) { bytes.fill(0); throw error; }
            return { bytes, contentType: 'audio/mpeg' };
          } finally { body.fill(0); }
        },
      });
    },
    async purgeBot(rawBotId) {
      const botId = validateUuid(rawBotId, 'botId');
      return mutate(botId, async () => {
        clearBotOperations(botId);
        await fs.unlink(filename(botId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      });
    },
    async shutdown() {
      lifetime.abort();
      await Promise.allSettled([...operations.values()].map((entry) => entry.promise));
      for (const entry of operations.values()) entry.result?.bytes?.fill(0);
      operations.clear();
      retainedBytes = 0;
      botControllers.clear();
    },
  });
}
