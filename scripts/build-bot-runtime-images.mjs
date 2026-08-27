#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BOT_RUNTIME_IMAGE_KEYS,
  BOT_RUNTIME_RELEASE_MANIFEST_VERSION,
  BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
} from '../packages/electron/bot-runtime-manifest.mjs';
import { verifyBotRuntimeImagesManifest } from './verify-bot-runtime-images.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_PREFIX_PATTERN = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
]);
const SBOM_PREDICATE = 'https://spdx.dev/Document';
const PROVENANCE_PREDICATE_PREFIX = 'https://slsa.dev/provenance/';

export const BOT_RUNTIME_IMAGE_DEFINITIONS = Object.freeze({
  supervisor: Object.freeze({
    name: 'devryan-bot-supervisor',
    dockerfile: 'packages/bot-supervisor/Dockerfile',
    packageJson: 'packages/bot-supervisor/package.json',
  }),
  'engine-proxy': Object.freeze({
    name: 'devryan-bot-engine-proxy',
    dockerfile: 'packages/bot-engine-proxy/Dockerfile',
    packageJson: 'packages/bot-engine-proxy/package.json',
  }),
  egress: Object.freeze({
    name: 'devryan-bot-egress',
    dockerfile: 'packages/bot-egress/Dockerfile',
    packageJson: 'packages/bot-egress/package.json',
  }),
  indexer: Object.freeze({
    name: 'devryan-bot-indexer',
    dockerfile: 'packages/bot-indexer/Dockerfile',
    packageJson: 'packages/bot-indexer/package.json',
  }),
  opencode: Object.freeze({
    name: 'devryan-bot-opencode',
    dockerfile: 'packages/bots-runtime/docker/opencode/Dockerfile',
    packageJson: 'packages/bots-runtime/package.json',
  }),
  computer: Object.freeze({
    name: 'devryan-bot-computer',
    dockerfile: 'packages/bot-computer/Dockerfile',
    packageJson: 'packages/bot-computer/package.json',
  }),
});

export class BotRuntimeImageBuildError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'BotRuntimeImageBuildError';
    this.code = code;
  }
}

const fail = (message, code, options) => {
  throw new BotRuntimeImageBuildError(message, code, options);
};

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const parseJson = (bytes, description) => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    fail(`${description} is not valid JSON`, 'bot_runtime_image_metadata_invalid', { cause: error });
  }
};

