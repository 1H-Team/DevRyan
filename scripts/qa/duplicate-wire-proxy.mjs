// Explicit live-QA instrumentation, never imported by a shipped runtime. The
// caller trusts this short-lived certificate only in its owned child process.
// Requests are forwarded byte-for-byte to the selected route's fixed origin;
// credentials and conversation bodies never enter the returned evidence or files.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectWireRequest, createWireUsageParser } from './cache-wire-evidence.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const metadataRoutes = new Map([
  ['opencode.ai/zen/v1/models', 'zen-model-catalog'], ['models.dev/api.json', 'model-catalog'],
  ['antigravity-auto-updater-974169037036.us-central1.run.app/', 'antigravity-version'],
  ['antigravity.google/changelog', 'antigravity-changelog'],
]);
const metadataHosts = [...new Set([...metadataRoutes.keys()].map(route => route.split('/')[0]))];

// One registered inference route per provider, selected by the proposal's
// providerID. Both are Responses bodies (`input` items with function_call /
// function_call_output pairs). `transportIdentity` is the host-attested route a
// release profile's `transport` must equal (lib/opencode/duplicate-provider-route.js).
export const DUPLICATE_WIRE_ROUTES = Object.freeze({
  openai: Object.freeze({ provider: 'openai', host: 'chatgpt.com', path: '/backend-api/codex/responses',
    transport: 'responses', auth: 'oauth', transportIdentity: 'openai-chatgpt-managed-responses-v1' }),
  // OpenCode's xAI loader selects @ai-sdk/xai Responses; its OAuth plugin keeps
  // the SDK default origin and injects the bearer token.
  xai: Object.freeze({ provider: 'xai', host: 'api.x.ai', path: '/v1/responses',
    transport: 'responses', auth: 'oauth', transportIdentity: 'xai-oauth-responses-v1' }),
});
// Claude runs behind a loopback Meridian proxy: OpenCode sends Anthropic
// Messages to 127.0.0.1 (never through HTTPS_PROXY), and Meridian's Claude Code
// child owns the Anthropic request. This proxy cannot observe the projected body.
const unsupportedRoutes = new Map([['anthropic', 'unsupported-route:anthropic-meridian']]);
export const resolveDuplicateWireRoute = providerID => {
  if (typeof providerID === 'string' && Object.hasOwn(DUPLICATE_WIRE_ROUTES, providerID)) return DUPLICATE_WIRE_ROUTES[providerID];
  throw new Error(unsupportedRoutes.get(providerID)
    ?? `unsupported-route:${typeof providerID === 'string' && /^[a-z0-9._-]{1,64}$/.test(providerID) ? providerID : 'unknown'}`);
};

export const projectDuplicateWire = raw => {
  const body = JSON.parse(raw);
  const items = body.input ?? [];
  const calls = items.filter(item => item.type === 'function_call');
  const outputs = items.filter(item => item.type === 'function_call_output');
  const managed = outputs.filter(item => typeof item.output === 'string' && item.output.includes('"observation":"identical-managed-result"'));
  const visible = strings(body);
  const lastUser = items.findLast(item => item.role === 'user');
  const token = strings(lastUser?.content).join('\n').match(/^DUPLICATE_QA_CASE_(\d+):/m);
  const values = outputs.flatMap(item => {
    try { return strings(JSON.parse(item.output)); } catch { return strings(item.output); }
  });
  const factHashes = values.flatMap(value => {
    const fact = value.match(/DUPLICATE_QA_FACT=(\{[^\n]+\})/);
    try { return fact ? [hash(JSON.parse(fact[1]))] : []; } catch { return []; }
  });
  return { ...projectWireRequest(raw), skillReferences: visible.filter(value => value.includes('<devryan_skill_reuse>')).length,
    managedReferences: visible.filter(value => value.includes('"observation":"identical-managed-result"')).length,
    trialIndex: token && outputs.length ? Number(token[1]) : null,
    factHashes: [...new Set(factHashes)], uniqueProofHashes: values.filter(value => value.startsWith('uniqueProof=')).map(value => hash(value.slice('uniqueProof='.length))),
    callPairsIntact: outputs.every(item => calls.some(call => call.call_id === item.call_id)),
    referencesResolve: managed.every(item => {
      const ref = JSON.parse(item.output);
      return outputs.some(source => {
        if (source.call_id !== ref.reference?.callID) return false;
        try { const value = JSON.parse(source.output); return value.task?.taskId === ref.taskId && value.resultHeader?.envelopeId === ref.envelopeId && !value.observation; }
        catch { return false; }
      });
    }),
    fixtureEvidenceHashes: outputs.filter(item => typeof item.output === 'string' && item.output.includes('DUPLICATE_QA_FACT'))
      .map(item => createHash('sha256').update(item.output).digest('hex')) };
};

