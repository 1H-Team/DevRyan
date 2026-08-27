#!/usr/bin/env node

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  BOT_RUNTIME_IMAGE_KEYS,
  BOT_RUNTIME_RELEASE_MANIFEST_VERSION,
  BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
  validateBotRuntimeReleaseSourceManifest,
} from '../packages/electron/bot-runtime-manifest.mjs';

const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export class BotRuntimeImageVerificationError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'BotRuntimeImageVerificationError';
    this.code = code;
  }
}

const fail = (message, code, options) => {
  throw new BotRuntimeImageVerificationError(message, code, options);
};

const defaultRegistryProbe = (reference, { environment }) => {
  const result = spawnSync('docker', ['manifest', 'inspect', reference], {
    env: environment,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
};

const registryFailureKind = (result) => {
  const output = `${result?.stderr || ''}\n${result?.stdout || ''}`;
  if (/unauthorized|authentication required|access denied|denied:|forbidden|insufficient[_ ]scope/i.test(output)) {
    return 'not anonymously accessible';
  }
  if (/manifest unknown|name unknown|not found|no such manifest/i.test(output)) {
    return 'missing';
  }
  return 'unreachable';
};

export async function verifyAnonymousBotRuntimeImageAccess(rawManifest, {
  probe = defaultRegistryProbe,
  fsPromises = fs,
  environment = process.env,
} = {}) {
  if (typeof probe !== 'function' || !environment || typeof environment !== 'object') {
    fail('Anonymous Bot runtime image probe is invalid', 'bot_runtime_anonymous_probe_invalid');
  }
  const manifest = verifyBotRuntimeImagesManifest(rawManifest);
  const dockerConfig = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-registry-'));
  const anonymousEnvironment = {
    ...environment,
    DOCKER_CONFIG: dockerConfig,
  };
  delete anonymousEnvironment.DOCKER_AUTH_CONFIG;
  delete anonymousEnvironment.REGISTRY_AUTH_FILE;
  try {
    for (const key of BOT_RUNTIME_IMAGE_KEYS) {
      const image = manifest.images[key];
      const references = [
        `${image.repository}@${image.indexDigest}`,
        ...BOT_RUNTIME_RELEASE_PLATFORM_KEYS.map(
          (platform) => `${image.repository}@${image.platforms[platform].digest}`,
        ),
      ];
      for (const reference of references) {
        const result = await probe(reference, { environment: anonymousEnvironment });
        if (result?.exitCode !== 0) {
          fail(
            `Bot runtime image ${key} is ${registryFailureKind(result)}`,
            'bot_runtime_anonymous_access_failed',
          );
        }
      }
    }
    return manifest;
  } finally {
    await fsPromises.rm(dockerConfig, { recursive: true, force: true }).catch(() => undefined);
  }
}

const parseExpectedString = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 255 || value !== value.trim()) {
    fail(`${name} is invalid`, 'bot_runtime_release_expectation_invalid');
  }
  return value;
};

const validateExpectedMetadata = (manifest, {
  expectedReleaseId,
  expectedRevision,
  expectedRepositoryPrefix,
} = {}) => {
  const releaseId = parseExpectedString(expectedReleaseId, 'Expected release identifier');
  const revision = parseExpectedString(expectedRevision, 'Expected source revision');
  const repositoryPrefix = parseExpectedString(
    expectedRepositoryPrefix,
    'Expected repository prefix',
  );
  if (releaseId !== undefined && manifest.releaseId !== releaseId) {
    fail('Bot runtime image manifest release does not match the app release', 'bot_runtime_release_mismatch');
  }
  if (revision !== undefined && manifest.sourceRevision !== revision) {
    fail('Bot runtime image manifest revision does not match the source revision', 'bot_runtime_revision_mismatch');
  }
  if (repositoryPrefix !== undefined) {
    const prefix = `${repositoryPrefix}/`;
    if (Object.values(manifest.images).some((image) => !image.repository.startsWith(prefix))) {
      fail('Bot runtime image repository does not match the release repository', 'bot_runtime_repository_mismatch');
    }
  }
  return manifest;
};

export function verifyBotRuntimeImagesManifest(raw, expectations = {}) {
  let manifest;
  try {
    manifest = validateBotRuntimeReleaseSourceManifest(raw);
  } catch (error) {
    if (error instanceof BotRuntimeImageVerificationError) throw error;
    fail('Bot runtime image manifest is invalid', error?.code || 'bot_runtime_release_manifest_invalid', {
      cause: error,
    });
  }
  return validateExpectedMetadata(manifest, expectations);
}

const parseManifestBytes = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_MANIFEST_BYTES) {
    fail('Bot runtime image manifest has an invalid size', 'bot_runtime_release_manifest_invalid');
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('Bot runtime image manifest is not valid JSON', 'bot_runtime_release_manifest_invalid', {
      cause: error,
    });
  }
};