const requireDigest = (value, description) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${description} is not an immutable SHA-256 digest`, 'bot_runtime_image_digest_invalid');
  }
  return value;
};

const validateBuildIdentity = ({ version, revision, repositoryPrefix }) => {
  if (typeof version !== 'string' || version.length > 120 || !RELEASE_PATTERN.test(version)
    || typeof revision !== 'string' || !REVISION_PATTERN.test(revision)
    || typeof repositoryPrefix !== 'string'
    || repositoryPrefix.length > 255
    || repositoryPrefix !== repositoryPrefix.toLowerCase()
    || !REPOSITORY_PREFIX_PATTERN.test(repositoryPrefix)) {
    fail('Bot runtime image release identity is invalid', 'bot_runtime_image_build_input_invalid');
  }
  return { version, revision, repositoryPrefix };
};

export async function readBotRuntimeReleaseMetadata({
  root = repositoryRoot,
  version,
  fsPromises = fs,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !RELEASE_PATTERN.test(version || '')) {
    fail('Bot runtime release metadata input is invalid', 'bot_runtime_image_build_input_invalid');
  }
  const packageVersions = {};
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    const definition = BOT_RUNTIME_IMAGE_DEFINITIONS[key];
    let packageJson;
    try {
      packageJson = JSON.parse(await fsPromises.readFile(path.join(root, definition.packageJson), 'utf8'));
    } catch (error) {
      fail(`Cannot read ${definition.packageJson}`, 'bot_runtime_image_source_invalid', { cause: error });
    }
    if (packageJson.version !== version) {
      fail(
        `${definition.packageJson} version does not match ${version}`,
        'bot_runtime_image_version_mismatch',
      );
    }
    packageVersions[key] = packageJson.version;
  }

  const [openCodeDockerfile, compatibilitySource, pluginBytes] = await Promise.all([
    fsPromises.readFile(
      path.join(root, BOT_RUNTIME_IMAGE_DEFINITIONS.opencode.dockerfile),
      'utf8',
    ),
    fsPromises.readFile(
      path.join(root, 'packages/web/server/lib/multi-user/auth-compat.js'),
      'utf8',
    ),
    fsPromises.readFile(
      path.join(root, 'packages/bots-runtime/opencode/devryan-bot-tools.mjs'),
    ),
  ]).catch((error) => {
    fail('Bot runtime release source metadata cannot be read', 'bot_runtime_image_source_invalid', {
      cause: error,
    });
  });
  const openCodeMatch = openCodeDockerfile.match(
    /opencode-ai@(\d+\.\d+\.\d+)\s+@opencode-ai\/plugin@(\d+\.\d+\.\d+)/,
  );
  const schemaMatch = compatibilitySource.match(
    /export const PRODUCTION_BOTS_MIGRATION = '(\d{14})';/,
  );
  if (!openCodeMatch || openCodeMatch[1] !== openCodeMatch[2] || !schemaMatch) {
    fail('Bot runtime release source metadata is inconsistent', 'bot_runtime_image_source_invalid');
  }
  return Object.freeze({
    openCodeVersion: openCodeMatch[1],
    schemaVersion: schemaMatch[1],
    pluginHash: sha256(pluginBytes),
    packageVersions: Object.freeze(packageVersions),
  });
}

export function createBotRuntimeImageBuildPlan({
  version,
  revision,
  repositoryPrefix,
  root = repositoryRoot,
  metadataDirectory = '<build-metadata>',
} = {}) {
  validateBuildIdentity({ version, revision, repositoryPrefix });
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof metadataDirectory !== 'string' || !metadataDirectory) {
    fail('Bot runtime image build paths are invalid', 'bot_runtime_image_build_input_invalid');
  }
  const platforms = BOT_RUNTIME_RELEASE_PLATFORM_KEYS.join(',');
  const shortRevision = revision.slice(0, 12);
  const builds = BOT_RUNTIME_IMAGE_KEYS.map((key) => {
    const definition = BOT_RUNTIME_IMAGE_DEFINITIONS[key];
    const repository = `${repositoryPrefix}/${definition.name}`;
    const tags = Object.freeze([
      `${repository}:${version}`,
      `${repository}:sha-${shortRevision}`,
    ]);
    const metadataPath = path.join(metadataDirectory, `${key}.metadata.json`);
    const args = [
      'buildx',
      'build',
      '--file',
      definition.dockerfile,
      '--platform',
      platforms,
      '--tag',
      tags[0],
      '--tag',
      tags[1],
      '--label',
      `org.opencontainers.image.source=https://github.com/${repositoryPrefix.split('/').at(-1)}/DevRyan`,
      '--label',
      `org.opencontainers.image.revision=${revision}`,
      '--label',
      `org.opencontainers.image.version=${version}`,
      '--provenance=mode=max',
      '--sbom=true',
      '--metadata-file',
      metadataPath,
      '--push',
      '.',
    ];
    return Object.freeze({
      key,
      name: definition.name,
      repository,
      tags,
      metadataPath,
      command: Object.freeze({ file: 'docker', args: Object.freeze(args) }),
    });
  });
  return Object.freeze({
    version,
    revision,
    repositoryPrefix,
    platforms: BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
    builds: Object.freeze(builds),
  });
}

const descriptorPlatformKey = (descriptor) => {
  const osName = descriptor?.platform?.os;
  const architecture = descriptor?.platform?.architecture;
  return typeof osName === 'string' && typeof architecture === 'string'
    ? `${osName}/${architecture}`
    : null;
};