export async function createDuplicateWireProxy({ root, context, providerID, model, maximumRequests = 100, fetchImpl = fetch }) {
  const route = resolveDuplicateWireRoute(providerID);
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(model)) throw new Error('unregistered-model');
  const hosts = [route.host, ...metadataHosts], upstream = `https://${route.host}${route.path}`;
  const cert = path.join(root, 'wire-cert.pem'), key = path.join(root, 'wire-key.pem');
  const config = path.join(root, 'wire-cert.cnf');
  await fs.writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${route.host}\n[ext]\nsubjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nbasicConstraints=critical,CA:TRUE\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  await fs.chmod(key, 0o600);
  const evidence = [], failures = [], metadata = [], sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  let count = 0, inflight = 0;
  const idleWaiters = new Set();
  const settle = () => { if (inflight === 0) for (const resolve of idleWaiters) resolve(true); };
  const tls = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (req, res) => {
    const metadataRoute = metadataRoutes.get(req.headers.host + req.url);
    if (req.method === 'GET' && metadataRoute) {
      try {
        const response = await fetchImpl('https://' + req.headers.host + req.url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        metadata.push({ route: metadataRoute, statusCode: response.status });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
        for await (const chunk of response.body) if (!res.write(chunk)) await once(res, 'drain');
        res.end();
      } catch {
        // A catalog can fail after its headers were forwarded (upstream cut or
        // client gone): end or destroy the response instead of throwing.
        metadata.push({ route: metadataRoute, statusCode: null });
        if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
      }
      return;
    }
    const row = { ...context(), requestIndex: ++count, status: 'incomplete' }; evidence.push(row);
    inflight++;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (count > maximumRequests || req.method !== 'POST' || req.headers.host !== route.host
        || req.url !== route.path) throw new Error('unregistered-request');
      // Buffer whole chunks: decoding each chunk alone would corrupt a UTF-8
      // sequence split across chunks, and the forwarded bytes must be the client's.
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('oversized-request'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), raw = bytes.toString('utf8');
      const body = JSON.parse(raw);
      if (body.model !== model) throw new Error('unregistered-model');
      row.request = projectDuplicateWire(raw);
      const headers = { ...req.headers }; delete headers.host; delete headers.connection;
      const response = await fetchImpl(upstream, {
        method: 'POST', body: bytes, headers, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
      });
      row.statusCode = response.status;
      const { provider, transport, auth } = route;
      const parser = createWireUsageParser({ route: { provider, transport, auth },
        metadata: { observationID: `duplicate-wire-${row.requestIndex}`, provider, transport, auth, route: route.transportIdentity, requestedModel: model,
          purpose: row.request.trialIndex === null ? 'unknown' : 'main', timing: { dispatch: { at: Date.now(), origin: 'client_wire' } } },
        sse: response.headers.get('content-type')?.includes('text/event-stream') });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
      for await (const chunk of response.body) { parser.push(chunk, Date.now()); if (!res.write(chunk)) await once(res, 'drain'); }
      Object.assign(row, parser.finish(response.ok ? 'complete' : 'failed', Date.now()));
      row.status = response.ok && !row.gap && !row.providerError ? 'complete' : 'failed';
      res.end();
    } catch (error) {
      row.status = 'failed'; row.failure = ['unregistered-request', 'oversized-request', 'unregistered-model'].includes(error.message) ? error.message : 'transport-failed';
      failures.push(row.failure); if (!res.headersSent) res.writeHead(502); res.end();
    } finally { inflight--; settle(); }
  });
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (req, socket, head) => {
    if (!hosts.some(host => req.url === `${host}:443`)) {
      failures.push(`unregistered-connect:${/^[a-z0-9.-]+:443$/.test(req.url) ? req.url : 'unknown'}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    tls.emit('connection', socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { route, evidence, failures, metadata, cert, origin: `http://127.0.0.1:${proxy.address().port}`,
    // Resolves true once no forwarded request is in flight (a session's
    // background title request can outlive its reply), false on timeout.
    idle(timeoutMs) {
      if (inflight === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timer); idleWaiters.delete(done); resolve(value); };
        const timer = setTimeout(() => done(false), timeoutMs);
        idleWaiters.add(done);
      });
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); await fs.rm(key, { force: true }); } };
}
