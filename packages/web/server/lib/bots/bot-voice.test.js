import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBotVoiceService } from './bot-voice.js';
import { inspectBotVoiceAudio } from './bot-voice-audio.js';
import { normalizeBotVoiceBaseUrl, resolveBotVoiceAddress } from './bot-voice-transport.js';

const BOT = 'b0000000-0000-4000-8000-000000000001';
const USER = { id: 'a0000000-0000-4000-8000-000000000001' };
const mp3 = () => { const bytes = Buffer.alloc(417); bytes.set([255, 251, 144, 0]); return bytes; };
const config = { enabled: true,
  stt: { baseUrl: 'https://speech.example.com/v1', model: 'whisper-1', apiKey: 'secret-stt' },
  tts: { baseUrl: 'https://speech.example.com/v1', model: 'tts-1', voice: 'coral', apiKey: 'secret-tts' },
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (check) => {
  const until = Date.now() + 3_000;
  while (!check()) { if (Date.now() > until) throw new Error('fixture timed out'); await new Promise((done) => setTimeout(done, 5)); }
};
let directory;
const services = [];
beforeEach(async () => {
  const root = path.resolve('.tmp');
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, 'bot-voice-'));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await fs.rm(directory, { force: true, recursive: true });
});
const harness = (fetchImpl = vi.fn(async (url) => url.endsWith('transcriptions')
  ? Response.json({ text: 'Please review the report.' })
  : new Response(mp3(), { headers: { 'content-type': 'audio/mpeg' } }))) => {
  const authorization = { requireActiveMembership: vi.fn(async () => ({})), requireManager: vi.fn(async () => ({})) };
  const resolvePrincipal = vi.fn(async () => USER);
  const service = createBotVoiceService({ dataDirectory: directory, encryption: { getKey: async () => Buffer.alloc(32, 9) }, authorization, resolvePrincipal, fetchImpl });
  services.push(service);
  return { service, authorization, resolvePrincipal, fetchImpl };
};
const transcribe = (service, overrides = {}) => service.transcribe({ botId: BOT, principal: USER, bytes: mp3(), contentType: 'audio/mpeg', operationId: 'update:123', ...overrides });
const speak = (service, overrides = {}) => service.synthesize({ botId: BOT, principal: USER, text: 'The verified answer.', operationId: 'run:123', ...overrides });

