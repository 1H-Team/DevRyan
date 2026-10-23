import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { githubClient } from './release-github.mjs';
import { createFakeGitHub } from './release-github-fake.mjs';
import { formatReleaseMarker, releaseBody } from './release-state.mjs';
import { DISCOVERY_TARGET_MS, downloadDeadlineMs, main, verifyPublicRelease } from './release-verify-public.mjs';

const version = '9.8.7';
const source = 'a'.repeat(40);
const name = `DevRyan-${version}-arm64.dmg`;
const bytes = Buffer.from('published installer bytes');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const notes = '- Fixed things.';
const quiet = () => {};
const instant = async () => {};
const marker = formatReleaseMarker({ version, sha256: sha(bytes), size: bytes.length, source, runId: '41', runAttempt: '1' });

/** A fake GitHub holding v9.8.7 exactly as the release job leaves it: published, latest, one asset, the ledger tag. */
function published({ ledger = true, body = releaseBody(notes, marker), draft = false } = {}) {
  const fake = createFakeGitHub({ tags: { [`v${version}`]: source } });
  const at = '2026-10-23T06:00:00Z';
  fake.state.releases.push({ id: 1, tag_name: `v${version}`, target_commitish: source, name: `DevRyan v${version}`, body, draft: false, prerelease: false,
    created_at: at, updated_at: at, published_at: at, assets: [{ id: 2, name, size: bytes.length, state: 'uploaded', digest: `sha256:${sha(bytes)}`,
      created_at: at, updated_at: at, blob: { inline: bytes.toString('base64') } }] });
  fake.state.latestId = 1;
  if (draft) fake.state.releases.push({ id: 3, tag_name: `v${version}`, target_commitish: source, name: 'stale', body, draft: true, prerelease: false, created_at: at, updated_at: at, published_at: null, assets: [] });
  if (ledger) {
    const tagSha = 'b'.repeat(40);
    fake.state.tagObjects[tagSha] = { sha: tagSha, tag: `devryan-release/v${version}`, message: `${marker}\n`, object: { type: 'commit', sha: source } };
    fake.state.refs[`tags/devryan-release/v${version}`] = { type: 'tag', sha: tagSha };
  }
  return fake;
}

async function changelogRoot(t, section = notes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-verify-public-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}]\n\n${section}\n\n## [9.8.6]\n\n- Older.\n`);
  return root;
}

const anonymous = fetchImpl => githubClient({ anonymous: true, fetchImpl, environment: { RELEASE_DRY_RUN: 'true' } });
const verify = (fake, root, options = {}) => verifyPublicRelease({ version, client: anonymous(fake.fetchImpl), fetchImpl: fake.fetchImpl, repositoryRoot: root, log: quiet, wait: instant, ...options });

test('a published release verifies read-only from the ledger, with the discovery latency logged against the 60-second target', async t => {
  const fake = published();
  const lines = [];
  let time = Date.parse('2026-10-23T06:00:42Z');
  const report = await verify(fake, await changelogRoot(t), { log: line => lines.push(line), now: () => time });
  assert.deepEqual(report.checks.map(check => check.name), ['ledger', 'discovery', 'release notes', 'drafts', 'public download']);
  assert.equal(report.discoveryLatencyMs, 42_000);
  assert.equal(report.withinTarget, true);
  assert.ok(lines.includes(`[release] updater-discovery-latency-ms=42000 target-ms=${DISCOVERY_TARGET_MS} met`), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('[release] updater-discovery-verified-at=2026-10-23T06:00:42.000Z')));
  assert.ok(fake.requests.every(request => request.method === 'GET'), 'never writes');
  assert.deepEqual(fake.state.effects, []);
  time = Date.parse('2026-10-23T06:05:00Z');
  const late = [];
  assert.equal((await verify(fake, await changelogRoot(t), { log: line => late.push(line), now: () => time })).withinTarget, false);
  assert.ok(late.some(line => line.endsWith('target-ms=60000 missed')), 'a missed target is a metric, not a failure');
});

test('without a ledger, or with a ledger that disagrees with the candidate, verification is pending', async t => {
  const root = await changelogRoot(t);
  await assert.rejects(verify(published({ ledger: false }), root), /v9\.8\.7 is published \(promotion and the ledger are recorded\); verification pending: devryan-release\/v9\.8\.7 is missing/);
  await verify(published({ ledger: false }), root, { expected: { sha256: sha(bytes), size: bytes.length } });
  await assert.rejects(verify(published(), root, { expected: { sha256: 'c'.repeat(64), size: bytes.length } }), /verification pending: the ledger records sha256:/);
});