export function collectBotRuntimeImageMetadata({
  repository,
  indexDigest,
  indexDocument,
  attestationDocuments,
} = {}) {
  requireDigest(indexDigest, 'Bot runtime image index');
  if (typeof repository !== 'string' || !REPOSITORY_PREFIX_PATTERN.test(repository)
    || !indexDocument || !INDEX_MEDIA_TYPES.has(indexDocument.mediaType)
    || !Array.isArray(indexDocument.manifests)
    || !(attestationDocuments instanceof Map)) {
    fail('Bot runtime image index is invalid', 'bot_runtime_image_metadata_invalid');
  }
  const platforms = {};
  for (const platformKey of BOT_RUNTIME_RELEASE_PLATFORM_KEYS) {
    const descriptors = indexDocument.manifests.filter(
      (descriptor) => descriptorPlatformKey(descriptor) === platformKey,
    );
    if (descriptors.length !== 1) {
      fail(`Bot runtime image index must contain exactly one ${platformKey} image`, 'bot_runtime_image_metadata_invalid');
    }
    const digest = requireDigest(descriptors[0].digest, `${platformKey} image`);
    const attestationDescriptors = indexDocument.manifests.filter((descriptor) => (
      descriptor?.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
      && descriptor.annotations['vnd.docker.reference.digest'] === digest
    ));
    if (attestationDescriptors.length !== 1) {
      fail(`Bot runtime image index must contain attestations for ${platformKey}`, 'bot_runtime_image_attestation_missing');
    }
    const attestationDigest = requireDigest(
      attestationDescriptors[0].digest,
      `${platformKey} attestation manifest`,
    );
    const attestation = attestationDocuments.get(attestationDigest);
    if (!attestation || !Array.isArray(attestation.layers)) {
      fail(`Bot runtime image attestations for ${platformKey} are invalid`, 'bot_runtime_image_attestation_missing');
    }
    const sbomLayers = attestation.layers.filter(
      (layer) => layer?.annotations?.['in-toto.io/predicate-type'] === SBOM_PREDICATE,
    );
    const provenanceLayers = attestation.layers.filter((layer) => (
      typeof layer?.annotations?.['in-toto.io/predicate-type'] === 'string'
      && layer.annotations['in-toto.io/predicate-type'].startsWith(PROVENANCE_PREDICATE_PREFIX)
    ));
    if (sbomLayers.length !== 1 || provenanceLayers.length !== 1) {
      fail(`Bot runtime image attestations for ${platformKey} are incomplete`, 'bot_runtime_image_attestation_missing');
    }
    platforms[platformKey] = {
      digest,
      sbomDigest: requireDigest(sbomLayers[0].digest, `${platformKey} SBOM`),
      provenanceDigest: requireDigest(
        provenanceLayers[0].digest,
        `${platformKey} provenance`,
      ),
    };
  }
  return Object.freeze({ repository, indexDigest, platforms: Object.freeze(platforms) });
}

const defaultCommandRunner = Object.freeze({
  run(file, args, options = {}) {
    const result = spawnSync(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      fail(`${file} failed with exit code ${result.status}`, 'bot_runtime_image_command_failed');
    }
  },
  capture(file, args, options = {}) {
    const result = spawnSync(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      fail(`${file} failed with exit code ${result.status}`, 'bot_runtime_image_command_failed');
    }
    return Buffer.from(result.stdout || []);
  },
});

