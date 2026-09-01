import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOT_RUNTIME_IMAGE_DEFINITIONS,
  collectBotRuntimeImageMetadata,
  createBotRuntimeImageBuildPlan,
  readBotRuntimeReleaseMetadata,
} from './build-bot-runtime-images.mjs';
import {
  readAndVerifyBotRuntimeImagesManifest,
  stageVerifiedBotRuntimeImagesManifest,
  verifyAnonymousBotRuntimeImageAccess,
  verifyBotRuntimeImagesManifest,
} from './verify-bot-runtime-images.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
).version;
const temporaryDirectories = [];
const digest = (character) => `sha256:${character.repeat(64)}`;
const sourceRevision = '1'.repeat(40);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-image-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

const validManifest = () => ({
  version: 2,
  channel: 'release',
  releaseId: currentVersion,
  sourceRevision,
  openCodeVersion: '1.18.25',
  schemaVersion: '20260824120000',
  pluginHash: digest('f'),
  images: Object.fromEntries(Object.entries(BOT_RUNTIME_IMAGE_DEFINITIONS).map(
    ([key, definition], imageIndex) => [key, {
      name: definition.name,
      repository: `ghcr.io/1h-team/${definition.name}`,
      indexDigest: digest(String((imageIndex + 1) % 10)),
      platforms: {
        'linux/amd64': {
          digest: digest('a'),
          sbomDigest: digest('b'),
          provenanceDigest: digest('c'),
        },
        'linux/arm64': {
          digest: digest('d'),
          sbomDigest: digest('e'),
          provenanceDigest: digest('f'),
        },
      },
    }],
  )),
});

