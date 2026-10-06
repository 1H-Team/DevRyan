import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import YAML from 'yaml';
import { appendWindowsRelease, verifyWindowsQualification, verifyWindowsInstallerReceipt, verifyMacosPublication } from './append-windows-release.mjs';

const source = '1'.repeat(40), version = '2.0.2', repo = '1H-Team/DevRyan';
const bytes = name => Buffer.from(`qualified fixture ${name}`);
const digest = name => createHash('sha256').update(bytes(name)).digest('hex');
const asset = (name, id) => ({ id, name, size: bytes(name).length, digest: `sha256:${digest(name)}`, state: 'uploaded' });
const macName = 'DevRyan-2.0.2-arm64.dmg';
const nativeSteps = YAML.parse(await fs.readFile(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8')).jobs.native.steps;
const qualification = () => ({ run: { status: 'completed', conclusion: 'success', head_sha: source,
  path: '.github/workflows/windows.yml', head_repository: { full_name: repo }, event: 'push' },
jobs: ['x64', 'arm64'].map(arch => ({ name: `Native ${arch}`, conclusion: 'success', steps: [
  ...nativeSteps.filter(step => step.name).map(({ name }) => ({ name, status: 'completed', conclusion: 'success' })),
  { name: 'Qualify per-user NSIS installation and updater recovery', status: 'completed', conclusion: 'success' },
] })) });
const receipt = arch => ({ protocol: 'devryan.windows-installer-qualification/1', source, version, arch, status: 'passed',
  name: `DevRyan-${version}-win-${arch}.exe`, size: bytes(`DevRyan-${version}-win-${arch}.exe`).length, sha256: digest(`DevRyan-${version}-win-${arch}.exe`) });
const macQualification = () => ({ run: { ...qualification().run, path: '.github/workflows/release.yml' }, jobs:
  ['build-desktop-electron-macos', 'publish-bot-runtime-images', 'verify-bot-runtime-topology', 'finalize-release'].map(name => ({ name, conclusion: 'success', steps:
    name === 'finalize-release' ? ['Verify required release assets before publish', 'Deploy and verify Supabase configuration and migrations', 'Publish release']
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) : [] })) });

test('Windows append requires both complete native and installer gates on frozen source', () => {
  let q = qualification(); verifyWindowsQualification(q.run, q.jobs, source);
  for (const change of [{ head_sha: '2'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' },
    { path: '.github/workflows/windows-lpac.yml' }, { head_repository: { full_name: 'other/repo' } }, { event: 'pull_request' }]) {
    assert.throws(() => verifyWindowsQualification({ ...q.run, ...change }, q.jobs, source));
  }
  for (const stepName of ['Qualify compiled supervision and file boundaries', 'Execute the compiled native acceptance inventory',
    'Qualify per-user NSIS installation and updater recovery']) {
    q = qualification(); q.jobs[1].steps.find(step => step.name === stepName).conclusion = 'skipped';
    assert.throws(() => verifyWindowsQualification(q.run, q.jobs, source));
  }
  assert.throws(() => verifyWindowsQualification(qualification().run, qualification().jobs.slice(0, 1), source));
  const valid = receipt('x64'); assert.equal(verifyWindowsInstallerReceipt(valid, { source, version, arch: 'x64' }), valid);
  for (const change of [{ status: 'failed' }, { arch: 'arm64' }, { source: '2'.repeat(40) }, { name: macName }, { size: 0 }, { sha256: '' }]) {
    assert.throws(() => verifyWindowsInstallerReceipt({ ...valid, ...change }, { source, version, arch: 'x64' }));
  }
  const mac = macQualification(); verifyMacosPublication(mac.run, mac.jobs, source);
  mac.jobs.at(-1).steps.at(-1).conclusion = 'skipped';
  assert.throws(() => verifyMacosPublication(mac.run, mac.jobs, source), /Published macOS release gates/);
});

test('Windows append verifies downloaded macOS bytes, preserves its asset and tag, and dry runs cannot upload', async () => {
  const fixtureRoot = new URL('../.cache/test-fixtures/', import.meta.url);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(path.resolve(fixtureRoot.pathname), 'windows-append-'));
  const environment = { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: 'fixture-only', WINDOWS_QUALIFICATION_RUN: '42', MACOS_RELEASE_RUN: '41', RELEASE_DRY_RUN: 'true' };
  let assets = [asset(macName, 17)], uploads = [], macBytes = bytes(macName), tagSource = source;
  const q = qualification();
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      assert.ok(url.startsWith(`https://uploads.github.com/repos/${repo}/releases/7/assets?name=`));
      const name = new URL(url).searchParams.get('name');
      assert.ok(['DevRyan-2.0.2-win-x64.exe', 'DevRyan-2.0.2-win-arm64.exe'].includes(name));
      const data = []; for await (const chunk of options.body) data.push(chunk);
      assert.deepEqual(Buffer.concat(data), bytes(name)); uploads.push(name);
      const uploaded = asset(name, assets.length + 18); assets.push(uploaded); return Response.json(uploaded);
    }
    assert.ok(!options.method || options.method === 'GET');
    if (url.endsWith('/git/ref/tags/v2.0.2')) return Response.json({ object: { type: 'commit', sha: tagSource } });
    if (url.endsWith('/actions/runs/42')) return Response.json(q.run);
    if (url.endsWith('/actions/runs/42/jobs?per_page=100')) return Response.json({ total_count: 2, jobs: q.jobs });
    if (url.endsWith('/actions/runs/41')) return Response.json(macQualification().run);
    if (url.endsWith('/actions/runs/41/jobs?per_page=100')) return Response.json({ total_count: 4, jobs: macQualification().jobs });
    if (url.endsWith('/releases/tags/v2.0.2')) return Response.json({ id: 7, draft: false, prerelease: false,
      tag_name: 'v2.0.2', html_url: `https://github.com/${repo}/releases/tag/v2.0.2` });
    if (url.endsWith('/releases/7/assets?per_page=100')) return Response.json(assets);
    if (url === `https://github.com/${repo}/releases/download/v2.0.2/${macName}`) {
      assert.equal(options.headers?.Authorization, undefined); return new Response(macBytes);
    }
    throw Error('Unexpected request');
  };
  const append = () => appendWindowsRelease({ source, version, directory, environment, fetchImpl });
  try {
    const macRoot = path.join(directory, 'DevRyan-macos-arm64-packaging'); await fs.mkdir(macRoot);
    await fs.writeFile(path.join(macRoot, 'macos-arm64-asset.json'), JSON.stringify({ protocol: 'devryan.release-asset/1',
      source, version, platform: 'macos-arm64', name: macName, size: bytes(macName).length, sha256: digest(macName) }));
    for (const arch of ['x64', 'arm64']) {
      const root = path.join(directory, `DevRyan-windows-installer-${arch}`); await fs.mkdir(root);
      const metadata = receipt(arch); await fs.writeFile(path.join(root, 'qualification.json'), JSON.stringify(metadata));
      await fs.writeFile(path.join(root, metadata.name), bytes(metadata.name));
    }
    assert.equal((await append()).status, 'dry-run-verified'); assert.deepEqual(uploads, []);
    macBytes = Buffer.alloc(bytes(macName).length); await assert.rejects(append(), /Downloaded macOS digest/); assert.deepEqual(uploads, []);
    macBytes = bytes(macName); tagSource = '2'.repeat(40); await assert.rejects(append(), /frozen source/); assert.deepEqual(uploads, []);
    tagSource = source; assets.push(asset('unexpected.exe', 200)); await assert.rejects(append(), /Unexpected release asset/); assets.pop();
    environment.RELEASE_DRY_RUN = 'false';
    assert.equal((await append()).status, 'appended-and-verified');
    assert.deepEqual(uploads, ['DevRyan-2.0.2-win-x64.exe', 'DevRyan-2.0.2-win-arm64.exe']);
    assert.deepEqual(assets[0], asset(macName, 17)); assert.equal(tagSource, source);
    assert.equal((await append()).status, 'appended-and-verified'); assert.equal(uploads.length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Windows append workflow is manual, freezes checkouts, and keeps dry-run publication in the guarded owner', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/windows-release-append.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(workflow.env.RELEASE_DRY_RUN, '${{ inputs.dry_run }}');
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(workflow.jobs.append.needs, 'verify');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ inputs.frozen_source }}');
    assert.equal(checkout.with['persist-credentials'], false);
    for (const step of job.steps) assert.doesNotMatch(step.run ?? '', /gh release|git (?:push|tag)|npm publish|docker|supabase|fetch/);
  }
  assert.match(workflow.jobs.verify.steps.at(-1).run, /--verify-qualification/);
  const downloads = workflow.jobs.append.steps.filter(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].with['run-id'], '${{ inputs.macos_release_run }}');
  assert.equal(downloads[1].with['run-id'], '${{ inputs.windows_qualification_run }}');
  assert.equal(downloads[1].with['merge-multiple'], false);
  assert.match(workflow.jobs.append.steps.at(-1).run, /node scripts\/append-windows-release.mjs artifacts/);
});
