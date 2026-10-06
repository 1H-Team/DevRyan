import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfigJsonc, collapseRemovalKeyPaths, removeJsoncKeyPaths } from '../jsonc-config.js';
import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status, statusCode: status });
const scopes = new Set(['read', 'auth', 'user', 'project', 'custom', 'all']);
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const absent = error => error?.code === 'ENOENT';
const changed = () => fail('native_provider_configuration_changed');
const keys = (config, providerID) => ['provider', 'providers'].flatMap(key => collapseRemovalKeyPaths(config, [key], [providerID]));

// Sources come only from the selected descriptor, never ambient config constants.
function pathsFor(descriptor, directory) {
  const root = descriptor.launch.opencodeConfigDirectory;
  const user = ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => path.join(root, name));
  return { user, custom: [path.join(root, 'config.json')], project: directory ? [
    path.join(directory, 'opencode.json'), path.join(directory, 'opencode.jsonc'),
    path.join(directory, '.opencode', 'opencode.json'), path.join(directory, '.opencode', 'opencode.jsonc'),
  ] : [] };
}
function guard(file, roots) {
  const root = roots.find(value => within(value, file));
  if (!root || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw fail('native_provider_configuration_source_unreviewed', 403);
  let current = root;
  for (const segment of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat; try { stat = fs.lstatSync(current); } catch (error) { if (absent(error)) return; throw error; }
    if (stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw fail('native_provider_configuration_symlink', 403);
    if (current !== file && !stat.isDirectory() || current === file && !stat.isFile()) throw fail('native_provider_configuration_source_invalid');
  }
}
function read(file, roots) {
  guard(file, roots);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail('native_provider_configuration_source_invalid');
    guard(file, roots);
    const linked = fs.lstatSync(file);
    if (linked.dev !== stat.dev || linked.ino !== stat.ino) throw changed();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw changed();
    return { bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, config: parseConfigJsonc(bytes.toString('utf8'), file) };
  } catch (error) { if (absent(error)) return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function same(left, right) { return left === null ? right === null : right !== null && left.dev === right.dev && left.ino === right.ino && left.bytes.equals(right.bytes); }
function temporary(file, bytes, mode) {
  const name = `${file}.tmp-${randomUUID()}`;
  let fd;
  try { fd = fs.openSync(name, 'wx', mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); return name; }
  catch (error) { fs.rmSync(name, { force: true }); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A finite constructor-owned config/credential operation. No durable grant or
 * second apply owner: changed sources use the existing configuration coordinator. */
export function createNativeProviderConfigurationOperation({ descriptor, getSnapshot, isReady, captureWebAuthorization, credentialMetadata, credentialOperation }) {
  return async (input, action) => {
    input = Object.freeze({ providerID: input?.providerID, scope: input?.scope, directory: input?.directory ?? null });
    if (!['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(input.providerID) || !scopes.has(input.scope)) throw fail('native_provider_configuration_scope_invalid', 400);
    const snapshot = getSnapshot();
    if (!isReady() || descriptor.generation !== 2 || !snapshot) throw fail('native_runtime_not_ready', 503);
    const requested = input.directory ?? null;
    const directory = requested ?? snapshot.locations[0]?.directory;
    if (!descriptor.projectMap.some(row => row.targetDirectory === directory) || !snapshot.locations.some(row => row.directory === directory)) throw fail('native_provider_configuration_location_unreviewed', 403);
    if (input.scope === 'project' && !requested) throw fail('native_provider_configuration_directory_required', 400);
    let active = true;
    const original = await captureWebAuthorization({ operation: 'provider.configuration', scope: input.scope, directory });
    const live = () => { if (!active || !isReady() || getSnapshot() !== snapshot) throw fail('native_provider_configuration_runtime_changed', 503); };
    const recheck = async () => {
      live();
      if (!isReady() || getSnapshot() !== snapshot) throw fail('native_provider_configuration_runtime_changed', 503);
      await original();
      if (!isReady() || getSnapshot() !== snapshot) throw fail('native_provider_configuration_runtime_changed', 503);
    };
    await recheck();
    const location = snapshot.locations.find(row => row.directory === directory);
    const roots = [descriptor.launch.opencodeConfigDirectory, ...(requested ? [directory] : [])];
    const candidates = pathsFor(descriptor, requested);
    const initial = new Map(Object.values(candidates).flat().map(file => [file, read(file, roots)]));
    const backups = new Map();
    const verify = () => { live(); for (const [file, before] of [...initial, ...backups]) if (!same(before, read(file, roots))) throw changed(); };
    const affected = input.scope === 'all' ? ['user', 'custom', 'project'] : ['user', 'custom', 'project'].includes(input.scope) ? [input.scope] : [];
    for (const scope of affected) for (const file of candidates[scope]) {
      if (initial.get(file) && keys(initial.get(file).config, input.providerID).length) backups.set(`${file}.openchamber.backup`, read(`${file}.openchamber.backup`, roots));
    }
    const kind = input.providerID === 'openai' ? 'openai' : input.providerID === 'cursor-acp' ? 'cursor' : 'provider';
    const integrationID = input.providerID;
    const base = { kind, directory, integrationID, configurationDigest: credentialMutationFingerprint(location.configuration.providers?.[integrationID] ?? {}) };
    const metadata = async () => {
      await recheck();
      const rows = await credentialMetadata({ ...base, operation: `${kind}.integration`, method: 'GET', path: `/api/integration/${integrationID}` });
      await recheck();
      if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !row || row.integrationID !== integrationID || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id ?? '')
        || !/^[a-f0-9]{64}$/.test(row.expectedFingerprint ?? '') || !['key', 'oauth'].includes(row.valueType)
        || kind === 'cursor' && row.valueType !== 'key' || row.valueType === 'oauth' && !['chatgpt-siwc', 'chatgpt-browser', 'chatgpt-headless'].includes(row.methodID))
        || new Set(rows.map(row => row.id)).size !== rows.length) throw fail('native_credential_metadata_invalid', 502);
      return rows;
    };
    const readSources = () => { live(); return Object.fromEntries(Object.entries(candidates).map(([scope, files]) => {
      const file = files.find(file => { const value = read(file, roots); return value && keys(value.config, integrationID).length > 0; });
      return [scope, { exists: Boolean(file), path: file ?? files[0] ?? null }];
    })); };
    const owner = {
      recheck,
      verifyConfiguration: async () => { await recheck(); verify(); },
      readAuthenticationSource: async () => ({ exists: (await metadata()).length > 0, path: null }),
      readSources,
      listRemainingConfigSources: () => { live(); return [...new Set(Object.values(candidates).flat())].filter(file => { const value = read(file, roots); return value && keys(value.config, integrationID).length > 0; }).map(file => ({ type: 'config', path: file })); },
      disconnectCredentials: async (onCommitted, onStarted = () => {}) => {
        if (!['auth', 'all'].includes(input.scope)) throw fail('native_provider_configuration_scope_invalid', 400);
        const rows = await metadata(); verify();
        if (integrationID === 'openai' && rows.some(row => row.active && row.valueType === 'oauth')) throw fail('native_chatgpt_siwc_disconnect_required', 409);
        for (const row of rows.filter(row => integrationID !== 'openai' || row.valueType === 'key')) {
          await recheck(); verify();
          const spec = { ...base, operation: `${kind}.credential.remove`, method: 'DELETE', path: `/api/credential/${row.id}`, credentialID: row.id,
            valueType: row.valueType, ...(row.methodID === undefined ? {} : { methodID: row.methodID }), expectedFingerprint: row.expectedFingerprint,
            requestedFingerprint: credentialMutationFingerprint({ id: row.id }) };
          onStarted(); await credentialOperation(spec, { operation: 'remove', id: row.id }); onCommitted(); await recheck();
        }
      },
      removeConfiguration: async onCommitted => {
        const selected = input.scope === 'all' ? ['user', 'custom', 'project'] : ['user', 'custom', 'project'].includes(input.scope) ? [input.scope] : [];
        for (const scope of selected) for (const file of candidates[scope]) {
          await recheck(); verify();
          const before = initial.get(file); if (!before) continue;
          const next = removeJsoncKeyPaths(before.bytes.toString('utf8'), keys(before.config, integrationID));
          if (next === before.bytes.toString('utf8')) continue;
          const backup = `${file}.openchamber.backup`; guard(backup, roots);
          const staged = temporary(file, next, before.mode);
          let backupStaged;
          try {
            backupStaged = temporary(backup, before.bytes, before.mode);
            await recheck(); verify(); guard(backup, roots);
            fs.renameSync(backupStaged, backup); backupStaged = undefined;
            fs.renameSync(staged, file); onCommitted(scope);
            backups.set(backup, read(backup, roots)); initial.set(file, read(file, roots));
          } finally { fs.rmSync(staged, { force: true }); if (backupStaged) fs.rmSync(backupStaged, { force: true }); }
        }
      },
    };
    try { const result = await action(owner); await recheck(); verify(); return result; }
    finally { active = false; }
  };
}
