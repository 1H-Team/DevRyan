import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMeridianHttpHotfix, MERIDIAN_HTTP_SERVER_ORIGINAL } from './meridian-http-hotfix.js';
import { serveMeridianHttp } from './meridian-http-server.js';
import { MERIDIAN_HANDOFF_EDITS, MERIDIAN_HANDOFF_HELPER, stripMeridianHandoffPatch } from './meridian-passthrough-hotfix.js';

const roots = [];
const source = `async function start() {\n${MERIDIAN_HTTP_SERVER_ORIGINAL}\n    port: finalConfig.port\n  }, () => {\n  });\n  const idleMs = finalConfig.idleTimeoutSeconds * 1000;\n}\n${MERIDIAN_HANDOFF_EDITS.map(([before]) => before).join('\n')}`;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const fixture = (version = '1.62.6') => {
  const cache = path.resolve(import.meta.dirname, '../../../../../.cache/qa');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'meridian-http-hotfix-'));
  roots.push(root);
  const dist = path.join(root, 'node_modules/@rynfar/meridian/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, '../package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dist, 'cli-wxk8xvd3.js'), source);
  return { root, dist, options: { configDirectory: root, expectedOriginalSha256: sha256(source) } };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Meridian native HTTP cancellation compatibility', () => {
  it('pins source identity, installs atomically and remains idempotent', () => {
    const { options, dist } = fixture();
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: true, version: '1.62.6' });
    const patched = fs.readFileSync(path.join(dist, 'cli-wxk8xvd3.js'), 'utf8');
    expect(patched).toContain('serveMeridianHttp({');
    expect(patched).toContain('}, serve);');
    expect(patched).toContain('settlePassthroughQuery(sdkQuery');
    expect(fs.existsSync(path.join(dist, MERIDIAN_HANDOFF_HELPER))).toBe(true);
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: false });
    fs.appendFileSync(path.join(dist, 'cli-wxk8xvd3.js'), '\n// unreviewed change');
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: false, code: 'MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE' });
    expect(fs.readFileSync(path.join(dist, 'cli-wxk8xvd3.js'), 'utf8')).toContain('unreviewed change');
  });

  it('upgrades an existing HTTP-only patch and rejects a partially installed handoff', () => {
    const { options, dist } = fixture();
    const entry = path.join(dist, 'cli-wxk8xvd3.js');
    expect(applyMeridianHttpHotfix(options).ok).toBe(true);
    const complete = fs.readFileSync(entry, 'utf8');
    fs.writeFileSync(entry, stripMeridianHandoffPatch(complete));
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: true });
    expect(fs.readFileSync(entry, 'utf8')).toBe(complete);
    fs.writeFileSync(entry, complete.replace(MERIDIAN_HANDOFF_EDITS[0][1], MERIDIAN_HANDOFF_EDITS[0][0]));
    expect(applyMeridianHttpHotfix(options).ok).toBe(false);
  });

  it('rejects unsupported package versions without creating a helper', () => {
    const { options, dist } = fixture('1.62.7');
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(dist, 'devryan-meridian-http-server.js'))).toBe(false);
  });

  it('keeps the existing Node adapter and options authoritative outside Bun', () => {
    const expected = {};
    const fallback = vi.fn(() => expected);
    const options = { fetch: vi.fn(), port: 0 };
    const listening = vi.fn();
    expect(serveMeridianHttp(options, listening, fallback, null)).toBe(expected);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(options, listening);
  });

  it('propagates real client abort to the unchanged request signal and stream under Bun', () => {
    const moduleUrl = new URL('./meridian-http-server.js', import.meta.url).href;
    const probe = `import { serveMeridianHttp } from ${JSON.stringify(moduleUrl)};
      const events = [];
      const server = serveMeridianHttp({ hostname: '127.0.0.1', port: 0, idleTimeoutSeconds: 120,
        fetch: async request => {
          await request.json();
          request.signal.addEventListener('abort', () => events.push('abort'), { once: true });
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\\n\\n'));
            return new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
          }, cancel() { events.push('cancel'); } }), { headers: { 'Content-Type': 'text/event-stream' } });
        } }, undefined, () => { throw new Error('Unexpected Node fallback'); });
      try {
        const controller = new AbortController();
        const response = await fetch('http://127.0.0.1:' + server.address().port, { method: 'POST', body: '{}', signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read(); controller.abort();
        try { await reader.read(); } catch {}
        const deadline = Date.now() + 2000;
        while (events.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        console.log(JSON.stringify(events));
      } finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }`;
    const result = execFileSync('bun', ['--eval', probe], { encoding: 'utf8', timeout: 8_000 });
    expect(JSON.parse(result)).toEqual(['abort', 'cancel']);
  });

  it('retains a graceful close promise and permits forced connection cleanup', async () => {
    let finish;
    const stopped = new Promise(resolve => { finish = resolve; });
    const native = { hostname: '127.0.0.1', port: 1234, stop: vi.fn(force => { if (force) finish(); return stopped; }), ref: vi.fn(), unref: vi.fn() };
    const fetch = vi.fn();
    const bun = { serve: vi.fn(() => native) };
    const server = serveMeridianHttp({ hostname: '127.0.0.1', port: 0, idleTimeoutSeconds: 120, fetch }, undefined, vi.fn(), bun);
    expect(bun.serve).toHaveBeenCalledExactlyOnceWith({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, fetch });
    expect(server.address().port).toBe(1234);
    const callback = vi.fn();
    server.close(callback);
    expect(server.listening).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    server.closeAllConnections();
    await stopped;
    await Promise.resolve();
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(native.stop.mock.calls).toEqual([[], [true]]);
  });
});
