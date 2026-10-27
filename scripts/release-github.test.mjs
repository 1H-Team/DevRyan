import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DIGEST_TIMEOUT_MS, githubClient, repositoryOfUrl } from './release-github.mjs';

const repository = '1H-Team/DevRyan';
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
const truncated = status => new Response(new ReadableStream({ start(controller) {
  controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
} }), { status });
const clock = () => {
  let time = 0;
  const waits = [];
  return { waits, now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
};
const client = (fetchImpl, options = {}) => {
  const time = clock();
  return { time, github: githubClient({ token: 'fixture-token', fetchImpl, repository, environment: {}, random: () => 0, ...time, ...options }) };
};

test('idempotent requests retry 502, 503, resets and timeouts with 1-2-4 s backoff, then succeed', async () => {
  const outcomes = [() => json(502, { message: 'bad gateway' }), () => json(503, {}), () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); },
    () => json(200, { ok: true })];
  const seen = [];
  const { github, time } = client(async (_url, init) => { seen.push(init.signal instanceof AbortSignal); return outcomes.shift()(); });
  assert.deepEqual(await github.request('GET', '/releases/1'), { ok: true });
  assert.deepEqual(time.waits, [1000, 2000, 4000]);
  assert.ok(seen.every(Boolean), 'every request carries a timeout signal');
});

test('a 403 with retry-after or an exhausted rate limit waits as asked; a plain 403 or 404 fails at once', async () => {
  const limited = [json(403, { message: 'secondary rate limit' }, { 'retry-after': '7' }), json(200, [])];
  const { github, time } = client(async () => limited.shift());
  await github.request('GET', '/releases');
  assert.deepEqual(time.waits, [7000]);
  for (const response of [() => json(403, { message: 'Resource not accessible by integration' }), () => json(404, { message: 'Not Found' }), () => json(422, { message: 'Validation Failed' })]) {
    let calls = 0;
    const { github: strict, time: idle } = client(async () => { calls++; return response(); });
    await assert.rejects(strict.request('GET', '/releases/9'), /failed \((403|404|422)\)/);
    assert.equal(calls, 1);
    assert.deepEqual(idle.waits, []);
  }
});

test('response bodies stay inside the retry boundary, but POST still reconciles instead of repeating', async () => {
  for (const status of [200, 502]) {
    let calls = 0;
    const { github, time } = client(async () => ++calls === 1 ? truncated(status) : json(200, { ok: true }));
    assert.deepEqual(await github.request('GET', '/releases/1'), { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(time.waits, [1000]);
  }
  let calls = 0;
  const { github } = client(async () => { calls++; return truncated(201); });
  await assert.rejects(github.request('POST', '/releases', { body: {} }), error => error.retryable === true);
  assert.equal(calls, 1);
});

test('the retry budget is bounded and the error says how many attempts failed', async () => {
  let calls = 0;
  const { github } = client(async () => { calls++; return json(500, { message: 'boom' }); });
  await assert.rejects(github.request('GET', '/releases/1'), /failed \(500\)/);
  assert.equal(calls, 4);
  calls = 0;
  const { github: network } = client(async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(network.request('PATCH', '/releases/1', { body: {} }), /failed after 4 attempt\(s\)/);
  assert.equal(calls, 4);
});

test('POST is never blindly repeated, and a repeated DELETE that already landed is success', async () => {
  let calls = 0;
  const { github } = client(async () => { calls++; return json(502, {}); });
  await assert.rejects(github.request('POST', '/releases', { body: {} }), /502/);
  assert.equal(calls, 1);
  const responses = [json(502, {}), json(404, { message: 'Not Found' })];
  const { github: deleting } = client(async () => responses.shift());
  assert.equal(await deleting.request('DELETE', '/releases/assets/5'), null);
});

test('a caller deadline is final while the per-request timeout aborts a hung socket', async () => {
  // Like fetch: an aborted signal rejects at once, a later abort rejects the pending request.
  const { github } = client(async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 5, attempts: 2 });
  await assert.rejects(github.request('GET', '/releases/1'), /failed after 2 attempt/);
  const caller = new AbortController();
  caller.abort(new Error('caller deadline'));
  await assert.rejects(github.request('GET', '/releases/1', { signal: caller.signal }), /caller deadline/);
});

test('listings follow pages past the first 100 releases', async () => {
  const releases = Array.from({ length: 230 }, (_, index) => ({ id: index + 1, tag_name: `v1.0.${index}` }));
  const pages = [];
  const { github } = client(async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    assert.equal(new URL(url).searchParams.get('per_page'), '100');
    return json(200, releases.slice((page - 1) * 100, page * 100));
  });
  assert.equal((await github.paginate('/releases')).length, 230);
  assert.deepEqual(pages, [1, 2, 3]);
  const { github: keyed } = client(async () => json(200, { total_count: 1, workflow_runs: [{ id: 1 }] }));
  assert.deepEqual(await keyed.paginate('/actions/workflows/release.yml/runs?head_sha=abc', { key: 'workflow_runs' }), [{ id: 1 }]);
  const { github: endless } = client(async () => json(200, releases.slice(0, 100)));
  await assert.rejects(endless.paginate('/releases', { maxPages: 3 }), /exceeded 3 pages/);
});

test('every write names its repository and a dry run cannot write to the canonical one', async () => {
  assert.equal(repositoryOfUrl('https://uploads.github.com/repos/1H-Team/DevRyan/releases/1/assets?name=x'), repository);
  assert.throws(() => repositoryOfUrl('https://github.com/1H-Team/DevRyan/releases'), /repository URL/);
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(200, {}); };
  const dry = githubClient({ token: 't', fetchImpl, repository, environment: { RELEASE_DRY_RUN: 'true' } });
  await dry.request('GET', '/releases');
  for (const method of ['POST', 'PATCH', 'DELETE']) await assert.rejects(dry.request(method, '/releases/1', { body: {} }), { code: 'release_dry_run_write_forbidden' });
  await assert.rejects(dry.request('POST', 'https://uploads.github.com/repos/1H-Team/DevRyan/releases/1/assets?name=x', { body: Buffer.from('x') }), { code: 'release_dry_run_write_forbidden' });
  await assert.rejects(githubClient({ token: 't', fetchImpl, repository: 'fork/DevRyan', environment: {} }).request('PATCH', '/releases/1', { body: {} }), { code: 'release_dry_run_write_forbidden' });
  await githubClient({ token: 't', fetchImpl, repository, environment: {} }).request('PATCH', '/releases/1', { body: {} });
  assert.equal(calls, 2);
});

