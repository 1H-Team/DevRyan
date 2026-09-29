import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMeridianHttpHotfix, MERIDIAN_HTTP_SERVER_ORIGINAL, MERIDIAN_REVIEWED_PATCHES } from './meridian-http-hotfix.js';
import { serveMeridianHttp } from './meridian-http-server.js';
import { MERIDIAN_HANDOFF_EDITS, MERIDIAN_HANDOFF_HELPER, MERIDIAN_PREFIX_EDITS, stripMeridianHandoffPatch } from './meridian-passthrough-hotfix.js';

const roots = [];
const cwdAnchor = '        const cwdResolution = resolveSdkWorkingDirectory({';
const anchors = `      pathToClaudeCodeExecutable: claudeExecutable,\nasync function start() {\n${MERIDIAN_HTTP_SERVER_ORIGINAL}\n    port: finalConfig.port\n  }, () => {\n  });\n  const idleMs = finalConfig.idleTimeoutSeconds * 1000;\n}\n${MERIDIAN_HANDOFF_EDITS.map(([before]) => before).join('\n')}`;
const source = `${cwdAnchor}\n${anchors}`;
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

  it('upgrades a complete previous handoff revision and rejects an incomplete prefix fix', () => {
    const { options, dist } = fixture();
    const entry = path.join(dist, 'cli-wxk8xvd3.js');
    expect(applyMeridianHttpHotfix(options).ok).toBe(true);
    const complete = fs.readFileSync(entry, 'utf8');
    const previous = MERIDIAN_PREFIX_EDITS.reduce((text, [before, after]) => text.replace(after, before), complete);
    fs.writeFileSync(entry, previous);
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: true,
      prefix: 'native-fork-at-client-tool-checkpoint; git-snapshot-disabled-for-passthrough' });
    expect(fs.readFileSync(entry, 'utf8')).toBe(complete);
    for (const [before, after] of MERIDIAN_PREFIX_EDITS) {
      const partial = complete.replace(after, before);
      fs.writeFileSync(entry, partial);
      expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: false });
      expect(fs.readFileSync(entry, 'utf8')).toBe(partial);
    }
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

// Executable stand-in for Meridian's request path: the reviewed cwd anchor in a
// real handler, with Meridian's own resolution (src/proxy/cwd.ts) and the
// opencode adapter's <env> extraction. Every other anchor stays in a comment.
const executableSource = () => `import { existsSync } from 'node:fs';
/*\n${anchors}\n*/
function resolveSdkWorkingDirectory(opts) {
  const claimed = opts.envOverride || opts.adapterCwd || opts.fallback;
  return existsSync(claimed)
    ? { workingDirectory: claimed, claimedWorkingDirectory: claimed, fellBack: false }
    : { workingDirectory: opts.fallback, claimedWorkingDirectory: claimed, fellBack: true };
}
const adapter = { extractWorkingDirectory: (body) => String(body.system ?? '').match(/<env>\\s*[\\s\\S]*?Working directory:\\s*([^\\n<]+)/i)?.[1]?.trim() };
export async function handleMessages(c, body) {
        const cwdResolution = resolveSdkWorkingDirectory({
          envOverride: process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR,
          adapterCwd: adapter.extractWorkingDirectory(body),
          fallback: process.cwd()
        });
  return { cwd: cwdResolution.workingDirectory };
}
`;