const readBoundedFile = async (sourcePath, fsPromises = fs) => {
  const resolved = path.resolve(sourcePath);
  let handle;
  try {
    const stat = await fsPromises.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1
      || stat.size > MAXIMUM_MANIFEST_BYTES) {
      fail('Bot runtime image manifest source must be a bounded regular file', 'bot_runtime_release_source_invalid');
    }
    handle = await fsPromises.open(
      resolved,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== stat.size) {
      fail('Bot runtime image manifest source changed while it was read', 'bot_runtime_release_source_invalid');
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof BotRuntimeImageVerificationError) throw error;
    fail('Bot runtime image manifest source cannot be read', 'bot_runtime_release_source_invalid', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const readBoundedResponse = async (response) => {
  if (!response?.ok || !response.body || typeof response.body.getReader !== 'function') {
    fail(
      `Bot runtime image manifest download failed (${response?.status || 'unknown'})`,
      'bot_runtime_release_download_failed',
    );
  }
  let finalUrl;
  try {
    finalUrl = new URL(response.url);
  } catch {
    fail('Bot runtime image manifest download returned an invalid URL', 'bot_runtime_release_download_failed');
  }
  if (finalUrl.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    fail('Bot runtime image manifest download left the allowed GitHub hosts', 'bot_runtime_release_download_failed');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAXIMUM_MANIFEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('Bot runtime image manifest download is too large', 'bot_runtime_release_download_failed');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
};

const downloadManifest = async (sourceUrl, {
  fetchImpl = globalThis.fetch,
  token,
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    fail('Bot runtime image manifest download is unavailable', 'bot_runtime_release_download_failed');
  }
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    fail('Bot runtime image manifest URL is invalid', 'bot_runtime_release_source_invalid');
  }
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
    || url.username || url.password || url.hash) {
    fail('Bot runtime image manifest URL is not an allowed GitHub URL', 'bot_runtime_release_source_invalid');
  }
  const headers = { accept: 'application/octet-stream' };
  if (typeof token === 'string' && token.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const response = await fetchImpl(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  return readBoundedResponse(response);
};

const fsyncDirectory = async (directory, fsPromises = fs) => {
  let handle;
  try {
    handle = await fsPromises.open(directory, 'r');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const atomicWritePublicManifest = async (destinationPath, bytes, fsPromises = fs) => {
  const destination = path.resolve(destinationPath);
  const directory = path.dirname(destination);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  await fsPromises.mkdir(directory, { recursive: true });
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, destination);
    await fsyncDirectory(directory, fsPromises);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof BotRuntimeImageVerificationError) throw error;
    fail('Bot runtime image manifest cannot be staged', 'bot_runtime_release_stage_failed', {
      cause: error,
    });
  }
  return destination;
};

export async function readAndVerifyBotRuntimeImagesManifest({
  manifestPath,
  fsPromises = fs,
  ...expectations
} = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    fail('Bot runtime image manifest path is required', 'bot_runtime_release_source_invalid');
  }
  const raw = parseManifestBytes(await readBoundedFile(manifestPath, fsPromises));
  return verifyBotRuntimeImagesManifest(raw, expectations);
}

export async function stageVerifiedBotRuntimeImagesManifest({
  sourcePath,
  sourceUrl,
  destinationPath,
  token,
  fetchImpl = globalThis.fetch,
  fsPromises = fs,
  ...expectations
} = {}) {
  if (Boolean(sourcePath) === Boolean(sourceUrl) || typeof destinationPath !== 'string'
    || !destinationPath.trim()) {
    fail('Exactly one Bot runtime manifest source and a destination are required', 'bot_runtime_release_source_invalid');
  }
  const bytes = sourcePath
    ? await readBoundedFile(sourcePath, fsPromises)
    : await downloadManifest(sourceUrl, { fetchImpl, token });
  const manifest = verifyBotRuntimeImagesManifest(parseManifestBytes(bytes), expectations);
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await atomicWritePublicManifest(destinationPath, serialized, fsPromises);
  return manifest;
}

const parseArguments = (argv) => {
  const values = { checkAnonymous: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check-anonymous') {
      values.checkAnonymous = true;
      continue;
    }
    if (!['--manifest', '--version', '--revision', '--repository-prefix'].includes(argument)) {
      fail(`Unknown argument: ${argument}`, 'bot_runtime_release_cli_invalid');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      fail(`Missing value for ${argument}`, 'bot_runtime_release_cli_invalid');
    }
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.manifest) {
    fail('Usage: verify-bot-runtime-images.mjs --manifest <path> [--version <version>] [--revision <sha>] [--repository-prefix <registry/path>] [--check-anonymous]', 'bot_runtime_release_cli_invalid');
  }
  return values;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = await readAndVerifyBotRuntimeImagesManifest({
    manifestPath: args.manifest,
    expectedReleaseId: args.version,
    expectedRevision: args.revision,
    expectedRepositoryPrefix: args['repository-prefix'],
  });
  if (args.checkAnonymous) await verifyAnonymousBotRuntimeImageAccess(manifest);
  console.log(
    `[bots] verified runtime image manifest v${BOT_RUNTIME_RELEASE_MANIFEST_VERSION} for ${manifest.releaseId} (${manifest.sourceRevision})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[bots] runtime image manifest verification failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
