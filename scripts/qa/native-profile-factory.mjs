import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import initialMigration from '@opencode/core/database/migration/20260127222353_familiar_lady_ursula';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { runNativeMigrationProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import { createSessionExecutionHost } from '../../packages/web/server/lib/opencode/session-execution-host.js';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createQaNativeInputVerifier } from './native-profile-preparation.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const globalsKeys = ['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos'];

async function mirrorPath(root, relative, directory) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('qa_native_mirror_path_invalid');
  const file = path.join(root, relative), stat = await fs.lstat(file);
  if (!inside(root, file) || await fs.realpath(file) !== file || stat.isSymbolicLink()
    || (directory ? !stat.isDirectory() : !stat.isFile())) throw fail('qa_native_mirror_path_invalid');
  return file;
}

/** Manifest-covered configuration data only; no ambient or installed account
 * discovery. Live account acquisition remains a required original-owner callback. */
export async function createQaNativePreparationFactory({ preparedInput, mirror, bootstrapCredentials }) {
  if (typeof bootstrapCredentials !== 'function') throw fail('qa_native_credential_prerequisite');
  const verifier = await createQaNativeInputVerifier(preparedInput);
  if (!mirror || Object.keys(mirror).some(key => !['reviewedNativeFile', 'reviewedPluginFile', 'opencodeConfigDirectory', 'webConfigDirectory', 'homeDirectory'].includes(key))) throw fail('qa_native_mirror_invalid');
  const approved = Object.fromEntries(await Promise.all(Object.entries(mirror).map(async ([key, relative]) => [key,
    await mirrorPath(verifier.input.sourceHome, relative, key.endsWith('Directory'))])));
  for (const key of ['reviewedNativeFile', 'reviewedPluginFile', 'opencodeConfigDirectory', 'webConfigDirectory']) if (!approved[key]) throw fail('qa_native_mirror_invalid');
  const mirrorSnapshot = Object.freeze({ ...approved });
  const prepareSource = async ({ runtimeRoot, workspace, sourceHome, artifactRoot }) => {
    if (sourceHome !== verifier.input.sourceHome || artifactRoot !== verifier.input.artifactRoot) throw fail('qa_native_input_changed');
    await verifier.verifyInputs();
    assert.ok(path.isAbsolute(runtimeRoot) && inside(path.join(repository, '.cache'), runtimeRoot) && await fs.realpath(runtimeRoot) === runtimeRoot);
    assert.ok(path.isAbsolute(workspace) && inside(path.join(repository, '.cache'), workspace) && await fs.realpath(workspace) === workspace);
    const manifestPath = path.join(artifactRoot, 'native-bundle.json'), manifestSha256 = hash(await fs.readFile(manifestPath));
    const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256,
      launcher: path.join(artifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
    const sourceRoot = path.join(runtimeRoot, 'source'); await fs.mkdir(sourceRoot, { mode: 0o700 });
    const global = Object.fromEntries(globalsKeys.map(key => [key, key === 'config' ? path.join(sourceRoot, 'config/opencode') : path.join(sourceRoot, 'global', key)]));
    const webConfigDirectory = path.join(sourceRoot, 'config/openchamber'), webDataDirectory = path.join(sourceRoot, 'web-data');
    for (const directory of [...Object.values(global), webConfigDirectory, webDataDirectory]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [source, target] of [[mirrorSnapshot.opencodeConfigDirectory, global.config], [mirrorSnapshot.webConfigDirectory, webConfigDirectory],
      ...(mirrorSnapshot.homeDirectory ? [[mirrorSnapshot.homeDirectory, global.home]] : [])]) {
      for (const entry of await fs.readdir(source)) {
        await fs.cp(path.join(source, entry), path.join(target, entry), { recursive: true, force: false, errorOnExist: true });
      }
    }
    const reviewed = JSON.parse(await fs.readFile(mirrorSnapshot.reviewedNativeFile, 'utf8'));
    if (reviewed.schema !== 1 || !reviewed.configuration || !reviewed.catalogRequirements) throw fail('qa_native_mirror_configuration_invalid');
    // Configuration/roles/prompts/efforts are unchanged. Only the actual owned
    // location policy is supplied by this host constructor, never a model.
    reviewed.locations = [{ directory: workspace, readRoots: [workspace], protectedRoots: [sourceRoot, verifier.input.sourceHome] }];
    const reviewedNativeConfigPath = path.join(sourceRoot, 'reviewed-native.json');
    const reviewedPluginManifestPath = path.join(sourceRoot, 'reviewed-plugins.json');
    await fs.writeFile(reviewedNativeConfigPath, JSON.stringify(reviewed) + '\n', { mode: 0o600 });
    await fs.copyFile(mirrorSnapshot.reviewedPluginFile, reviewedPluginManifestPath);
    const opencodeDatabasePath = path.join(sourceRoot, 'opencode-devryan.db'); await fs.writeFile(opencodeDatabasePath, '', { mode: 0o600 });
    const db = resolveSqliteDriver().open(opencodeDatabasePath), statements = [];
    try {
      await Effect.runPromise(initialMigration.up({ run: sql => Effect.sync(() => { statements.push(sql); db.exec(sql); }) }));
      db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL, name TEXT NOT NULL)');
      db.prepare('INSERT INTO __drizzle_migrations VALUES (1,?,?,?)').run(hash(JSON.stringify(statements)), Date.UTC(2026, 0, 27, 22, 23, 53), initialMigration.id);
    } finally { db.close(); }
    const shared = { reviewedNativeConfigPath, reviewedPluginManifestPath };
    const nativeArtifacts = { ...shared, controllerBinary: artifacts.controller, writerBinary: artifacts.writer, artifactManifestPath: manifestPath, artifactManifestSha256: manifestSha256 };
    const launch = { opencodeDatabasePath, webDataDirectory, webConfigDirectory, opencodeConfigDirectory: global.config, global: { home: global.home } };
    // This newly created source/baseline has never run a controller or producer.
    // The actual host/store drain supplies the checkpoint; no fabricated stamp.
    const checkpointOptions = async ({ launch: capturedLaunch, generation }) => {
      const client = createOpenCodeClient({ getRuntime: () => ({ generation, ready: false }) });
      const host = createSessionExecutionHost({ dataDirectory: capturedLaunch.webDataDirectory, openCodeClient: client,
        getLauncher: () => artifacts.launcher, buildOpenCodeUrl: () => { throw fail('qa_native_source_never_started'); }, getOpenCodeAuthHeaders: () => ({}) });
      return { neverStarted: true, closeAdmission: () => host.runtime.drain(), getController: () => null,
        stopProducers: () => host.runtime.drain(), executionHost: host, drainStores: () => host.runtime.drain() };
    };
    const runMigration = request => runNativeMigrationProcess({ binary: artifacts.controller, request, cwd: runtimeRoot,
      environment: createQaHostLaunchEnvironment({ HOME: path.join(request.isolatedRoot, 'home'), XDG_CONFIG_HOME: path.join(request.isolatedRoot, 'config'),
        XDG_DATA_HOME: path.join(request.isolatedRoot, 'data'), XDG_STATE_HOME: path.join(request.isolatedRoot, 'state'),
        XDG_CACHE_HOME: path.join(request.isolatedRoot, 'cache'), TMPDIR: path.join(request.isolatedRoot, 'tmp'),
        GIT_CEILING_DIRECTORIES: repository, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
      beforeSpawn: async () => { await verifier.verifyInputs(); await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher: artifacts.launcher }); } });
    await verifier.verifyInputs();
    return { launch, nativeArtifacts, projectMap: [{ sourceDirectory: workspace, targetDirectory: workspace, mode: 'identity' }], checkpointOptions, runMigration };
  };
  return Object.freeze({ preparedInput: verifier.input, prepareSource, bootstrapCredentials });
}