describe('Bot runtime release manifest verification', () => {
  test('accepts the exact two-platform signed image inventory', () => {
    const manifest = verifyBotRuntimeImagesManifest(validManifest(), {
      expectedReleaseId: currentVersion,
      expectedRevision: sourceRevision,
      expectedRepositoryPrefix: 'ghcr.io/1h-team',
    });

    assert.equal(Object.isFrozen(manifest), true);
    assert.deepEqual(Object.keys(manifest.images), Object.keys(BOT_RUNTIME_IMAGE_DEFINITIONS));
    assert.equal(manifest.images.opencode.platforms['linux/arm64'].sbomDigest, digest('e'));
  });

  test('rejects missing platforms, mutable metadata, and unknown fields', () => {
    const missingPlatform = validManifest();
    delete missingPlatform.images.supervisor.platforms['linux/amd64'];
    assert.throws(
      () => verifyBotRuntimeImagesManifest(missingPlatform),
      (error) => error.code === 'bot_runtime_manifest_invalid',
    );

    const uppercaseRepository = validManifest();
    uppercaseRepository.images.egress.repository = 'ghcr.io/1H-Team/devryan-bot-egress';
    assert.throws(
      () => verifyBotRuntimeImagesManifest(uppercaseRepository),
      (error) => error.code === 'bot_runtime_manifest_invalid',
    );

    const unknownField = validManifest();
    unknownField.images.indexer.platforms['linux/arm64'].tag = 'latest';
    assert.throws(
      () => verifyBotRuntimeImagesManifest(unknownField),
      (error) => error.code === 'bot_runtime_manifest_invalid',
    );
  });

  test('enforces the expected release, revision, and GHCR namespace', () => {
    assert.throws(
      () => verifyBotRuntimeImagesManifest(validManifest(), { expectedReleaseId: '999.0.0' }),
      (error) => error.code === 'bot_runtime_release_mismatch',
    );
    assert.throws(
      () => verifyBotRuntimeImagesManifest(validManifest(), { expectedRevision: '2'.repeat(40) }),
      (error) => error.code === 'bot_runtime_revision_mismatch',
    );
    assert.throws(
      () => verifyBotRuntimeImagesManifest(validManifest(), {
        expectedRepositoryPrefix: 'ghcr.io/another-owner',
      }),
      (error) => error.code === 'bot_runtime_repository_mismatch',
    );
  });

  test('stages only a verified bounded regular file', async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, 'source.json');
    const destination = path.join(directory, 'staged', 'images.release.json');
    await fs.writeFile(source, `${JSON.stringify(validManifest())}\n`);

    await stageVerifiedBotRuntimeImagesManifest({
      sourcePath: source,
      destinationPath: destination,
      expectedReleaseId: currentVersion,
    });
    const staged = await readAndVerifyBotRuntimeImagesManifest({
      manifestPath: destination,
      expectedRevision: sourceRevision,
    });
    assert.equal(staged.releaseId, currentVersion);

    const link = path.join(directory, 'manifest-link.json');
    await fs.symlink(source, link);
    await assert.rejects(
      stageVerifiedBotRuntimeImagesManifest({
        sourcePath: link,
        destinationPath: path.join(directory, 'should-not-exist.json'),
      }),
      (error) => error.code === 'bot_runtime_release_source_invalid',
    );
  });

  test('checks every index and platform digest with an empty Docker credential directory', async () => {
    const calls = [];
    const manifest = validManifest();
    await verifyAnonymousBotRuntimeImageAccess(manifest, {
      environment: {
        PATH: '/usr/bin',
        DOCKER_AUTH_CONFIG: 'secret',
        REGISTRY_AUTH_FILE: '/private/auth.json',
      },
      probe: async (reference, options) => {
        calls.push({ reference, environment: { ...options.environment } });
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    assert.equal(calls.length, Object.keys(BOT_RUNTIME_IMAGE_DEFINITIONS).length * 3);
    assert.deepEqual(calls.slice(0, 3).map(({ reference }) => reference), [
      `${manifest.images.supervisor.repository}@${manifest.images.supervisor.indexDigest}`,
      `${manifest.images.supervisor.repository}@${manifest.images.supervisor.platforms['linux/amd64'].digest}`,
      `${manifest.images.supervisor.repository}@${manifest.images.supervisor.platforms['linux/arm64'].digest}`,
    ]);
    assert.equal(calls.every(({ environment }) => (
      typeof environment.DOCKER_CONFIG === 'string'
      && environment.DOCKER_CONFIG.includes('devryan-bot-registry-')
      && !Object.hasOwn(environment, 'DOCKER_AUTH_CONFIG')
      && !Object.hasOwn(environment, 'REGISTRY_AUTH_FILE')
    )), true);
  });

  test('blocks release verification when an exact digest is not anonymous', async () => {
    let attempts = 0;
    await assert.rejects(
      verifyAnonymousBotRuntimeImageAccess(validManifest(), {
        probe: async () => {
          attempts += 1;
          return attempts === 2
            ? { exitCode: 1, stdout: '', stderr: 'unauthorized: authentication required' }
            : { exitCode: 0, stdout: '{}', stderr: '' };
        },
      }),
      (error) => (
        error.code === 'bot_runtime_anonymous_access_failed'
        && /not anonymously accessible/.test(error.message)
      ),
    );
    assert.equal(attempts, 2);
  });
});

describe('Bot runtime image build metadata', () => {
  test('builds every lowercase GHCR image for amd64 and arm64 with attestations', () => {
    const plan = createBotRuntimeImageBuildPlan({
      version: currentVersion,
      revision: sourceRevision,
      repositoryPrefix: 'ghcr.io/1h-team',
      root: repositoryRoot,
    });

    assert.equal(plan.builds.length, Object.keys(BOT_RUNTIME_IMAGE_DEFINITIONS).length);
    assert.deepEqual(plan.platforms, ['linux/amd64', 'linux/arm64']);
    for (const build of plan.builds) {
      assert.equal(build.command.file, 'docker');
      assert.equal(build.repository, build.repository.toLowerCase());
      assert.equal(build.tags[0], `${build.repository}:${currentVersion}`);
      assert.equal(build.command.args.includes('--push'), true);
      assert.equal(build.command.args.includes('--sbom=true'), true);
      assert.equal(build.command.args.includes('--provenance=mode=max'), true);
      assert.equal(
        build.command.args[build.command.args.indexOf('--platform') + 1],
        'linux/amd64,linux/arm64',
      );
    }
  });

  test('extracts platform, SBOM, and provenance digests from the OCI attestations', () => {
    const amd64Digest = digest('a');
    const arm64Digest = digest('b');
    const amd64Attestation = digest('c');
    const arm64Attestation = digest('d');
    const indexDocument = {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: amd64Digest, platform: { os: 'linux', architecture: 'amd64' } },
        { digest: arm64Digest, platform: { os: 'linux', architecture: 'arm64' } },
        {
          digest: amd64Attestation,
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': amd64Digest,
          },
        },
        {
          digest: arm64Attestation,
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': arm64Digest,
          },
        },
      ],
    };
    const attestation = (sbomCharacter, provenanceCharacter) => ({
      layers: [
        {
          digest: digest(sbomCharacter),
          annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
        },
        {
          digest: digest(provenanceCharacter),
          annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' },
        },
      ],
    });

    const metadata = collectBotRuntimeImageMetadata({
      repository: 'ghcr.io/1h-team/devryan-bot-supervisor',
      indexDigest: digest('9'),
      indexDocument,
      attestationDocuments: new Map([
        [amd64Attestation, attestation('e', 'f')],
        [arm64Attestation, attestation('7', '8')],
      ]),
    });

    assert.deepEqual(metadata.platforms, {
      'linux/amd64': {
        digest: amd64Digest,
        sbomDigest: digest('e'),
        provenanceDigest: digest('f'),
      },
      'linux/arm64': {
        digest: arm64Digest,
        sbomDigest: digest('7'),
        provenanceDigest: digest('8'),
      },
    });
  });

  test('pins release metadata to package, OpenCode, schema, and plugin sources', async () => {
    const metadata = await readBotRuntimeReleaseMetadata({
      root: repositoryRoot,
      version: currentVersion,
    });
    assert.equal(metadata.openCodeVersion, '1.18.25');
    assert.equal(metadata.schemaVersion, '20260901130000');
    assert.match(metadata.pluginHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(new Set(Object.values(metadata.packageVersions)), new Set([currentVersion]));
  });

  test('passes the command-line dry run and manifest verifier', async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(
      directory,
      `DevRyan-bot-runtime-images-${currentVersion}.json`,
    );
    await fs.writeFile(manifestPath, `${JSON.stringify(validManifest())}\n`);
    const dryRun = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'scripts/build-bot-runtime-images.mjs'),
      '--dry-run',
      '--version',
      currentVersion,
      '--revision',
      sourceRevision,
      '--repository-prefix',
      'ghcr.io/1h-team',
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /runtime image build dry-run PASS/);

    const verification = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'scripts/verify-bot-runtime-images.mjs'),
      '--manifest',
      manifestPath,
      '--version',
      currentVersion,
      '--revision',
      sourceRevision,
      '--repository-prefix',
      'ghcr.io/1h-team',
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /verified runtime image manifest v2/);
  });
});

