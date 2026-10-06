import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, releaseAssetName, releaseAssetDownloadUrl } from '../packages/electron/release-assets.mjs';
import { assertReleaseWritesAllowed } from './release-artifacts.mjs';
import { verifyReleaseAssets, expectedReleaseDigests } from './verify-release-assets.mjs';

const sha256 = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(message); };
const requiredSteps = ['Verify native host and prepare owned fixtures',
  'Verify unavailable Windows features on this architecture',
  'Verify pinned executable resources on this native architecture',
  'Compile architecture-specific supervisor', 'Qualify compiled supervision and file boundaries',
  'Verify native process identities and containing host jobs',
  'Verify native file identities and private filesystem ownership',
  'Qualify original Node and Bun stdio compatibility',
  'Build the pinned libsql source and execute its ABI on this native host',
  'Compile controller and writer candidates and execute their boot refusals',
  'Execute the compiled native acceptance inventory',
  'Qualify per-user NSIS installation and updater recovery'];

export function verifyWindowsQualification(run, jobs, source) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== source
    || run.path !== '.github/workflows/windows.yml' || run.head_repository?.full_name !== RELEASE_REPOSITORY
    || !['push', 'workflow_dispatch'].includes(run.event)) fail('Frozen Windows qualification run required');
  for (const arch of ['x64', 'arm64']) {
    const matches = jobs.filter(job => job.name === `Native ${arch}`);
    if (matches.length !== 1 || matches[0].conclusion !== 'success'
      || requiredSteps.some(name => matches[0].steps.filter(step => step.name === name
        && step.status === 'completed' && step.conclusion === 'success').length !== 1)) {
      fail(`Complete native and installer qualification required for ${arch}`);
    }
  }
}

export function verifyWindowsInstallerReceipt(receipt, { source, version, arch }) {
  if (receipt?.protocol !== 'devryan.windows-installer-qualification/1' || receipt.source !== source
    || receipt.version !== version || receipt.arch !== arch || receipt.status !== 'passed'
    || receipt.acceptance !== true || !sha256.test(receipt.evidenceSha256 ?? '') || !sha256.test(receipt.sourceTreeSha256 ?? '')
    || receipt.name !== releaseAssetName(`win-${arch}`, version) || !sha256.test(receipt.sha256 ?? '')
    || !Number.isSafeInteger(receipt.size) || receipt.size <= 0 || receipt.size > 8 * 1024 ** 3) {
    fail('Frozen Windows installer receipt required');
  }
  return receipt;
}

export function verifyMacosPublication(run, jobs, source) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== source
    || run.path !== '.github/workflows/release.yml' || run.head_repository?.full_name !== RELEASE_REPOSITORY
    || !['push', 'workflow_dispatch'].includes(run.event)) fail('Frozen macOS publication run required');
  for (const name of ['build-desktop-electron-macos', 'publish-bot-runtime-images', 'verify-bot-runtime-topology', 'finalize-release']) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') fail('Complete macOS publication required');
  }
  const finalize = jobs.find(job => job.name === 'finalize-release');
  for (const name of ['Verify required release assets before publish', 'Deploy and verify Supabase configuration and migrations', 'Publish release']) {
    if (finalize.steps.filter(step => step.name === name && step.status === 'completed' && step.conclusion === 'success').length !== 1) {
      fail('Published macOS release gates required');
    }
  }
}

async function readReceipt(file, { maxBytes = 4096, expectedSha256 } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.nlink !== 1 || identity.size > maxBytes) fail('Bounded packaging receipt required');
    const bytes = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== identity.size) fail('Packaging receipt changed');
    const body = bytes.subarray(0, bytesRead);
    if (expectedSha256 && createHash('sha256').update(body).digest('hex') !== expectedSha256) fail('Windows qualification evidence digest changed');
    return JSON.parse(body.toString('utf8'));
  } finally { await handle.close(); }
}

