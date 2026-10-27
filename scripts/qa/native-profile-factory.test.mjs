import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createQaNativePreparationFactory } from './native-profile-factory.mjs';
import { createRunRoot, scratchParent } from './run-root.mjs';

// Constructor validation only; actual compiled startup is a separate diagnostic.
test('concrete preparation requires explicit account acquisition and manifest-covered canonical mirror paths', async t => {
  const root = await fs.mkdtemp(path.resolve('.cache/factory-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceHome = path.join(root, 'mirror'), artifactRoot = path.join(root, 'artifacts');
  await fs.mkdir(sourceHome); await fs.mkdir(artifactRoot);
  await fs.mkdir(path.join(sourceHome, 'native')); await fs.mkdir(path.join(sourceHome, 'web'));
  await fs.writeFile(path.join(sourceHome, 'native/config.json'), '{}');
  await fs.writeFile(path.join(sourceHome, 'web/settings.json'), '{}');
  await fs.writeFile(path.join(sourceHome, 'reviewed.json'), '{"schema":1}');
  await fs.writeFile(path.join(sourceHome, 'plugins.json'), '{"schema":1,"plugins":[]}');
  const files = await Promise.all(['native/config.json', 'web/settings.json', 'reviewed.json', 'plugins.json'].map(async file => ({ path: file,
    sha256: createHash('sha256').update(await fs.readFile(path.join(sourceHome, file))).digest('hex') })));
  const input = { preparedInput: { sourceHome, artifactRoot, files }, mirror: { reviewedNativeFile: 'reviewed.json', reviewedPluginFile: 'plugins.json',
    opencodeConfigDirectory: 'native', webConfigDirectory: 'web' }, bootstrapCredentials: async () => { throw Error('explicit acquisition not ready'); } };
  const factory = await createQaNativePreparationFactory(input);
  assert.equal(typeof factory.prepareSource, 'function'); assert.equal(factory.bootstrapCredentials, input.bootstrapCredentials);
  assert.equal(factory.preparedInput.sourceHome, sourceHome);
  await fs.writeFile(path.join(sourceHome, 'native/config.json'), '{\"changed\":true}');
  await assert.rejects(factory.prepareSource({ sourceHome, artifactRoot, runtimeRoot: root, workspace: root }), { code: 'qa_native_input_changed' });
  await fs.writeFile(path.join(sourceHome, 'native/config.json'), '{}');
  await assert.rejects(factory.prepareSource({ sourceHome: root, artifactRoot, runtimeRoot: root, workspace: root }), { code: 'qa_native_input_changed' });
  await assert.rejects(createQaNativePreparationFactory({ ...input, bootstrapCredentials: undefined }), { code: 'qa_native_credential_prerequisite' });
  await assert.rejects(createQaNativePreparationFactory({ ...input, mirror: { ...input.mirror, homeDirectory: '../outside' } }), { code: 'qa_native_mirror_path_invalid' });
  await assert.rejects(createQaNativePreparationFactory({ ...input, mirror: { ...input.mirror, homeDirectory: '/Users/installed' } }), { code: 'qa_native_mirror_path_invalid' });
  await fs.symlink(path.join(sourceHome, 'native'), path.join(sourceHome, 'linked'));
  await assert.rejects(createQaNativePreparationFactory({ ...input, mirror: { ...input.mirror, homeDirectory: 'linked' } }), { code: 'qa_native_input_symlink' });
});

test('temporary mirror requires its creator run scope through the preparation factory', async t => {
  const run = createRunRoot({ parent: scratchParent('qa'), owner: 'factory-scope-test', signals: false, argv: [], env: {} });
  const foreign = createRunRoot({ parent: scratchParent('qa'), owner: 'factory-foreign-scope-test', signals: false, argv: [], env: {} });
  const artifactRoot = await fs.mkdtemp(path.resolve('.cache/factory-artifact-'));
  t.after(async () => { run.finish('passed'); foreign.finish('passed'); await fs.rm(artifactRoot, { recursive: true, force: true }); });
  const sourceHome = path.join(run.dir, 'mirror');
  await fs.mkdir(sourceHome);
  for (const directory of ['native', 'web']) await fs.mkdir(path.join(sourceHome, directory));
  for (const file of ['reviewed.json', 'plugins.json']) await fs.writeFile(path.join(sourceHome, file), '{}');
  const files = await Promise.all(['reviewed.json', 'plugins.json'].map(async file => ({ path: file,
    sha256: createHash('sha256').update(await fs.readFile(path.join(sourceHome, file))).digest('hex') })));
  const input = { preparedInput: { sourceHome, artifactRoot, files }, mirror: { reviewedNativeFile: 'reviewed.json', reviewedPluginFile: 'plugins.json',
    opencodeConfigDirectory: 'native', webConfigDirectory: 'web' }, bootstrapCredentials: async () => {} };
  await assert.rejects(createQaNativePreparationFactory(input), { code: 'qa_native_input_source_home_path_invalid' });
  await assert.rejects(createQaNativePreparationFactory({ ...input, runScope: foreign.scope }), { code: 'qa_native_input_source_home_path_invalid' });
  const factory = await createQaNativePreparationFactory({ ...input, runScope: run.scope });
  assert.equal(factory.preparedInput.sourceHome, sourceHome);
  const runtimeRoot = path.join(run.dir, 'runtime'), workspace = path.join(run.dir, 'workspace');
  await fs.mkdir(runtimeRoot); await fs.mkdir(workspace);
  await assert.rejects(factory.prepareSource({ runtimeRoot, workspace, sourceHome, artifactRoot }), { code: 'ENOENT' });
});
