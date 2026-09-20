// Explicit live-QA instrumentation, never imported by a shipped runtime. The
// caller trusts this short-lived certificate only in its owned child process.
// Requests are forwarded byte-for-byte to the fixed OpenAI origin; credentials
// and conversation bodies never enter the returned evidence or files.
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
const hosts = ['chatgpt.com', ...new Set([...metadataRoutes.keys()].map(route => route.split('/')[0]))];

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

export async function createDuplicateWireProxy({ root, context, model = 'gpt-5.6-sol', maximumRequests = 100, fetchImpl = fetch }) {
  const cert = path.join(root, 'wire-cert.pem'), key = path.join(root, 'wire-key.pem');
  const config = path.join(root, 'wire-cert.cnf');
  await fs.writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=chatgpt.com\n[ext]\nsubjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nbasicConstraints=critical,CA:TRUE\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  await fs.chmod(key, 0o600);
  const evidence = [], failures = [], metadata = [], sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  let count = 0;
  const tls = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (req, res) => {
    const metadataRoute = metadataRoutes.get(req.headers.host + req.url);
    if (req.method === 'GET' && metadataRoute) {
      try {
        const response = await fetchImpl('https://' + req.headers.host + req.url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        metadata.push({ route: metadataRoute, statusCode: response.status });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
        for await (const chunk of response.body) if (!res.write(chunk)) await once(res, 'drain');
        res.end();
      } catch { metadata.push({ route: metadataRoute, statusCode: null }); res.writeHead(502); res.end(); }
      return;
    }
    const row = { ...context(), requestIndex: ++count, status: 'incomplete' }; evidence.push(row);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (count > maximumRequests || req.method !== 'POST' || req.headers.host !== 'chatgpt.com'
        || req.url !== '/backend-api/codex/responses') throw new Error('unregistered-request');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('oversized-request'); }
      const body = JSON.parse(raw);
      if (body.model !== model) throw new Error('unregistered-model');
      row.request = projectDuplicateWire(raw);
      const headers = { ...req.headers }; delete headers.host; delete headers.connection;
      const response = await fetchImpl('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST', body: raw, headers, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
      });
      row.statusCode = response.status;
      const parser = createWireUsageParser({ route: { provider: 'openai', transport: 'responses', auth: 'oauth' },
        metadata: { observationID: `duplicate-wire-${row.requestIndex}`, provider: 'openai', transport: 'responses', auth: 'oauth', requestedModel: model,
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
    }
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
  return { evidence, failures, metadata, cert, origin: `http://127.0.0.1:${proxy.address().port}`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); await fs.rm(key, { force: true }); } };
}