export async function appendWindowsRelease({ source, version, directory, environment = process.env, fetchImpl = fetch, verifyOnly = false }) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || version !== '2.0.2'
    || environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY || !environment.GITHUB_TOKEN
    || ![undefined, 'false'].includes(environment.RELEASE_BOT_INPUTS_ONLY)
    || !/^[1-9][0-9]*$/.test(environment.WINDOWS_QUALIFICATION_RUN ?? '')
    || !/^[1-9][0-9]*$/.test(environment.MACOS_RELEASE_RUN ?? '')
    || !['true', 'false'].includes(environment.RELEASE_DRY_RUN)) fail('Frozen Windows append identity required');
  const api = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
  const headers = { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const json = async suffix => {
    const response = await fetchImpl(api + suffix, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) fail(`GitHub verification failed (${response.status})`);
    return response.json();
  };
  const tag = `v${version}`;
  const frozenTag = async () => {
    let object = (await json(`/git/ref/tags/${tag}`)).object;
    for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha ?? '')) fail('Invalid annotated tag identity');
      object = (await json(`/git/tags/${object.sha}`)).object;
    }
    if (object?.type !== 'commit' || object.sha !== source) fail('Published tag does not match frozen source');
  };
  await frozenTag();
  for (const [runID, verify] of [[environment.WINDOWS_QUALIFICATION_RUN, verifyWindowsQualification], [environment.MACOS_RELEASE_RUN, verifyMacosPublication]]) {
    const runPath = `/actions/runs/${runID}`;
    const run = await json(runPath), jobs = await json(`${runPath}/jobs?per_page=100`);
    if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) fail('Incomplete qualification job inventory');
    verify(run, jobs.jobs, source);
  }
  if (verifyOnly) return { status: 'qualification-verified', source };
  const macReceipt = await readReceipt(path.join(directory, 'DevRyan-macos-arm64-packaging', 'macos-arm64-asset.json'));
  const macName = releaseAssetName('macos-arm64', version);
  if (macReceipt.protocol !== 'devryan.release-asset/1' || macReceipt.source !== source || macReceipt.version !== version
    || macReceipt.platform !== 'macos-arm64' || macReceipt.name !== macName || !sha256.test(macReceipt.sha256 ?? '')
    || !Number.isSafeInteger(macReceipt.size) || macReceipt.size <= 0 || macReceipt.size > 8 * 1024 ** 3) fail('Frozen macOS packaging receipt required');
  const windowsReceipts = new Map();
  for (const arch of ['x64', 'arm64']) {
    const root = path.join(directory, `DevRyan-windows-installer-${arch}`);
    const receipt = verifyWindowsInstallerReceipt(await readReceipt(path.join(root, 'qualification.json')), { source, version, arch });
    const evidence = await readReceipt(path.join(root, 'evidence.json'), { maxBytes: 4 * 1024 ** 2, expectedSha256: receipt.evidenceSha256 });
    const scenarios = ['installation', 'update-success', 'update-refusal', 'interruption', 'rollback'];
    if (evidence.protocol !== 'devryan.windows-installer-evidence/1' || evidence.status !== 'passed' || evidence.acceptance !== true
      || evidence.source !== source || evidence.version !== version || evidence.arch !== arch
      || evidence.sourceTreeSha256 !== receipt.sourceTreeSha256
      || evidence.installer?.name !== receipt.name || evidence.installer?.sha256 !== receipt.sha256 || evidence.installer?.size !== receipt.size
      || !Array.isArray(evidence.prerequisites) || evidence.prerequisites.length === 0 || evidence.prerequisites.some(row => row.status !== 'passed')
      || !Array.isArray(evidence.scenarios) || evidence.scenarios.length !== scenarios.length
      || scenarios.some(id => evidence.scenarios.filter(row => row.id === id && row.status === 'passed').length !== 1)) {
      fail('Complete Windows installer evidence required');
    }
    windowsReceipts.set(arch, receipt);
  }
  const digests = expectedReleaseDigests('desktop', version, { RELEASE_SHA256_MACOS_ARM64: macReceipt.sha256,
    RELEASE_SHA256_WIN_X64: windowsReceipts.get('x64').sha256, RELEASE_SHA256_WIN_ARM64: windowsReceipts.get('arm64').sha256 });
  const release = await json(`/releases/tags/${tag}`);
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== false || release.prerelease !== false
    || release.tag_name !== tag || release.html_url !== `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`) fail('Published macOS release required');
  const assets = async () => {
    const current = await json(`/releases/${release.id}/assets?per_page=100`);
    if (!Array.isArray(current) || current.length > 3) fail('Unexpected release asset inventory');
    return current;
  };
  let current = await assets();
  const mac = current.find(asset => asset.name === macName);
  const checkCurrent = async inventory => {
    await frozenTag();
    if (!mac || !Number.isSafeInteger(mac.id) || mac.id <= 0
      || inventory.filter(asset => asset.name === macName).length !== 1
      || inventory.find(asset => asset.name === macName)?.id !== mac.id || mac.size !== macReceipt.size) fail('macOS asset identity changed');
    const names = inventory.map(asset => asset.name);
    if (!names.includes(macName) || new Set(names).size !== names.length
      || names.some(name => !digests.has(name))) fail('Unexpected release asset inventory');
    const presentDigests = new Map(names.map(name => [name, digests.get(name)]));
    for (const asset of inventory) if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 1024 ** 3
      || asset.digest !== `sha256:${presentDigests.get(asset.name)}`) fail('Published asset digest differs from packaging');
    if (inventory.find(asset => asset.name === macName).size !== mac.size) fail('macOS asset size changed');
  };
  await checkCurrent(current);
  const macResponse = await fetchImpl(releaseAssetDownloadUrl('macos-arm64', version), { signal: AbortSignal.timeout(600000) });
  if (!macResponse.ok || !macResponse.body) fail('Published macOS download unavailable');
  const macHash = createHash('sha256'); let macBytes = 0;
  for await (const chunk of macResponse.body) {
    macBytes += chunk.length;
    if (macBytes > mac.size) fail('Published macOS download exceeds packaged size');
    macHash.update(chunk);
  }
  if (macBytes !== mac.size || macHash.digest('hex') !== digests.get(macName)) fail('Downloaded macOS digest differs from packaging');
  const held = [];
  try {
    for (const arch of ['x64', 'arm64']) {
      const root = path.join(directory, `DevRyan-windows-installer-${arch}`);
      const receipt = windowsReceipts.get(arch);
      if (receipt.sha256 !== digests.get(receipt.name)) fail('Windows packaging digest differs from qualification');
      const file = path.join(root, receipt.name), handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      held.push({ handle, receipt, file });
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== receipt.size) fail('Invalid Windows installer file');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat(), named = await fs.lstat(file);
      if (hash.digest('hex') !== receipt.sha256 || !named.isFile() || after.nlink !== 1 || before.dev !== named.dev || before.ino !== named.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('Windows installer changed during verification');
      held.at(-1).identity = after;
    }
    if (environment.RELEASE_DRY_RUN === 'true') return { status: 'dry-run-verified', source, scope: 'desktop' };
    assertReleaseWritesAllowed(environment);
    for (const { handle, receipt, identity, file } of held) {
      current = await assets(); await checkCurrent(current);
      if (current.some(asset => asset.name === receipt.name)) continue; // Retry an uncertain upload only after its exact digest matches.
      const named = await fs.lstat(file), observed = await handle.stat();
      if (!named.isFile() || observed.nlink !== 1 || identity.dev !== named.dev || identity.ino !== named.ino
        || identity.size !== observed.size || identity.mtimeMs !== observed.mtimeMs || identity.ctimeMs !== observed.ctimeMs) fail('Windows installer changed before upload');
      assertReleaseWritesAllowed(environment);
      const upload = await fetchImpl(`https://uploads.github.com/repos/${RELEASE_REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(receipt.name)}`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(receipt.size) }, redirect: 'error',
          body: handle.createReadStream({ start: 0, autoClose: false }), duplex: 'half', signal: AbortSignal.timeout(600000) });
      if (!upload.ok) fail(`Windows asset upload failed (${upload.status}); preserve the existing release and retry verification`);
      const result = await upload.json();
      const after = await handle.stat();
      if (identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs || after.nlink !== 1) fail('Windows installer changed during upload');
      if (result.name !== receipt.name || result.state !== 'uploaded' || result.size !== receipt.size
        || result.digest !== `sha256:${receipt.sha256}`) fail('Uploaded Windows asset differs from qualification');
    }
    current = await assets(); await checkCurrent(current);
    const failures = verifyReleaseAssets(current, { version, scope: 'desktop', digests });
    if (failures.length) fail('Complete desktop release allowlist failed verification');
    return { status: 'appended-and-verified', source, scope: 'desktop', macosAssetID: mac.id };
  } finally { await Promise.all(held.map(({ handle }) => handle.close())); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verifyOnly = process.argv.length === 3 && process.argv[2] === '--verify-qualification';
  if (!verifyOnly && process.argv.length !== 3) fail('Expected qualified artifact directory or --verify-qualification');
  const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  console.log(JSON.stringify(await appendWindowsRelease({ source: process.env.FROZEN_SOURCE, version,
    directory: verifyOnly ? null : path.resolve(process.argv[2]), verifyOnly })));
}