describe('Bot scoped speech configuration', () => {
  it('defaults disabled and stores all configuration encrypted with owner-only permissions', async () => {
    const { service, authorization } = harness();
    expect(await service.status(USER, BOT)).toMatchObject({ enabled: false, stt: null, tts: null });
    const result = await service.configure(USER, BOT, config);
    expect(result).toMatchObject({ enabled: true, stt: { hasApiKey: true, ready: true }, tts: { voice: 'coral' } });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(authorization.requireManager).toHaveBeenCalled();
    const file = path.join(directory, 'bots', 'speech-credentials', `${BOT}.v1.json`);
    expect(await fs.readFile(file, 'utf8')).not.toMatch(/secret-|speech.example|whisper/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await harness().service.status(USER, BOT)).toMatchObject({ enabled: true, stt: { model: 'whisper-1' } });
  });

  it('does not carry a credential to a changed authority or inherit host credentials', async () => {
    const { service, fetchImpl } = harness();
    await service.configure(USER, BOT, config);
    const changed = await service.configure(USER, BOT, { enabled: true, stt: { baseUrl: 'https://different.example.com/v1', model: 'whisper-1' } });
    expect(changed.stt).toMatchObject({ hasApiKey: false, ready: false });
    await expect(transcribe(service)).rejects.toMatchObject({ code: 'bot_voice_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a manager without membership read configuration metadata but never run speech jobs', async () => {
    const { service, authorization, fetchImpl } = harness();
    authorization.requireActiveMembership.mockRejectedValue(Object.assign(new Error('Membership required'), { code: 'bot_membership_required', statusCode: 403 }));
    await service.configure(USER, BOT, config);
    const status = await service.status(USER, BOT);
    expect(status).toMatchObject({ enabled: true, stt: { hasApiKey: true, model: 'whisper-1' } });
    expect(JSON.stringify(status)).not.toContain('secret-');
    await expect(transcribe(service)).rejects.toMatchObject({ code: 'bot_membership_required' });
    await expect(speak(service)).rejects.toMatchObject({ code: 'bot_membership_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
    authorization.requireManager.mockRejectedValue(Object.assign(new Error('Denied'), { statusCode: 403 }));
    await expect(service.status(USER, BOT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('revalidates identity and membership and never returns credentials to members', async () => {
    const { service, authorization, resolvePrincipal } = harness();
    await service.configure(USER, BOT, config);
    authorization.requireManager.mockRejectedValue(Object.assign(new Error('Denied'), { statusCode: 403 }));
    await expect(service.configure(USER, BOT, { enabled: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(JSON.stringify(await service.status(USER, BOT))).not.toContain('secret-');
    resolvePrincipal.mockResolvedValue(null);
    await expect(transcribe(service)).rejects.toMatchObject({ code: 'bot_voice_forbidden' });
  });

  it('checks model availability without generating audio or returning provider bodies', async () => {
    const { service, fetchImpl } = harness(vi.fn(async () => Response.json({ data: [{ id: 'whisper-1' }] })));
    await service.configure(USER, BOT, config);
    expect(await service.check(USER, BOT)).toEqual({ stt: { ready: true, code: null }, tts: { ready: false, code: 'bot_voice_model_unavailable' } });
    expect(fetchImpl.mock.calls.every(([url, options]) => url.endsWith('/models') && options.method === 'GET')).toBe(true);
  });

  it('purges credentials and cancels outstanding work', async () => {
    const pending = deferred();
    const { service, fetchImpl } = harness(vi.fn(() => pending.promise));
    await service.configure(USER, BOT, config);
    const job = speak(service);
    void job.catch(() => undefined);
    await waitFor(() => fetchImpl.mock.calls.length === 1);
    await service.purgeBot(BOT);
    await expect(job).rejects.toMatchObject({ code: 'bot_voice_cancelled' });
    expect(await service.status(USER, BOT)).toMatchObject({ enabled: false });
  });
});

describe('Bot speech execution', () => {
  it('transcribes once with explicit scoped credentials and no model-turn side effects', async () => {
    const { service, fetchImpl } = harness();
    await service.configure(USER, BOT, config);
    expect(await transcribe(service)).toEqual({ text: 'Please review the report.' });
    expect(await transcribe(service)).toEqual({ text: 'Please review the report.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer secret-stt' } });
    await expect(transcribe(service, { bytes: Buffer.concat([mp3(), mp3()]) })).rejects.toMatchObject({ code: 'bot_voice_operation_conflict' });
  });

  it('speaks the exact verified text without summarizing and isolates returned audio buffers', async () => {
    let submitted;
    const { service } = harness(vi.fn(async (_url, options) => { submitted = JSON.parse(options.body.toString('utf8')); return new Response(mp3()); }));
    await service.configure(USER, BOT, config);
    const first = await speak(service, { text: '**The answer** contains the full result.' });
    expect(submitted).toMatchObject({ input: '**The answer** contains the full result.', model: 'tts-1', voice: 'coral' });
    first.bytes.fill(0);
    expect((await speak(service, { text: '**The answer** contains the full result.' })).bytes).toEqual(mp3());
    await expect(speak(service, { text: 'x'.repeat(4_001) })).rejects.toMatchObject({ code: 'bot_voice_text_limit' });
  });

  it.each([
    [401, 'bot_voice_authentication_failed'], [429, 'bot_voice_usage_limit'], [500, 'bot_voice_provider_failed'], [302, 'bot_voice_provider_failed'],
  ])('returns safe failures for provider status %s', async (status, code) => {
    const { service } = harness(vi.fn(async () => new Response('private transcript secret-tts', { status })));
    await service.configure(USER, BOT, config);
    const error = await speak(service).catch((value) => value);
    expect(error).toMatchObject({ code });
    expect(error.message).not.toMatch(/private transcript|secret-tts/);
  });

  it('rejects silent/empty transcripts and oversized provider output without a prompt', async () => {
    const { service, fetchImpl } = harness(vi.fn(async () => Response.json({ text: '   ' })));
    await service.configure(USER, BOT, config);
    await expect(transcribe(service)).rejects.toMatchObject({ code: 'bot_voice_transcript_empty' });
    fetchImpl.mockImplementation(async () => new Response('x', { headers: { 'content-length': String(21 * 1024 * 1024) } }));
    await expect(speak(service)).rejects.toMatchObject({ code: 'bot_voice_response_too_large' });
  });

  it('serializes each surface but lets transcription and synthesis progress independently', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let callIndex = 0;
    const { service, fetchImpl } = harness(vi.fn(() => gates[callIndex++].promise));
    await service.configure(USER, BOT, config);
    const first = speak(service);
    await waitFor(() => fetchImpl.mock.calls.length === 1);
    const second = speak(service, { operationId: 'second' });
    const transcription = transcribe(service);
    await waitFor(() => fetchImpl.mock.calls.length === 2);
    expect(fetchImpl.mock.calls[1][0]).toContain('transcriptions');
    gates[1].resolve(Response.json({ text: 'Hello' }));
    expect(await transcription).toEqual({ text: 'Hello' });
    gates[0].resolve(new Response(mp3()));
    await first;
    await waitFor(() => fetchImpl.mock.calls.length === 3);
    gates[2].resolve(new Response(mp3()));
    await second;
  });

  it('cancels a hung provider and rejects a result after membership revocation', async () => {
    const gate = deferred();
    const { service, fetchImpl, authorization } = harness(vi.fn(() => gate.promise));
    await service.configure(USER, BOT, config);
    const controller = new AbortController();
    const job = speak(service, { signal: controller.signal });
    await waitFor(() => fetchImpl.mock.calls.length === 1);
    controller.abort();
    await expect(job).rejects.toMatchObject({ code: 'bot_voice_cancelled' });
    fetchImpl.mockImplementation(async () => {
      authorization.requireActiveMembership.mockRejectedValue(Object.assign(new Error('revoked'), { statusCode: 403 }));
      return new Response(mp3());
    });
    await expect(speak(service, { operationId: 'after' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Bot speech media and endpoint limits', () => {
  it('pins the exact validated DNS address and rejects mixed public/private or rebound DNS', async () => {
    const lookup = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]);
    expect(await resolveBotVoiceAddress('speech.example.com', lookup)).toEqual({ address: '1.1.1.1', family: 4 });
    lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(resolveBotVoiceAddress('speech.example.com', lookup)).rejects.toMatchObject({ code: 'bot_voice_endpoint_invalid' });
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(resolveBotVoiceAddress('speech.example.com', lookup)).rejects.toMatchObject({ code: 'bot_voice_endpoint_invalid' });
  });

  it('validates Ogg/Opus framing and checks duration against actual packet timing', () => {
    const page = (packet, sequence, flags, granule) => {
      const header = Buffer.alloc(28);
      header.write('OggS');
      header[5] = flags;
      header.writeBigUInt64LE(BigInt(granule), 6);
      header.writeUInt32LE(12, 14);
      header.writeUInt32LE(sequence, 18);
      header[26] = 1;
      header[27] = packet.length;
      return Buffer.concat([header, packet]);
    };
    const head = Buffer.alloc(19);
    head.write('OpusHead');
    const audio = Buffer.concat([page(head, 0, 2, 0), page(Buffer.from('OpusTags'), 1, 0, 0), page(Buffer.from([248, 255, 254]), 2, 4, 960)]);
    expect(inspectBotVoiceAudio(audio, 'audio/ogg').duration).toBe(0.02);
    expect(() => inspectBotVoiceAudio(audio.subarray(0, -1), 'audio/ogg')).toThrow();
    const forged = Buffer.from(audio);
    forged.writeBigUInt64LE(48_000n * 301n, audio.length - 31 + 6);
    expect(() => inspectBotVoiceAudio(forged, 'audio/ogg')).toThrow();
  });
  it.each(['http://example.com/v1', 'https://169.254.169.254/v1', 'https://192.168.1.4/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://host.internal/v1', 'https://a:b@example.com/v1', 'https://example.com/v1?key=secret'])('rejects unsafe endpoint %s', (url) => {
    expect(() => normalizeBotVoiceBaseUrl(url)).toThrow();
  });
  it('accepts explicit loopback or public HTTPS only', () => {
    expect(normalizeBotVoiceBaseUrl('http://localhost:8100/v1/')).toBe('http://127.0.0.1:8100/v1');
    expect(normalizeBotVoiceBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
  });
  it('bounds format, actual MP3 frame duration, and truncated frames', () => {
    expect(inspectBotVoiceAudio(mp3(), 'audio/mpeg').duration).toBeCloseTo(1152 / 44_100);
    expect(() => inspectBotVoiceAudio(mp3().subarray(0, 400), 'audio/mpeg')).toThrow();
    expect(() => inspectBotVoiceAudio(mp3(), 'audio/wav')).toThrow();
    const long = Buffer.concat(Array.from({ length: 11_500 }, mp3));
    expect(() => inspectBotVoiceAudio(long, 'audio/mpeg')).toThrow('duration limit');
  });
});
