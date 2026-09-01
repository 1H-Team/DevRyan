import { describe, expect, test } from 'vitest';
import { createTelegramClient, readBoundedTelegramBody, splitTelegramText, telegramNumericId } from './client.js';

const token = `123456:${'a'.repeat(35)}`;
const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
describe('native Telegram transport', () => {
  test('validates Bot identity, refuses webhooks and never takes them over', async () => {
    const methods = [];
    const client = createTelegramClient({ token, fetchImpl: async (url) => { methods.push(url.split('/').at(-1)); return methods.length === 1 ? ok({ id: 123456, is_bot: true, username: 'example_bot' }) : ok({ url: 'https://existing.example/webhook' }); } });
    await expect(client.validate()).rejects.toMatchObject({ code: 'telegram_webhook_active' });
    expect(methods).toEqual(['getMe', 'getWebhookInfo']);
  });
  test('transport write failure is uncertain and redacts arbitrary fetch error text', async () => {
    const client = createTelegramClient({ token, fetchImpl: async () => { throw new Error(`secret https://api.telegram.org/bot${token}`); } });
    try { await client.sendText({ chatId: '123', text: 'hello' }); throw new Error('expected failure'); }
    catch (failure) { expect(failure.code).toBe('telegram_transport_failed'); expect(failure.uncertain).toBe(true); expect(String(failure)).not.toContain(token); }
  });
  test('aborting an in-flight write returns uncertain even when fetch ignores its signal', async () => {
    const controller = new AbortController(); let entered = false;
    const client = createTelegramClient({ token, fetchImpl: () => { entered = true; return new Promise(() => {}); } });
    const result = client.sendText({ chatId: '123', text: 'hello', signal: controller.signal });
    expect(entered).toBe(true); controller.abort();
    await expect(result).rejects.toMatchObject({ uncertain: true, code: 'telegram_transport_failed' });
  });
  test('aborting a hung response body cancels its reader without waiting on more bytes', async () => {
    const controller = new AbortController(); let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const result = readBoundedTelegramBody(response, 100, controller.signal); controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled).toBe(true);
  });
  test('rate limits are explicit safe retry outcomes', async () => {
    const client = createTelegramClient({ token, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: token, parameters: { retry_after: 4 } }), { status: 429 }) });
    await expect(client.sendText({ chatId: '123', text: 'hello' })).rejects.toMatchObject({ code: 'telegram_rate_limited', uncertain: false, retryAfter: 4 });
  });
  test('malformed successful write responses remain uncertain', async () => {
    const client = createTelegramClient({ token, fetchImpl: async () => new Response('bad gateway', { status: 200 }) });
    await expect(client.sendText({ chatId: '123', text: 'hello' })).rejects.toMatchObject({ uncertain: true });
  });
  test('numeric IDs never accept usernames, groups or rounded identities', () => {
    expect(telegramNumericId(123456789123)).toBe('123456789123');
    for (const value of ['@someone', -123, '-123', 1.2, Number.MAX_SAFE_INTEGER + 1, '01']) expect(() => telegramNumericId(value)).toThrow();
  });
  test('chunks preserve exact Unicode text without markup transformations', () => {
    const text = `${'a'.repeat(3999)}🤖<think>literal</think>العربية${'x'.repeat(9000)}`;
    const chunks = splitTelegramText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4000 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
  test('downloads permit only getFile-derived fixed-origin paths without redirects', async () => {
    const urls = [];
    const client = createTelegramClient({ token, fetchImpl: async (url, options) => { urls.push(url); expect(options.redirect).toBe('error'); return urls.length === 1 ? ok({ file_path: 'documents/a.txt', file_size: 5 }) : new Response('hello'); } });
    expect((await client.download({ fileId: 'file_1' })).toString()).toBe('hello');
    expect(urls).toEqual([`https://api.telegram.org/bot${token}/getFile`, `https://api.telegram.org/file/bot${token}/documents/a.txt`]);
    const malicious = createTelegramClient({ token, fetchImpl: async () => ok({ file_path: '../secrets.txt' }) });
    await expect(malicious.download({ fileId: 'file_1' })).rejects.toMatchObject({ code: 'telegram_file_invalid' });
    const extensionless = createTelegramClient({ token, fetchImpl: async (url) => url.endsWith('/getFile') ? ok({ file_path: 'documents/file_1' }) : new Response('binary') });
    expect((await extensionless.download({ fileId: 'file_1' })).toString()).toBe('binary');
  });
  test('streaming bytes are bounded even without Content-Length', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close(); } }));
    await expect(readBoundedTelegramBody(response, 10)).rejects.toMatchObject({ code: 'telegram_payload_too_large' });
  });
  test('outgoing files are uploaded as bytes instead of token-bearing file URLs', async () => {
    const client = createTelegramClient({ token, fetchImpl: async (url, options) => {
      expect(url.endsWith('/sendDocument')).toBe(true); expect(options.body).toBeInstanceOf(FormData);
      const file = options.body.get('document'); expect(await file.text()).toBe('hello'); expect(file.name).toBe('.._unsafe_.txt'); return ok({ message_id: 1 });
    } });
    await client.sendFile({ chatId: '123', bytes: Buffer.from('hello'), contentType: 'text/plain', filename: '../unsafe$.txt' });
  });
});