describe('Meridian requesting-session working directory', () => {
  const previousBoundary = process.env.DEVRYAN_EXECUTION_BOUNDARY;
  afterEach(() => {
    if (previousBoundary === undefined) delete process.env.DEVRYAN_EXECUTION_BOUNDARY;
    else process.env.DEVRYAN_EXECUTION_BOUNDARY = previousBoundary;
  });
  let imports = 0;
  const install = () => {
    const { root, dist } = fixture();
    const entry = path.join(dist, 'cli-wxk8xvd3.js');
    const text = executableSource();
    fs.writeFileSync(entry, text);
    expect(applyMeridianHttpHotfix({ configDirectory: root, expectedOriginalSha256: sha256(text) })).toMatchObject({ ok: true });
    const project = fs.mkdtempSync(path.join(root, 'project b '));
    return { root, entry, project, load: () => import(`${pathToFileURL(entry).href}?load=${imports++}`) };
  };
  const context = (headers = {}) => ({
    req: { header: (name) => headers[name.toLowerCase()] },
    json: (body, status) => ({ status, body }),
  });
  // opencode-with-claude removes OpenCode's own <env>…Working directory…</env>.
  const scrubbed = { system: 'You are an expert coding assistant.\n\nInstructions from: AGENTS.md' };

  it('runs a scrubbed request in the requesting session directory, not the host process cwd', async () => {
    process.env.DEVRYAN_EXECUTION_BOUNDARY = '1';
    const { project, load } = install();
    const { handleMessages } = await load();
    const header = encodeURIComponent(project);
    await expect(handleMessages(context({ 'x-devryan-directory': header }), scrubbed)).resolves.toEqual({ cwd: project });
    // A stale or injected <env> claim never outranks the session directory.
    await expect(handleMessages(context({ 'x-devryan-directory': header }),
      { system: `<env>\n  Working directory: ${process.cwd()}\n</env>` })).resolves.toEqual({ cwd: project });
  });

  it('refuses rather than falling back to another project inside the execution boundary', async () => {
    process.env.DEVRYAN_EXECUTION_BOUNDARY = '1';
    const { project, load } = install();
    const { handleMessages } = await load();
    for (const headers of [{}, { 'x-devryan-directory': encodeURIComponent(path.join(project, 'missing')) },
      { 'x-devryan-directory': 'relative/project' }, { 'x-devryan-directory': '%E0%A4%A' }]) {
      const result = await handleMessages(context(headers), scrubbed);
      expect(result).toMatchObject({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error' } } });
      expect(result.body.error.message).toMatch(/^session_directory_unavailable: /);
    }
  });

  it('keeps Meridian resolution for clients without the header outside the boundary', async () => {
    delete process.env.DEVRYAN_EXECUTION_BOUNDARY;
    const { project, load } = install();
    const { handleMessages } = await load();
    await expect(handleMessages(context(), { system: `<env>\n  Working directory: ${project}\n</env>` })).resolves.toEqual({ cwd: project });
    await expect(handleMessages(context(), scrubbed)).resolves.toEqual({ cwd: process.cwd() });
    // A header that names no directory is refused even outside the boundary.
    await expect(handleMessages(context({ 'x-devryan-directory': encodeURIComponent(path.join(project, 'gone')) }), scrubbed))
      .resolves.toMatchObject({ status: 400 });
  });

  it('upgrades the previous provider-only installation and stays idempotent', () => {
    const { root, entry } = install();
    const complete = fs.readFileSync(entry, 'utf8');
    const options = { configDirectory: root, expectedOriginalSha256: sha256(executableSource()) };
    const previous = complete
      .replace('import { resolveSessionWorkingDirectory } from "./devryan-session-provider-spawn.js";\n', '')
      .replace(/ {8}const devryanSessionDirectory = [^\n]*\n {8}if \(devryanSessionDirectory\.rejection\)[^\n]*\n {8}const cwdResolution = devryanSessionDirectory\.resolution \?\? resolveSdkWorkingDirectory\(\{/,
        cwdAnchor);
    expect(previous).not.toContain('devryanSessionDirectory');
    fs.writeFileSync(entry, previous);
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: true });
    expect(fs.readFileSync(entry, 'utf8')).toBe(complete);
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: false });
  });

  it('rejects a source without exactly one working-directory anchor', () => {
    const { root, dist } = fixture();
    const text = executableSource().replace(cwdAnchor, '        const cwdResolution = (0, resolveSdkWorkingDirectory)({');
    fs.writeFileSync(path.join(dist, 'cli-wxk8xvd3.js'), text);
    expect(applyMeridianHttpHotfix({ configDirectory: root, expectedOriginalSha256: sha256(text) }))
      .toMatchObject({ ok: false, code: 'MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE' });
  });
});

describe('Meridian upgrade source gates', () => {
  it('supports the candidate without weakening current patch recovery or accepting partial candidates', () => {
    const review = MERIDIAN_REVIEWED_PATCHES['1.68.0'];
    const { root, dist } = fixture('1.68.0');
    const upstreamFork = '...isUndo || forkSession || resumeSessionId && forkSessionId || passthrough && resumeSessionAtUuid ? { forkSession: true } : {},';
    const candidateSource = `${cwdAnchor}\n      pathToClaudeCodeExecutable: claudeExecutable,\nasync function start() {\n${MERIDIAN_HTTP_SERVER_ORIGINAL}\n    port: finalConfig.port\n  }, () => {\n  });\n  const idleMs = finalConfig.idleTimeoutSeconds * 1000;\n}\n${review.edits.map(([before]) => before).join('\n')}\n${upstreamFork}`;
    const entry = path.join(dist, review.entry);
    fs.writeFileSync(entry, candidateSource);
    const options = { configDirectory: root, expectedOriginalSha256: sha256(candidateSource) };
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: true, version: '1.68.0', entry: review.entry });
    const complete = fs.readFileSync(entry, 'utf8');
    expect(complete).toContain(upstreamFork);
    expect(complete).toContain('REPLAY_PROVENANCE_NOTE');
    expect(complete).toContain('continue: false');
    expect(complete).toContain('CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1"');
    expect(complete).not.toContain('CLAUDE_CODE_SESSION_KIND: "bg"');
    expect(complete).toContain('resolveSessionWorkingDirectory(c.req.header("x-devryan-directory"))');
    expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: true, changed: false });
    for (const [before, after] of review.edits) {
      const partial = complete.replace(after, before);
      fs.writeFileSync(entry, partial);
      expect(applyMeridianHttpHotfix(options)).toMatchObject({ ok: false });
      expect(fs.readFileSync(entry, 'utf8')).toBe(partial);
    }
  });
});
