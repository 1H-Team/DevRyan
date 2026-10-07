import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { appendWindowsRelease, verifyWindowsQualification, verifyWindowsInstallerReceipt, verifyMacosPublication, readWindowsReleaseVersion } from './append-windows-release.mjs';

const source = '1'.repeat(40), version = await readWindowsReleaseVersion(), repo = '1H-Team/DevRyan';
const bytes = name => Buffer.from(`qualified fixture ${name}`);
const digest = name => createHash('sha256').update(bytes(name)).digest('hex');
const asset = (name, id) => ({ id, name, size: bytes(name).length, digest: `sha256:${digest(name)}`, state: 'uploaded' });
const macName = `DevRyan-${version}-arm64.dmg`;
const nativeSteps = YAML.parse(await fs.readFile(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8')).jobs.native.steps;
const qualification = () => ({ run: { status: 'completed', conclusion: 'success', head_sha: source,
  path: '.github/workflows/windows.yml', head_repository: { full_name: repo }, event: 'push' },
jobs: ['x64', 'arm64'].map(arch => ({ name: `Native ${arch}`, conclusion: 'success', steps: [
  ...new Set([...nativeSteps.filter(step => step.name).map(({ name }) => name),
    'Qualify per-user NSIS installation and updater recovery'])].map(name => ({ name, status: 'completed', conclusion: 'success' })),
})) });
const installerEvidence = arch => ({ protocol: 'devryan.windows-installer-evidence/1', source, version, arch, status: 'passed', acceptance: true,
  sourceTreeSha256: 'a'.repeat(64), installer: { name: `DevRyan-${version}-win-${arch}.exe`,
    size: bytes(`DevRyan-${version}-win-${arch}.exe`).length, sha256: digest(`DevRyan-${version}-win-${arch}.exe`) },
  prerequisites: [{ id: 'native', status: 'passed' }],
  scenarios: ['installation', 'update-success', 'update-refusal', 'interruption', 'rollback'].map(id => ({ id, status: 'passed' })) });
const receipt = arch => ({ protocol: 'devryan.windows-installer-qualification/1', source, version, arch, status: 'passed',
  acceptance: true, sourceTreeSha256: 'a'.repeat(64), evidenceSha256: createHash('sha256').update(JSON.stringify(installerEvidence(arch))).digest('hex'),
  name: `DevRyan-${version}-win-${arch}.exe`, size: bytes(`DevRyan-${version}-win-${arch}.exe`).length, sha256: digest(`DevRyan-${version}-win-${arch}.exe`) });
const macQualification = () => ({ run: { ...qualification().run, path: '.github/workflows/release.yml' }, jobs:
  ['build-desktop-electron-macos (aarch64-apple-darwin, arm64, darwin-aarch64)', 'publish-bot-runtime-images', 'verify-bot-runtime-topology', 'finalize-release'].map(name => ({ name, conclusion: 'success', steps:
    name === 'finalize-release' ? ['Verify required release assets before publish', 'Deploy and verify Supabase configuration and migrations', 'Publish release']
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) : [] })) });

test('Windows release version follows matching package manifests and rejects invalid or divergent versions', async () => {
  const fixtureRoot = new URL('../.cache/test-fixtures/', import.meta.url);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(fileURLToPath(fixtureRoot), 'windows-release-version-'));
  try {
    await fs.mkdir(path.join(root, 'packages/electron'), { recursive: true });
    for (const [rootVersion, electronVersion, accepted] of [['3.4.5', '3.4.5', true],
      ['3.4.5', '3.4.6', false], ['3.4.5-beta', '3.4.5-beta', false], [null, null, false]]) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: rootVersion }));
      await fs.writeFile(path.join(root, 'packages/electron/package.json'), JSON.stringify({ version: electronVersion }));
      if (accepted) {
        assert.equal(await readWindowsReleaseVersion(root), rootVersion);
        const command = `import {readWindowsReleaseVersion} from ${JSON.stringify(new URL('./append-windows-release.mjs', import.meta.url).href)}; console.log(await readWindowsReleaseVersion());`;
        assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', command], { cwd: root, encoding: 'utf8' }).trim(), version);
      }
      else await assert.rejects(readWindowsReleaseVersion(root), /Matching root and Electron release versions required/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS publication requires the unique successful ARM64 matrix job returned by GitHub', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.jobs['build-desktop-electron-macos'].strategy.matrix.include,
    [{ target: 'aarch64-apple-darwin', arch: 'arm64', platform: 'darwin-aarch64' }]);
  const mac = macQualification();
  verifyMacosPublication(mac.run, mac.jobs, source);
  for (const name of ['build-desktop-electron-macos',
    'build-desktop-electron-macos (x86_64-apple-darwin, x64, darwin-x86_64)',
    mac.jobs[0].name + ' extra']) {
    assert.throws(() => verifyMacosPublication(mac.run, [{ ...mac.jobs[0], name }, ...mac.jobs.slice(1)], source),
      /Complete macOS publication required/);
  }
  assert.throws(() => verifyMacosPublication(mac.run, [...mac.jobs, mac.jobs[0]], source), /Complete macOS publication required/);
  assert.throws(() => verifyMacosPublication(mac.run, [{ ...mac.jobs[0], conclusion: 'failure' }, ...mac.jobs.slice(1)], source),
    /Complete macOS publication required/);
});

