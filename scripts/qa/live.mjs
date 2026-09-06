import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

// Explicit opt-in: this runner makes two real provider requests. Cookies stay
// in memory; only the session created by this invocation is aborted/deleted.
const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = new URL(process.env.DEVRYAN_QA_LIVE_ORIGIN || 'http://invalid');
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Set DEVRYAN_QA_LIVE_ORIGIN to the explicit http://127.0.0.1:<port> DevRyan origin');
}
const cache = path.join(root, '.cache/qa');
await mkdir(cache, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(cache, 'live-'));
const workspace = path.join(output, 'workspace');
await mkdir(workspace, { mode: 0o700 });
execFileSync('git', ['init', '--quiet', workspace]);
const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME, worktreeRoots: [root, workspace] });
const evidence = { schemaVersion: 1, runtime: 'live-host-http', origin: origin.origin, startedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), outcome: 'failed', checks: [],
  scope: 'real provider and host transport; separate from visual fixture acceptance' };
let cookie = '';
let sessionID;
let eventAbort;
let eventTask;
let deltaCount = 0;
const cleanupErrors = [];
let interrupted = false;
const onInterrupt = () => { interrupted = true; eventAbort?.abort(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const request = async (route, { method = 'GET', body, scoped = true } = {}) => {
  const url = new URL(route, origin);
  if (scoped) url.searchParams.set('directory', workspace);
  const response = await fetch(url, { method, headers: { cookie, 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const until = async (name, predicate, timeout = 90000) => {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (interrupted) throw new Error('Live QA interrupted');
    if (await predicate()) { evidence.checks.push({ name, elapsedMs: performance.now() - start, outcome: 'passed' }); return; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${name}`);
};
const connectEvents = async () => {
  eventAbort = new AbortController();
  const handshake = setTimeout(() => eventAbort.abort(), 15000);
  let response;
  try { response = await fetch(new URL('/api/global/event', origin), { headers: { cookie }, signal: eventAbort.signal }); }
  finally { clearTimeout(handshake); }
  if (!response.ok) throw new Error(`Event stream: HTTP ${response.status}`);
  eventTask = (async () => {
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error('Event frame exceeds QA bound');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const envelope = JSON.parse(line.slice(5));
          const event = envelope.payload ?? envelope;
          if (event.type === 'message.part.delta' && event.properties?.sessionID === sessionID) deltaCount += 1;
        }
      }
    }
  })().catch((error) => { if (error.name !== 'AbortError') evidence.streamError = sanitizer.sanitizeText(error.message); });
};
try {
  const login = await fetch(new URL('/auth/agent-test-session', origin), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' }, body: JSON.stringify({ email: 'admin@1health.ae' }), signal: AbortSignal.timeout(15000) });
  if (!login.ok) throw new Error(`Password-free fixture login: HTTP ${login.status}`);
  cookie = login.headers.getSetCookie().map((header) => header.split(';')[0]).join('; ');
  const providers = await request('/api/provider');
  const provider = providers.all.find((provider) => provider.id === 'openai' && providers.connected.includes(provider.id));
  const modelID = providers.default?.openai;
  if (!provider?.models?.[modelID]) throw new Error('No configured default OpenAI model is available for the live smoke');
  const agents = await request('/api/agent');
  const agent = agents.find((agent) => ['builder', 'build'].includes(agent.name) && !agent.hidden);
  if (!agent) throw new Error('No existing Builder agent available');
  const toolIDs = await request('/api/experimental/tool/ids');
  if (!Array.isArray(toolIDs) || !toolIDs.every((id) => typeof id === 'string')) throw new Error('Cannot disable the complete tool inventory');
  const session = await request('/api/session', { method: 'POST', body: { title: 'DevRyan QA live smoke', permission: [{ permission: '*', pattern: '*', action: 'deny' }] } });
  if (typeof session.id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(session.id)) throw new Error('Missing canonical QA session identity');
  sessionID = session.id;
  evidence.sessionID = sessionID;
  evidence.provider = { providerID: provider.id, modelID, agent: agent.name };
  await connectEvents();
  const send = (text) => request(`/api/session/${sessionID}/prompt_async`, { method: 'POST', body: {
    model: { providerID: provider.id, modelID }, agent: agent.name, tools: Object.fromEntries(toolIDs.map((id) => [id, false])),
    system: 'This is an automated transport smoke test. Answer only the requested text. Do not use tools, inspect files, or delegate.',
    parts: [{ type: 'text', text }],
  } });
  const messages = () => request(`/api/session/${sessionID}/message`);
  await send('Reply with exactly: DevRyan QA ready.');
  await until('first response completes', async () => (await messages()).some((row) => row.info?.role === 'assistant' && row.info?.time?.completed && row.parts?.some((part) => part.type === 'text' && part.text?.includes('DevRyan QA ready'))));
  const before = deltaCount;
  await send('Count from 1 to 100, one number per line. Output only the numbers.');
  await until('second response streams', async () => deltaCount > before);
  eventAbort.abort();
  await eventTask;
  await connectEvents();
  evidence.checks.push({ name: 'event stream reconnect', outcome: 'passed' });
  await request(`/api/session/${sessionID}/abort`, { method: 'POST' });
  await until('abort settles session', async () => { const status = await request('/api/session/status'); return !status[sessionID] || status[sessionID].type === 'idle'; });
  const rows = await messages();
  evidence.userMessageIDs = rows.filter((row) => row.info.role === 'user').map((row) => row.info.id);
  if (evidence.userMessageIDs.length !== 2 || new Set(evidence.userMessageIDs).size !== 2) throw new Error('Unexpected duplicate/missing user turns');
  evidence.deltaCount = deltaCount;
  evidence.diagnostics = await request('/api/diagnostics/status', { scoped: false });
  if (evidence.streamError) throw new Error('Event reader failed');
  evidence.outcome = 'passed';
} catch (error) { evidence.error = sanitizer.sanitizeText(error.message); }
finally {
  eventAbort?.abort();
  await eventTask;
  if (sessionID) {
    for (const [route, method] of [[`/api/session/${sessionID}/abort`, 'POST'], [`/api/session/${sessionID}`, 'DELETE']]) {
      try { await request(route, { method }); } catch (error) { cleanupErrors.push(error.message); }
    }
  }
  if (cookie) { try { await request('/auth/logout', { method: 'POST', scoped: false }); } catch (error) { cleanupErrors.push(error.message); } }
  evidence.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) evidence.outcome = 'failed';
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  evidence.finishedAt = new Date().toISOString();
  if (!cleanupErrors.length) {
    try { await rm(workspace, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error.message); evidence.outcome = 'failed'; }
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...sanitizer.sanitizeExportValue(evidence), revision: evidence.revision }, null, 2));
}
console.log(JSON.stringify({ output, outcome: evidence.outcome, error: evidence.error }));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