describe('Bot runtime release integration', () => {
  test('keeps package versions, full tests, signing, and branded assets in the release gate', async () => {
    const [
      workflow,
      bumpScript,
      rootPackageSource,
      electronPackageSource,
      electronAssetBuild,
      electronMainBundle,
    ] = await Promise.all([
      fs.readFile(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
      fs.readFile(path.join(repositoryRoot, 'scripts/bump-version.mjs'), 'utf8'),
      fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
      fs.readFile(path.join(repositoryRoot, 'packages/electron/package.json'), 'utf8'),
      fs.readFile(
        path.join(repositoryRoot, 'packages/electron/scripts/build-web-assets.mjs'),
        'utf8',
      ),
      fs.readFile(
        path.join(repositoryRoot, 'packages/electron/scripts/bundle-main.mjs'),
        'utf8',
      ),
    ]);
    const rootPackage = JSON.parse(rootPackageSource);
    const electronPackage = JSON.parse(electronPackageSource);
    for (const definition of Object.values(BOT_RUNTIME_IMAGE_DEFINITIONS)) {
      assert.match(workflow, new RegExp(definition.packageJson.replaceAll('/', '\\/')));
      assert.equal(bumpScript.includes(`'${definition.packageJson}'`), true);
      const packageDirectory = path.dirname(definition.packageJson);
      assert.equal(
        rootPackage.scripts['test:full'].includes(`bun run --cwd ${packageDirectory} test`),
        true,
      );
    }
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /docker\/setup-qemu-action@v4/);
    assert.match(workflow, /cosign-installer@v4\.1\.2/);
    assert.match(workflow, /--check-anonymous/);
    assert.match(workflow, /DevRyan-bot-runtime-images-\$\{\{ needs\.create-release\.outputs\.version \}\}\.json/);
    assert.equal(
      electronPackage.scripts.package.includes('verify-bot-runtime-images.mjs'),
      true,
    );
    assert.match(electronAssetBuild, /stageVerifiedBotRuntimeImagesManifest/);
    assert.match(electronMainBundle, /readAndVerifyBotRuntimeImagesManifest/);

    for (const invalidVersion of ['1.2.3-RC.1', '1.2.3-release_candidate']) {
      const result = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'scripts/bump-version.mjs'),
        invalidVersion,
      ], { cwd: repositoryRoot, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
    }
  });
});
