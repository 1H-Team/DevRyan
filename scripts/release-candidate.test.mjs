import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { candidateIdentity, describeCandidate, verifyCandidate, waitForCandidate, CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT, RELEASE_MANIFEST,
  adoptCandidate, appBundleIdentity, findReusableCandidate, inspectPackagedApp, releaseManifest, serializeReleaseManifest } from './release-candidate.mjs';

const environment = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', VERSION: '2.1.7' };
const identity = candidateIdentity(environment);
const run = { head_sha: identity.revision, path: '.github/workflows/release.yml', repository: { full_name: environment.GITHUB_REPOSITORY }, run_attempt: 1, status: 'in_progress' };
const artifact = { id: 456, name: CANDIDATE_ARTIFACT, expired: false, workflow_run: { id: 123, head_sha: identity.revision } };
function fixture({ producer = { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion: 'success' }, candidate = artifact, source = run } = {}) {
  let time = 0;
  return { environment, now: () => time, wait: async ms => { time += ms; }, timeoutMs: 10_000,
    request: async (_method, url) => url.includes('/jobs?') ? { jobs: [producer] } : url.includes('/artifacts?') ? { artifacts: candidate ? [candidate, { ...artifact, name: CANDIDATE_IDENTITY_ARTIFACT }] : [] } : source };
}