// Upload double: a release's asset list plus a scripted response per upload attempt.
async function uploadFixture(t, { assets = [], uploads = [], digestAfterPolls = 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-upload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'DevRyan-9.8.7-arm64.dmg');
  await fs.writeFile(file, 'installer bytes');
  const sha256 = crypto.createHash('sha256').update('installer bytes').digest('hex');
  const state = { assets: [...assets], calls: [], polls: 0, nextId: 50 };
  const fetchImpl = async (url, init = {}) => {
    const { pathname, hostname } = new URL(url);
    state.calls.push(`${init.method} ${hostname === 'uploads.github.com' ? 'upload' : pathname}`);
    if (init.method === 'GET') {
      state.polls++;
      return json(200, state.assets.map(asset => asset.digestPending && state.polls <= digestAfterPolls ? { ...asset, digest: null } : asset));
    }
    if (init.method === 'DELETE') {
      const id = Number(pathname.split('/').at(-1));
      state.assets = state.assets.filter(asset => asset.id !== id);
      return json(204);
    }
    let size = 0;
    for await (const chunk of init.body) size += chunk.byteLength;
    assert.equal(init.duplex, 'half');
    assert.equal(init.headers['Content-Length'], String(size));
    const outcome = uploads.shift() ?? 'ok';
    const asset = { id: state.nextId++, name: 'DevRyan-9.8.7-arm64.dmg', size, state: 'uploaded', digest: `sha256:${sha256}` };
    if (outcome === 'ok') { state.assets.push(asset); return json(201, asset); }
    if (outcome === 'partial') { state.assets.push({ ...asset, state: 'starter', digest: null }); return json(502, {}); }
    if (outcome === 'landed-then-reset') { state.assets.push(asset); throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }
    if (outcome === 'truncated-body') { state.assets.push(asset); return truncated(201); }
    if (outcome === 'exists') return json(422, { errors: [{ code: 'already_exists' }] });
    if (outcome === 'late-digest') { state.assets.push({ ...asset, digestPending: true }); return json(201, { ...asset, digest: null }); }
    if (outcome === 'corrupt') { state.assets.push({ ...asset, digest: `sha256:${'0'.repeat(64)}` }); return json(201, asset); }
    return json(Number(outcome), { message: 'scripted' });
  };
  const time = clock();
  const github = githubClient({ token: 't', fetchImpl, repository, environment: {}, random: () => 0, ...time });
  return { github, state, time, input: { name: 'DevRyan-9.8.7-arm64.dmg', file, size: 15, sha256 } };
}

test('upload streams the file once and returns the uploaded asset', async t => {
  const { github, state, input } = await uploadFixture(t);
  const { asset, uploaded } = await github.uploadAsset(7, input);
  assert.equal(uploaded, true);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST')), ['POST upload']);
});

test('an identical asset already on the draft is kept without uploading', async t => {
  const { github, state, input } = await uploadFixture(t);
  state.assets.push({ id: 3, name: input.name, size: 15, state: 'uploaded', digest: `sha256:${input.sha256}` });
  assert.deepEqual(await github.uploadAsset(7, input), { asset: state.assets[0], uploaded: false });
  assert.ok(state.calls.every(call => call.startsWith('GET')));
});