const loadAttestationDocuments = (runner, repository, indexDocument, options) => {
  const digests = new Set(indexDocument.manifests
    .filter((descriptor) => descriptor?.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest')
    .map((descriptor) => requireDigest(descriptor.digest, 'Bot runtime attestation')));
  return new Map([...digests].map((digest) => [
    digest,
    parseJson(
      runner.capture('docker', [
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${repository}@${digest}`,
      ], options),
      'Bot runtime attestation manifest',
    ),
  ]));
};

const atomicWriteManifest = async (outputPath, manifest, fsPromises = fs) => {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  const nonce = crypto.randomBytes(8).toString('hex');
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${nonce}.tmp`);
  let handle;
  await fsPromises.mkdir(directory, { recursive: true });
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o644);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporary, resolved);
    const directoryHandle = await fsPromises.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof BotRuntimeImageBuildError) throw error;
    fail('Bot runtime release manifest cannot be written', 'bot_runtime_image_manifest_write_failed', {
      cause: error,
    });
  }
  return resolved;
};

export async function buildBotRuntimeImages({
  version,
  revision,
  repositoryPrefix,
  outputPath,
  root = repositoryRoot,
  runner = defaultCommandRunner,
  fsPromises = fs,
  environment = process.env,
} = {}) {
  validateBuildIdentity({ version, revision, repositoryPrefix });
  const expectedFilename = `DevRyan-bot-runtime-images-${version}.json`;
  if (typeof outputPath !== 'string' || path.basename(outputPath) !== expectedFilename
    || typeof runner?.run !== 'function' || typeof runner?.capture !== 'function'
    || !environment || typeof environment !== 'object') {
    fail('Bot runtime image build output is invalid', 'bot_runtime_image_build_input_invalid');
  }
  if (environment.GITHUB_ACTIONS !== 'true'
    || typeof environment.ACTIONS_ID_TOKEN_REQUEST_URL !== 'string'
    || !environment.ACTIONS_ID_TOKEN_REQUEST_URL
    || typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string'
    || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    fail('Bot runtime image publication requires GitHub OIDC', 'bot_runtime_image_oidc_required');
  }
  const releaseMetadata = await readBotRuntimeReleaseMetadata({ root, version, fsPromises });
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-images-'));
  const commandOptions = {
    cwd: root,
    env: {
      ...environment,
      BUILDX_METADATA_PROVENANCE: 'max',
      BUILDX_METADATA_WARNINGS: '1',
    },
  };
  try {
    runner.capture('docker', ['buildx', 'version'], commandOptions);
    runner.capture('cosign', ['version'], commandOptions);
    const plan = createBotRuntimeImageBuildPlan({
      version,
      revision,
      repositoryPrefix,
      root,
      metadataDirectory: temporaryDirectory,
    });
    const images = {};
    for (const build of plan.builds) {
      runner.run(build.command.file, build.command.args, commandOptions);
      const buildMetadata = parseJson(
        await fsPromises.readFile(build.metadataPath),
        `${build.name} build metadata`,
      );
      const indexDigest = requireDigest(
        buildMetadata['containerimage.digest'],
        `${build.name} index`,
      );
      const indexDocument = parseJson(
        runner.capture('docker', [
          'buildx',
          'imagetools',
          'inspect',
          '--raw',
          `${build.repository}@${indexDigest}`,
        ], commandOptions),
        `${build.name} image index`,
      );
      const imageMetadata = collectBotRuntimeImageMetadata({
        repository: build.repository,
        indexDigest,
        indexDocument,
        attestationDocuments: loadAttestationDocuments(
          runner,
          build.repository,
          indexDocument,
          commandOptions,
        ),
      });
      const signedDigests = new Set([
        imageMetadata.indexDigest,
        ...Object.values(imageMetadata.platforms).map((platform) => platform.digest),
      ]);
      for (const digest of signedDigests) {
        runner.run('cosign', ['sign', '--yes', `${build.repository}@${digest}`], commandOptions);
      }
      images[build.key] = {
        name: build.name,
        repository: build.repository,
        indexDigest: imageMetadata.indexDigest,
        platforms: imageMetadata.platforms,
      };
    }
    const manifest = verifyBotRuntimeImagesManifest({
      version: BOT_RUNTIME_RELEASE_MANIFEST_VERSION,
      channel: 'release',
      releaseId: version,
      sourceRevision: revision,
      openCodeVersion: releaseMetadata.openCodeVersion,
      schemaVersion: releaseMetadata.schemaVersion,
      pluginHash: releaseMetadata.pluginHash,
      images,
    }, {
      expectedReleaseId: version,
      expectedRevision: revision,
      expectedRepositoryPrefix: repositoryPrefix,
    });
    await atomicWriteManifest(outputPath, manifest, fsPromises);
    return manifest;
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const parseArguments = (argv) => {
  const values = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      values.dryRun = true;
      continue;
    }
    if (!['--version', '--revision', '--repository-prefix', '--output'].includes(argument)) {
      fail(`Unknown argument: ${argument}`, 'bot_runtime_image_build_cli_invalid');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      fail(`Missing value for ${argument}`, 'bot_runtime_image_build_cli_invalid');
    }
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.version || !values.revision || !values['repository-prefix']
    || (!values.dryRun && !values.output)) {
    fail('Usage: build-bot-runtime-images.mjs --version <version> --revision <sha> --repository-prefix <registry/path> --output <DevRyan-manifest.json> [--dry-run]', 'bot_runtime_image_build_cli_invalid');
  }
  return values;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const identity = {
    version: args.version,
    revision: args.revision,
    repositoryPrefix: args['repository-prefix'],
  };
  await readBotRuntimeReleaseMetadata({ root: repositoryRoot, version: args.version });
  if (args.dryRun) {
    const plan = createBotRuntimeImageBuildPlan({ ...identity, root: repositoryRoot });
    console.log(JSON.stringify(plan, null, 2));
    console.log(`[bots] runtime image build dry-run PASS (${plan.builds.length} images, ${plan.platforms.length} platforms)`);
    return;
  }
  const manifest = await buildBotRuntimeImages({
    ...identity,
    outputPath: args.output,
    root: repositoryRoot,
  });
  console.log(`[bots] published and signed ${Object.keys(manifest.images).length} runtime images`);
  console.log(`[bots] release manifest: ${path.resolve(args.output)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[bots] runtime image build failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