test('a lingering draft, changed notes or a foreign marker is verification pending', async t => {
  const root = await changelogRoot(t);
  const fake = published({ draft: true });
  // Drafts are visible only to an authenticated writer.
  await verify(fake, root);
  await assert.rejects(verify(fake, root, { client: githubClient({ token: 'read-token', fetchImpl: fake.fetchImpl, environment: { RELEASE_DRY_RUN: 'true' } }) }), /1 draft\(s\) for v9\.8\.7 remain/);
  await assert.rejects(verify(published(), await changelogRoot(t, '- Something else.')), /release notes differ from the CHANGELOG\.md section/);
  await assert.rejects(verify(published({ body: notes }), root), /body marker does not name the published bytes/);
  const lines = [];
  await verify(published(), await changelogRoot(t, '').then(async other => { await fs.writeFile(path.join(other, 'CHANGELOG.md'), '# Changelog\n'); return other; }), { log: line => lines.push(line) });
  assert.ok(lines.some(line => /pass release notes: skipped/.test(line)));
});

test('a release superseded by a newer latest verifies its own tag instead', async t => {
  const fake = published();
  fake.state.releases.push({ id: 9, tag_name: 'v10.0.0', target_commitish: source, name: 'newer', body: '', draft: false, prerelease: false,
    created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', published_at: '2026-10-24T00:00:00Z', assets: [] });
  fake.state.latestId = 9;
  const report = await verify(fake, await changelogRoot(t));
  assert.match(report.checks.find(check => check.name === 'discovery').detail, /superseded by v10\.0\.0/);
});

test('the public download deadline scales with size and a dropped connection resumes with a Range request', async t => {
  assert.equal(downloadDeadlineMs(438_510_849), 60_000 + 87_703, 'the v2.1.10 DMG gets 60 s plus 5 MB/s');
  assert.equal(downloadDeadlineMs(10_000_000, { bytesPerSecond: 1_000_000, slackMs: 0 }), 10_000);
  const root = await changelogRoot(t);
  const fake = published();
  let dropped = false;
  const ranges = [];
  const fetchImpl = async (url, init) => {
    const response = await fake.fetchImpl(url, init);
    if (!String(url).includes('/releases/download/')) return response;
    ranges.push(init.headers.Range ?? null);
    if (dropped) return response;
    dropped = true;
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    let pulls = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(first.value.subarray(0, 5));
      else controller.error(new Error('socket hang up'));
    } }), { status: 200 });
  };
  await verifyPublicRelease({ version, client: anonymous(fetchImpl), fetchImpl, repositoryRoot: root, log: quiet, wait: instant });
  assert.deepEqual(ranges, [null, 'bytes=5-']);
  // A stalled download fails at its size-scaled deadline as verification pending.
  const stalled = async (url, init) => String(url).includes('/releases/download/')
    ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('download aborted')), { once: true }))
    : fake.fetchImpl(url, init);
  await assert.rejects(verifyPublicRelease({ version, client: anonymous(stalled), fetchImpl: stalled, repositoryRoot: root, log: quiet, wait: instant, downloadSlackMs: 5 }),
    /verification pending: the public download did not hash to the ledger bytes within 0 seconds: download aborted/);
});

test('an anonymous client can never write', async () => {
  const fake = published();
  const client = anonymous(fake.fetchImpl);
  for (const method of ['POST', 'PATCH', 'DELETE']) await assert.rejects(client.request(method, '/releases/1', { body: {} }), /anonymous GitHub client cannot/);
  assert.throws(() => githubClient({ fetchImpl: fake.fetchImpl }), /GITHUB_TOKEN is required/);
  assert.deepEqual(fake.requests, []);
});

test('the CLI takes exactly vX.Y.Z, runs anonymously without a token and writes a step summary', async t => {
  await assert.rejects(main({ argv: ['9.8.7'] }), /Usage/);
  await assert.rejects(main({ argv: [`v${version}`, 'extra'] }), /Usage/);
  const fake = published();
  const summary = path.join(await changelogRoot(t), 'summary.md');
  const report = await main({ argv: [`v${version}`], environment: { GITHUB_STEP_SUMMARY: summary }, fetchImpl: fake.fetchImpl, log: quiet });
  assert.equal(report.version, version);
  assert.ok(fake.requests.every(request => request.method === 'GET'));
  assert.match(await fs.readFile(summary, 'utf8'), /### Post-publish verification v9\.8\.7\n\n- pass ledger/);
});
