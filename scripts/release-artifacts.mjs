import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RELEASE_VERSION_PATTERN } from '../packages/electron/release-assets.mjs';

export const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const WEB_BUILD_OPTIONS = Object.freeze({ mode: 'production', reactScan: false });

export function assertReleaseWritesAllowed(environment = process.env) {
  if (![undefined, 'false'].includes(environment.RELEASE_DRY_RUN)) {
    throw Object.assign(new Error('Release dry runs prohibit external publication and tagging'), { code: 'release_dry_run_write_forbidden' });
  }
  assertBotInputPreparation(environment);
}

export function assertBotInputPreparation(environment = process.env, version) {
  const mode = environment.RELEASE_BOT_INPUTS_ONLY;
  if (mode === undefined || mode === 'false') return false;
  const revision = environment.GITHUB_SHA;
  const match = /^refs\/tags\/v(.+)-bot-inputs-([a-f0-9]{12})$/.exec(environment.GITHUB_REF || '');
  if (mode !== 'true' || environment.GITHUB_ACTIONS !== 'true'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision || '')
    || !match || !RELEASE_VERSION_PATTERN.test(match[1])
    || (version !== undefined && match[1] !== version) || match[2] !== revision.slice(0, 12)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY || '')
    || environment.GITHUB_WORKFLOW_REF !== `${environment.GITHUB_REPOSITORY}/.github/workflows/release.yml@${environment.GITHUB_REF}`) {
    throw Object.assign(new Error('Bot input preparation requires its immutable version/source tag and a manual release.yml run'), { code: 'bot_input_preparation_identity_invalid' });
  }
  return true;
}

export async function releaseIdentity(root, revision) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision || '')) throw new Error('Release revision required');
  return {
    revision,
    release: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version,
    lockfile: hash(await fs.readFile(path.join(root, 'bun.lock'))),
  };
}

async function inventory(directory, prefix = '') {
  const files = {};
  for (const entry of (await fs.readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(directory, relative));
    else if (entry.isFile()) files[relative] = hash(await fs.readFile(path.join(directory, relative)));
    else throw new Error(`Unsupported web artifact entry: ${relative}`);
  }
  return files;
}

export async function describeWebArtifact(directory, identity) {
  const files = await inventory(directory);
  for (const required of ['index.html', 'mini-chat.html', 'browser.html', 'sw.js', '.vite/manifest.json']) {
    if (!files[required]) throw new Error(`Missing web artifact entry: ${required}`);
  }
  return { version: 1, kind: 'web', ...identity, options: WEB_BUILD_OPTIONS, files };
}

export async function verifyWebArtifact(directory, metadata, identity) {
  const actual = await describeWebArtifact(directory, identity);
  if (metadata?.version !== actual.version || metadata.kind !== 'web'
    || metadata.revision !== actual.revision || metadata.release !== actual.release
    || metadata.lockfile !== actual.lockfile
    || JSON.stringify(metadata.options) !== JSON.stringify(actual.options)
    || JSON.stringify(metadata.files) !== JSON.stringify(actual.files)) {
    throw new Error('Web artifact identity or content mismatch');
  }
  return actual;
}

export async function stageWebArtifact({ source, metadata, identity, destination }) {
  await verifyWebArtifact(source, metadata, identity);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const staging = await fs.mkdtemp(`${destination}-staging-`);
  try {
    await fs.cp(source, staging, { recursive: true });
    await verifyWebArtifact(staging, metadata, identity);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export function verifyPreparedMetadata(metadata, identity, arch, archiveHash) {
  if (!['arm64', 'x64'].includes(arch) || metadata?.version !== 1 || metadata.kind !== 'electron-prepared'
    || metadata.arch !== arch || metadata.revision !== identity.revision
    || metadata.release !== identity.release || metadata.lockfile !== identity.lockfile
    || metadata.archiveHash !== archiveHash) throw new Error('Prepared Electron artifact mismatch');
}