test('a partial starter upload and a different-bytes asset are deleted, never accepted', async t => {
  const { github, state, input } = await uploadFixture(t, { uploads: ['partial', 'ok'],
    assets: [{ id: 4, name: 'DevRyan-9.8.7-arm64.dmg', size: 15, state: 'uploaded', digest: `sha256:${'f'.repeat(64)}` }] });
  const { asset } = await github.uploadAsset(7, input);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.deepEqual(state.assets.map(row => row.state), ['uploaded']);
  assert.ok(state.calls.includes('DELETE /repos/1H-Team/DevRyan/releases/assets/4'));
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 2);
});

test('an upload that landed before its connection reset is reconciled by digest, not duplicated', async t => {
  const { github, state, input } = await uploadFixture(t, { uploads: ['landed-then-reset'] });
  const { asset } = await github.uploadAsset(7, input);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
  assert.equal(state.assets.length, 1);
});

test('a landed upload with a truncated response body is reconciled without re-uploading', async t => {
  const { github, state, input } = await uploadFixture(t, { uploads: ['truncated-body'] });
  assert.equal((await github.uploadAsset(7, input)).asset.digest, `sha256:${input.sha256}`);
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
  assert.equal(state.calls.filter(call => call.startsWith('DELETE')).length, 0);
});

test('422 already_exists reconciles against the existing asset', async t => {
  const { github, state, input } = await uploadFixture(t, { uploads: ['exists'] });
  state.assets.push({ id: 9, name: input.name, size: 15, state: 'starter', digest: null });
  await assert.rejects(github.uploadAsset(7, input, { attempts: 1 }), /did not produce/);
  const second = await uploadFixture(t, { uploads: ['exists', 'ok'] });
  assert.equal((await second.github.uploadAsset(7, second.input)).asset.digest, `sha256:${second.input.sha256}`);
});

test('a digest that appears late is polled for instead of failing or re-uploading', async t => {
  const { github, state, input, time } = await uploadFixture(t, { uploads: ['late-digest'], digestAfterPolls: 4 });
  const { asset } = await github.uploadAsset(7, input);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
  assert.ok(time.waits.length >= 1 && time.waits.every(ms => ms <= 2000));
});

test('an uploaded asset whose digest arrives after more than 30 s is waited for, never deleted or uploaded again', async t => {
  // Polls every 2 s: the digest appears on the 26th listing, about 50 s after the upload.
  const { github, state, input, time } = await uploadFixture(t, { uploads: ['late-digest'], digestAfterPolls: 25 });
  const { asset, uploaded } = await github.uploadAsset(7, input);
  assert.equal(uploaded, true);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.ok(time.now() > 30_000, `waited ${time.now()} ms`);
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
  assert.ok(!state.calls.some(call => call.startsWith('DELETE')), state.calls.join('\n'));
  assert.equal(DIGEST_TIMEOUT_MS, 10 * 60_000);
});

test('a digest still missing after ten minutes stops the upload and keeps the asset for a rerun', async t => {
  const { github, state, input, time } = await uploadFixture(t, { uploads: ['late-digest'], digestAfterPolls: 10_000 });
  await assert.rejects(github.uploadAsset(7, input), /has not computed the digest of DevRyan-9\.8\.7-arm64\.dmg asset 50 \(15 bytes\) after 600 seconds; it is kept/);
  assert.ok(time.now() >= DIGEST_TIMEOUT_MS);
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
  assert.ok(!state.calls.some(call => call.startsWith('DELETE')));
  assert.equal(state.assets.length, 1);
});

test('an undigested row of another size is not waited for: it is deleted and the DMG uploaded', async t => {
  const { github, state, input, time } = await uploadFixture(t, { assets: [{ id: 6, name: 'DevRyan-9.8.7-arm64.dmg', size: 3, state: 'uploaded', digest: null }] });
  const { asset } = await github.uploadAsset(7, input);
  assert.equal(asset.digest, `sha256:${input.sha256}`);
  assert.deepEqual(time.waits, []);
  assert.ok(state.calls.includes('DELETE /repos/1H-Team/DevRyan/releases/assets/6'));
  assert.equal(state.calls.filter(call => call === 'POST upload').length, 1);
});

test('5xx and rate limits retry within the budget; a 401 stops at once; the budget ends with a clear error', async t => {
  const retried = await uploadFixture(t, { uploads: ['503', 'ok'] });
  assert.equal((await retried.github.uploadAsset(7, retried.input)).uploaded, true);
  assert.deepEqual(retried.time.waits, [1000]);
  const denied = await uploadFixture(t, { uploads: ['401'] });
  await assert.rejects(denied.github.uploadAsset(7, denied.input), /failed \(401\)/);
  const exhausted = await uploadFixture(t, { uploads: ['corrupt', 'corrupt', 'corrupt'] });
  await assert.rejects(exhausted.github.uploadAsset(7, exhausted.input), /did not produce sha256:[a-f0-9]{64} after 3 attempt/);
});
