// Behaviour probes of the re-stated edge (BH1; the fix round's decision 4):
// one probe per composed layer whose effect a client can see, sent to a group
// host serving the toy group (toy/toy-routes.mjs) behind the same edge as
// every group. The expectations below are the server's composition facts, not
// the re-statement's: the composition table pins them against the server's
// text (`threshold: 1024`, `app.set('trust proxy', true)`), and the product's
// own layers decide the rest (the probes check that each layer ran, not what
// its values are). A probe that fails means the re-statement composes
// something other than what it says.
import http from 'node:http';
import { importFromServer } from './edge.mjs';

export const EXPECTED = Object.freeze({ compressionThreshold: 1024, trustProxy: true });

/** One request on its own connection, without any decoding. */
export const rawRequest = (port, method, url, { headers = {}, body, timeoutMs = 30_000 } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const request = http.request({ host: '127.0.0.1', port, method, path: url, agent: false, timeout: timeoutMs,
    headers: { connection: 'close', ...headers, ...(payload ? { 'content-length': payload.length } : {}) } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  request.on('timeout', () => request.destroy(new Error(`no answer to ${method} ${url} within ${timeoutMs} ms`)));
  request.on('error', reject);
  request.end(payload);
});
const json = (answer) => { try { return JSON.parse(answer.body.toString('utf8')); } catch { return null; } };

/**
 * The probes: `{ id, layer, run(send) -> problems[] }`. `send(method, url, init)`
 * answers `{ status, headers, body }`.
 */
export const EDGE_PROBES = Object.freeze([
  { id: 'no-store', layer: 'no-store', run: async (send) => {
    const answer = await send('GET', '/api/toy/direct');
    return /\bno-store\b/.test(answer.headers['cache-control'] ?? '') && answer.headers.pragma === 'no-cache' ? [] : [`no-store: an /api answer carries no no-store headers (cache-control ${answer.headers['cache-control']}, pragma ${answer.headers.pragma})`];
  } },
  { id: 'indexing-policy', layer: 'indexing-policy', run: async (send) => {
    const answer = await send('GET', '/api/toy/direct');
    return answer.headers['x-robots-tag'] ? [] : ['indexing-policy: an answer carries no X-Robots-Tag'];
  } },
  { id: 'compression-threshold', layer: 'compression', run: async (send) => {
    const problems = [];
    const threshold = EXPECTED.compressionThreshold;
    for (const [size, encoded] of [[threshold - 1, false], [threshold, true], [threshold + 1, true]]) {
      const answer = await send('GET', `/api/toy/size?n=${size}`, { headers: { 'accept-encoding': 'gzip' } });
      if ((answer.headers['content-encoding'] === 'gzip') !== encoded) problems.push(`compression: a ${size}-byte answer is ${answer.headers['content-encoding'] ?? 'identity'}, expected ${encoded ? 'gzip' : 'identity'} (threshold ${threshold})`);
    }
    return problems;
  } },
  { id: 'compression-skip', layer: 'compression', run: async (send) => {
    // The server's skip policy: a request accepting an event stream is never compressed (an ordinary one of the same size is).
    const problems = [];
    const size = 64 * 1024; // above any threshold a variant plants, so this probe sees the skip policy alone
    const plain = await send('GET', `/api/toy/size?n=${size}`, { headers: { 'accept-encoding': 'gzip' } });
    const stream = await send('GET', `/api/toy/size?n=${size}`, { headers: { 'accept-encoding': 'gzip', accept: 'text/event-stream' } });
    if (plain.headers['content-encoding'] !== 'gzip') problems.push(`compression-skip: a ${size}-byte answer is ${plain.headers['content-encoding'] ?? 'identity'}, expected gzip`);
    if (stream.headers['content-encoding'] !== undefined) problems.push(`compression-skip: a ${size}-byte answer to a request accepting text/event-stream is ${stream.headers['content-encoding']}, expected identity (the server's skip policy)`);
    return problems;
  } },
  { id: 'trust-proxy', layer: 'trust-proxy', run: async (send) => {
    // A forwarded request from loopback is refused by the edge whatever trust proxy says (isDirectLocalRequest),
    // so no client sees the setting through this edge; the composed app's settings are read instead.
    const problems = [];
    const forwarded = await send('GET', '/api/toy/ip', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    if (forwarded.status === 200) problems.push('trust-proxy: a forwarded request from loopback reached the group');
    const express = await importFromServer('express');
    const reference = express();
    reference.set('trust proxy', EXPECTED.trustProxy);
    const expected = Object.fromEntries(Object.entries(reference.settings).filter(([, value]) => typeof value !== 'function'));
    const actual = json(await send('GET', '/api/toy/settings'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`trust-proxy: the composed app's settings are ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    return problems;
  } },
  { id: 'legacy-path', layer: 'legacy-path', run: async (send) => {
    const body = json(await send('GET', '/api/openchamber/toy-alias'));
    return body?.originalUrl === '/api/devryan/toy-alias' ? [] : [`legacy-path: /api/openchamber/toy-alias did not reach the group as /api/devryan/toy-alias (${JSON.stringify(body)})`];
  } },
  { id: 'bundle-admission', layer: 'bundle-admission', run: async (send) => {
    // The admission gate counts write requests until they finish: one more 'finish' listener on a POST than on a GET.
    const read = json(await send('GET', '/api/toy/listeners'));
    const write = json(await send('POST', '/api/toy/listeners', { headers: { 'content-type': 'application/json' }, body: '{}' }));
    return write && read && write.finish > read.finish ? [] : [`bundle-admission: a write request carries no more finish listeners than a read (${JSON.stringify(read)} / ${JSON.stringify(write)})`];
  } },
  { id: 'body-parser-limit', layer: 'base-routes', run: async (send) => {
    const problems = [];
    const small = await send('POST', '/api/preview/toy-json', { headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    if (json(small)?.parsedByEdge !== true) problems.push(`body-parser: a small JSON body under a shared prefix was not parsed by the edge (${small.status})`);
    const big = await send('POST', '/api/preview/toy-json', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }) });
    if (big.status !== 413) problems.push(`body-parser: a 2 MiB JSON body under a 16 KiB shared prefix was answered ${big.status}, not 413`);
    return problems;
  } },
  { id: 'execution-readiness', layer: 'execution-readiness', run: async (send) => {
    const answer = await send('POST', '/api/session/toy/message', { headers: { 'content-type': 'application/json' }, body: '{}' });
    return answer.status === 200 ? [] : [`execution-readiness: a session message was answered ${answer.status} by the edge (a verified bundle is active)`];
  } },
  { id: 'ui-auth', layer: 'base-routes', run: async (send) => {
    // The web composition has no UI password: the session answer says auth is disabled, and a plain /api request reaches the group.
    const problems = [];
    const session = json(await send('GET', '/auth/session'));
    if (session?.authenticated !== true || session?.disabled !== true) problems.push(`ui-auth: /auth/session answered ${JSON.stringify(session)}, not the no-password answer (authenticated, disabled)`);
    const plain = await send('GET', '/api/toy/direct');
    if (plain.status !== 200) problems.push(`ui-auth: a plain loopback /api request was answered ${plain.status} by the edge`);
    return problems;
  } },
  { id: 'local-owner-bootstrap', layer: 'local-owner-bootstrap', run: async (send) => {
    // Its enrollment page is the layer's own answer.
    const answer = await send('GET', '/auth/local-owner-bootstrap');
    return answer.status === 200 && /local owner/i.test(answer.body.toString('utf8')) ? [] : [`local-owner-bootstrap: /auth/local-owner-bootstrap was answered ${answer.status}, not the enrollment page`];
  } },
  { id: 'principal', layer: 'base-routes', run: async (send) => {
    // A plain loopback request reaches the group as the local administrator.
    const body = json(await send('GET', '/api/toy/whoami'));
    return body?.scope === 'local-admin' && body?.role === 'admin' ? [] : [`principal: a plain loopback request reached the group as ${JSON.stringify(body)}, not the local administrator`];
  } },
  { id: 'tunnel-boundary', layer: 'tunnel-boundary', run: async (send) => {
    // A request naming another host, or forwarded from a tunnel, is refused before the group.
    const problems = [];
    for (const headers of [{ host: 'evil.example' }, { 'x-forwarded-host': 'abc.trycloudflare.com', 'x-forwarded-proto': 'https' }]) {
      const answer = await send('GET', '/api/toy/whoami', { headers });
      if (answer.status !== 401 || json(answer)?.tunnelLocked !== true) problems.push(`tunnel-boundary: a request with ${JSON.stringify(headers)} was answered ${answer.status} ${answer.body.toString('utf8').slice(0, 80)}, not the tunnel lock`);
    }
    // The boundary's own answers to a remote request: a content-free liveness answer carrying the instance id, and a refusal of local-only paths.
    const health = await send('GET', '/api/health', { headers: { host: 'evil.example' } });
    if (health.status !== 200 || !health.headers['x-devryan-instance-id'] || health.body.toString('utf8') !== '{"status":"ok"}') problems.push(`tunnel-boundary: a remote /api/health was answered ${health.status} ${health.body.toString('utf8').slice(0, 80)} without the boundary's liveness answer`);
    const localOnly = await send('GET', '/api/runtime-service/toy', { headers: { host: 'evil.example' } });
    if (localOnly.status !== 403) problems.push(`tunnel-boundary: a remote request for a local-only path was answered ${localOnly.status}, not 403`);
    return problems;
  } },
  { id: 'tail', layer: 'group', run: async (send) => {
    const answer = await send('GET', '/api/toy/no-such-route');
    return answer.status === 599 ? [] : [`tail: an unanswered request got ${answer.status}, not the tail stand-in's 599`];
  } },
]);

/** Runs every probe against the toy host on `port`; returns `{ problems, probes }`. */
export async function edgeProbeProblems({ port, probes = EDGE_PROBES }) {
  const send = (method, url, init) => rawRequest(port, method, url, init);
  const problems = [];
  const results = [];
  for (const probe of probes) {
    let found;
    try { found = await probe.run(send); } catch (error) { found = [`${probe.id}: the probe failed: ${error.message}`]; }
    results.push({ id: probe.id, layer: probe.layer, problems: found });
    problems.push(...found);
  }
  return { problems, probes: results };
}