test('Windows append requires both complete native and installer gates on frozen source', () => {
  let q = qualification(); verifyWindowsQualification(q.run, q.jobs, source);
  for (const change of [{ head_sha: '2'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' },
    { path: '.github/workflows/windows-lpac.yml' }, { head_repository: { full_name: 'other/repo' } }, { event: 'pull_request' }]) {
    assert.throws(() => verifyWindowsQualification({ ...q.run, ...change }, q.jobs, source));
  }
  for (const stepName of ['Qualify compiled supervision and file boundaries', 'Execute the compiled native acceptance inventory',
    'Qualify original Node and Bun stdio compatibility', 'Qualify per-user NSIS installation and updater recovery']) {
    q = qualification(); q.jobs[1].steps.find(step => step.name === stepName).conclusion = 'skipped';
    assert.throws(() => verifyWindowsQualification(q.run, q.jobs, source));
  }
  assert.throws(() => verifyWindowsQualification(qualification().run, qualification().jobs.slice(0, 1), source));
  const valid = receipt('x64'); assert.equal(verifyWindowsInstallerReceipt(valid, { source, version, arch: 'x64' }), valid);
  for (const change of [{ status: 'failed' }, { arch: 'arm64' }, { source: '2'.repeat(40) }, { name: macName }, { size: 0 }, { sha256: '' }]) {
    assert.throws(() => verifyWindowsInstallerReceipt({ ...valid, ...change }, { source, version, arch: 'x64' }));
  }
  assert.throws(() => verifyWindowsInstallerReceipt({ ...valid, acceptance: false }, { source, version, arch: 'x64' }), /Frozen Windows installer receipt/);
  const mac = macQualification(); verifyMacosPublication(mac.run, mac.jobs, source);
  mac.jobs.at(-1).steps.at(-1).conclusion = 'skipped';
  assert.throws(() => verifyMacosPublication(mac.run, mac.jobs, source), /Published macOS release gates/);
});

test('Windows append verifies downloaded macOS bytes, preserves its asset and tag, and dry runs cannot upload', async () => {
  const fixtureRoot = new URL('../.cache/test-fixtures/', import.meta.url);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fileURLToPath(fixtureRoot), 'windows-append-'));
  const environment = { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: 'fixture-only', WINDOWS_QUALIFICATION_RUN: '42', MACOS_RELEASE_RUN: '41', RELEASE_DRY_RUN: 'true' };
  let assets = [asset(macName, 17)], uploads = [], macBytes = bytes(macName), tagSource = source;
  const q = qualification();
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      assert.ok(url.startsWith(`https://uploads.github.com/repos/${repo}/releases/7/assets?name=`));
      const name = new URL(url).searchParams.get('name');
      assert.ok([`DevRyan-${version}-win-x64.exe`, `DevRyan-${version}-win-arm64.exe`].includes(name));
      const data = []; for await (const chunk of options.body) data.push(chunk);
      assert.deepEqual(Buffer.concat(data), bytes(name)); uploads.push(name);
      const uploaded = asset(name, assets.length + 18); assets.push(uploaded); return Response.json(uploaded);
    }
    assert.ok(!options.method || options.method === 'GET');
    if (url.endsWith(`/git/ref/tags/v${version}`)) return Response.json({ object: { type: 'commit', sha: tagSource } });
    if (url.endsWith('/actions/runs/42')) return Response.json(q.run);
    if (url.endsWith('/actions/runs/42/jobs?per_page=100')) return Response.json({ total_count: 2, jobs: q.jobs });
    if (url.endsWith('/actions/runs/41')) return Response.json(macQualification().run);
    if (url.endsWith('/actions/runs/41/jobs?per_page=100')) return Response.json({ total_count: 4, jobs: macQualification().jobs });
    if (url.endsWith(`/releases/tags/v${version}`)) return Response.json({ id: 7, draft: false, prerelease: false,
      tag_name: `v${version}`, html_url: `https://github.com/${repo}/releases/tag/v${version}` });
    if (url.endsWith('/releases/7/assets?per_page=100')) return Response.json(assets);
    if (url === `https://github.com/${repo}/releases/download/v${version}/${macName}`) {
      assert.equal(options.headers?.Authorization, undefined); return new Response(macBytes);
    }
    throw Error('Unexpected request');
  };
  const append = () => appendWindowsRelease({ source, version, directory, environment, fetchImpl });
  try {
    for (const invalidVersion of ['3.4.5-beta', null]) {
      await assert.rejects(appendWindowsRelease({ source, version: invalidVersion, directory, environment, fetchImpl }),
        /Frozen Windows append identity required/);
    }
    await assert.rejects(appendWindowsRelease({ source, version: `${Number(version.split('.')[0]) + 1}.0.0`, directory, environment, fetchImpl }),
      /Frozen Windows append package version required/);
    const macRoot = path.join(directory, 'DevRyan-macos-arm64-packaging'); await fs.mkdir(macRoot);
    await fs.writeFile(path.join(macRoot, 'macos-arm64-asset.json'), JSON.stringify({ protocol: 'devryan.release-asset/1',
      source, version, platform: 'macos-arm64', name: macName, size: bytes(macName).length, sha256: digest(macName) }));
    for (const arch of ['x64', 'arm64']) {
      const root = path.join(directory, `DevRyan-windows-installer-${arch}`); await fs.mkdir(root);
      const metadata = receipt(arch); await fs.writeFile(path.join(root, 'qualification.json'), JSON.stringify(metadata));
      await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(installerEvidence(arch)));
      await fs.writeFile(path.join(root, metadata.name), bytes(metadata.name));
    }
    assert.equal((await append()).status, 'dry-run-verified'); assert.deepEqual(uploads, []);
    const evidenceFile = path.join(directory, 'DevRyan-windows-installer-x64', 'evidence.json');
    const receiptFile = path.join(directory, 'DevRyan-windows-installer-x64', 'qualification.json');
    const incomplete = installerEvidence('x64'); incomplete.scenarios.at(-1).status = 'blocked';
    const incompleteBytes = JSON.stringify(incomplete);
    await fs.writeFile(evidenceFile, incompleteBytes);
    await assert.rejects(append(), /evidence digest changed/); assert.deepEqual(uploads, []);
    await fs.writeFile(receiptFile, JSON.stringify({ ...receipt('x64'), evidenceSha256: createHash('sha256').update(incompleteBytes).digest('hex') }));
    await assert.rejects(append(), /Complete Windows installer evidence/); assert.deepEqual(uploads, []);
    await fs.writeFile(evidenceFile, JSON.stringify(installerEvidence('x64')));
    await fs.writeFile(receiptFile, JSON.stringify(receipt('x64')));
    macBytes = Buffer.alloc(bytes(macName).length); await assert.rejects(append(), /Downloaded macOS digest/); assert.deepEqual(uploads, []);
    macBytes = bytes(macName); tagSource = '2'.repeat(40); await assert.rejects(append(), /frozen source/); assert.deepEqual(uploads, []);
    tagSource = source; assets.push(asset('unexpected.exe', 200)); await assert.rejects(append(), /Unexpected release asset/); assets.pop();
    environment.RELEASE_DRY_RUN = 'false';
    assert.equal((await append()).status, 'appended-and-verified');
    assert.deepEqual(uploads, [`DevRyan-${version}-win-x64.exe`, `DevRyan-${version}-win-arm64.exe`]);
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