test('wait accepts only this run and source after the packaging job succeeds', async () => {
  assert.equal((await waitForCandidate(fixture())).artifact.id, 456);
  await assert.rejects(waitForCandidate(fixture({ producer: { name: 'electron-package', id: 10, run_attempt: 1, status: 'in_progress' } })), /deadline/);
});
for (const conclusion of ['failure', 'cancelled', 'skipped']) test(`candidate producer ${conclusion} aborts immediately`, async () => {
  await assert.rejects(waitForCandidate(fixture({ producer: { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion } })), new RegExp(conclusion));
});
test('candidate absence expires and changed producer/artifact identity fails closed', async () => {
  await assert.rejects(waitForCandidate(fixture({ candidate: null })), /deadline/);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { run_attempt: 2 }, { repository: { full_name: 'other/repo' } }]) {
    await assert.rejects(waitForCandidate(fixture({ source: { ...run, ...change } })), /identity/);
  }
  await assert.rejects(waitForCandidate(fixture({ candidate: { ...artifact, workflow_run: { id: 124, head_sha: identity.revision } } })), /another/);
});
test('candidate handoff rejects wrong run, attempt, SHA and installer bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-candidate-'));
  try {
    const name = `DevRyan-${identity.version}-arm64.dmg`;
    await fs.writeFile(path.join(root, name), 'installer');
    await fs.writeFile(path.join(root, 'candidate.json'), JSON.stringify(await describeCandidate(root, identity)));
    assert.equal(await verifyCandidate(root, identity), path.join(root, name));
    for (const change of [{ runID: '124' }, { attempt: '2' }, { revision: 'b'.repeat(40) }]) await assert.rejects(verifyCandidate(root, { ...identity, ...change }), /mismatch/);
    await fs.writeFile(path.join(root, name), 'corrupted');
    await assert.rejects(verifyCandidate(root, identity), /mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('a failed-job rerun can reuse the successful producer from an earlier attempt of this exact run', async () => {
  const options = fixture({ source: { ...run, run_attempt: 2 } });
  options.environment = { ...environment, GITHUB_RUN_ATTEMPT: '2' };
  assert.equal((await waitForCandidate(options)).identity.attempt, '1');
});

test('copied successful jobs retain the actual producer attempt, including after a real rebuild', async () => {
  for (const rebuilt of [false, true]) {
    const options = fixture({ source: { ...run, run_attempt: 3 } });
    options.environment = { ...environment, GITHUB_RUN_ATTEMPT: '3' };
    const original = { name: 'electron-package', id: 10, run_attempt: 1, status: 'completed', conclusion: 'success',
      started_at: '2026-10-21T10:00:00Z', completed_at: '2026-10-21T10:05:00Z' };
    const actual = rebuilt ? { ...original, id: 20, run_attempt: 2,
      started_at: '2026-10-21T10:10:00Z', completed_at: '2026-10-21T10:15:00Z' } : original;
    const request = options.request;
    options.request = (method, url) => url.includes('/jobs?')
      ? { jobs: [...(rebuilt ? [original] : []), actual, { ...actual, id: 30, run_attempt: 3 }] }
      : request(method, url);
    assert.equal((await waitForCandidate(options)).identity.attempt, String(actual.run_attempt));
  }
});

const info = { CFBundleIdentifier: 'dev.devryan.desktop', CFBundleShortVersionString: '2.1.7', CFBundleExecutable: 'DevRyan', CFBundleName: 'DevRyan' };
const candidate = { ...identity, name: 'DevRyan-2.1.7-arm64.dmg', size: 9, sha256: 'e'.repeat(64) };
const appFacts = { bundle: appBundleIdentity(info), arch: 'arm64', signingMode: 'adhoc', runtimeManifestSha256: 'f'.repeat(64) };

test('the release manifest is deterministic and binds bytes, source, run and packaged identity', () => {
  const manifest = releaseManifest({ candidate, ...appFacts });
  assert.deepEqual(manifest, { schema: 1, version: '2.1.7', sourceSha: identity.revision, runId: '123', runAttempt: '1', name: candidate.name, size: 9,
    sha256: candidate.sha256, bundleId: 'dev.devryan.desktop', shortVersion: '2.1.7', executable: 'DevRyan', arch: 'arm64', signingMode: 'adhoc',
    runtimeManifestSha256: 'f'.repeat(64) });
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(serializeReleaseManifest(reordered), serializeReleaseManifest(releaseManifest({ candidate, ...appFacts })));
  assert.equal(serializeReleaseManifest(manifest).endsWith('\n'), true);
});

test('the manifest refuses a packaged app that is not this release', () => {
  assert.throws(() => appBundleIdentity({ CFBundleIdentifier: 'dev.devryan.desktop' }), /lacks shortVersion, executable/);
  for (const [change, message] of [[{ bundle: { ...appFacts.bundle, shortVersion: '2.1.6' } }, /does not match/], [{ bundle: { ...appFacts.bundle, executable: 'OpenChamber' } }, /executable/],
    [{ arch: 'x86_64 arm64' }, /architecture/], [{ signingMode: 'unknown' }, /signing mode/], [{ runtimeManifestSha256: 'short' }, /sha256/]]) {
    assert.throws(() => releaseManifest({ candidate, ...appFacts, ...change }), message);
  }
});

test('packaged app inspection reads Info.plist, the signature, the slices and the runtime manifest', async () => {
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-app-'));
  try {
    await fs.mkdir(path.join(app, 'Contents/Resources/revert-runtime/darwin-arm64'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json'), '{"bundle":1}\n');
    const calls = [];
    const run = async (command, args) => {
      calls.push(command);
      if (command.endsWith('plutil')) return { stdout: JSON.stringify(info), stderr: '' };
      if (command.endsWith('codesign')) return { stdout: '', stderr: 'Executable=/x\nIdentifier=dev.devryan.desktop\nSignature=adhoc\n' };
      return { stdout: 'arm64\n', stderr: '' };
    };
    const facts = await inspectPackagedApp(app, { run });
    assert.deepEqual(facts, { bundle: appFacts.bundle, signingMode: 'adhoc', arch: 'arm64',
      runtimeManifestSha256: crypto.createHash('sha256').update('{"bundle":1}\n').digest('hex') });
    assert.deepEqual(calls, ['/usr/bin/plutil', '/usr/bin/codesign', '/usr/bin/lipo']);
  } finally { await fs.rm(app, { recursive: true, force: true }); }
});

test('build reuse finds the newest retained DMG at this exact source from any run', async () => {
  const environmentWithToken = { ...environment, GITHUB_TOKEN: 't' };
  const runs = [{ id: 7, path: '.github/workflows/release.yml', head_sha: identity.revision, repository: { full_name: environment.GITHUB_REPOSITORY } },
    { id: 9, path: '.github/workflows/release.yml', head_sha: identity.revision, repository: { full_name: environment.GITHUB_REPOSITORY } },
    { id: 11, path: '.github/workflows/other.yml', head_sha: identity.revision, repository: { full_name: environment.GITHUB_REPOSITORY } }];
  const retained = run => [CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT].map(name => ({ name, expired: false, workflow_run: { id: run, head_sha: identity.revision } }));
  const client = artifacts => ({ paginate: async (url, { key }) => key === 'workflow_runs' ? runs : artifacts[url.split('/')[3]] ?? [] });
  assert.equal(await findReusableCandidate({ environment: environmentWithToken, client: client({ 7: retained(7), 9: retained(9), 11: retained(11) }) }), '9');
  assert.equal(await findReusableCandidate({ environment: environmentWithToken, client: client({ 7: retained(7), 9: retained(9).slice(0, 1) }) }), '7');
  assert.equal(await findReusableCandidate({ environment: environmentWithToken, client: client({ 9: retained(9).map(row => ({ ...row, expired: true })) }) }), '');
  assert.equal(await findReusableCandidate({ environment: environmentWithToken, client: client({ 9: retained(9).map(row => ({ ...row, workflow_run: { id: 9, head_sha: 'b'.repeat(40) } })) }) }), '');
});

test('an adopted DMG is verified against its producer and rebound to this run with its provenance', async () => {
  const producer = { ...environment, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2' };
  const build = async (bytes, manifestChange = {}) => {
    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-adopt-source-'));
    await fs.writeFile(path.join(artifacts, 'DevRyan-2.1.7-arm64.dmg'), bytes);
    const described = await describeCandidate(artifacts, candidateIdentity(producer));
    await fs.writeFile(path.join(artifacts, 'candidate.json'), JSON.stringify(described));
    await fs.writeFile(path.join(artifacts, RELEASE_MANIFEST), serializeReleaseManifest({ ...releaseManifest({ candidate: described, ...appFacts }), ...manifestChange }));
    return artifacts;
  };
  const adopt = async (artifacts, runId = '77') => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-adopt-target-'));
    try {
      return await adoptCandidate(runId, target, { environment: { ...environment, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }, download: async name => {
        const files = name === CANDIDATE_ARTIFACT ? ['DevRyan-2.1.7-arm64.dmg'] : ['candidate.json', RELEASE_MANIFEST];
        for (const file of files) await fs.copyFile(path.join(artifacts, file), path.join(target, file));
      } }).then(async adopted => ({ adopted, rebound: JSON.parse(await fs.readFile(path.join(target, 'candidate.json'), 'utf8')) }));
    } finally { await fs.rm(target, { recursive: true, force: true }); }
  };
  const good = await build('installer');
  try {
    const { adopted, rebound } = await adopt(good);
    assert.deepEqual(adopted.builtBy, { runID: '77', attempt: '2' });
    assert.equal(rebound.runID, '123');
    assert.equal(rebound.sha256, crypto.createHash('sha256').update('installer').digest('hex'));
    await assert.rejects(adopt(good, '78'), /another source, version or run/);
    await fs.writeFile(path.join(good, 'DevRyan-2.1.7-arm64.dmg'), 'tampered');
    await assert.rejects(adopt(good), /mismatch/);
  } finally { await fs.rm(good, { recursive: true, force: true }); }
  const lying = await build('installer', { sha256: 'a'.repeat(64) });
  try { await assert.rejects(adopt(lying), /does not describe/); } finally { await fs.rm(lying, { recursive: true, force: true }); }
});
