import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OPENCODE_RUNTIME_SELECTION_FILE,
  clearOpenCodeRuntimeSelection,
  forgetOwnOpenCodeRuntimeSelection,
  getOpenCodeRuntimeSelectionPath,
  normalizeOpenCodeRuntimeSelection,
  readOpenCodeRuntimeSelection,
  resolveOpenCodeDatabaseSelection,
  resolveOpenCodeDataDirectory,
  writeOpenCodeRuntimeSelection,
} from './runtime-selection.js';

const tempDirs = [];
const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-runtime-selection-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const HOME = path.join(path.sep, 'home', 'agent');
const derive = ({env={}}={}) => ({version:1,writtenAt:1700000000000,ownerPid:4242,
 runtime:{generation:2,kind:'host',binary:'/fixture/DevRyan-native-controller',channel:'opencode'},
 opencode:{dataDirectory:path.join(env.XDG_DATA_HOME||path.join(HOME,'.local','share'),'opencode'),
 databasePath:path.join(env.XDG_DATA_HOME||path.join(HOME,'.local','share'),'opencode','opencode.db'),configDirectory:null,databaseSource:'OPENCODE_DB'}});

describe('normalizeOpenCodeRuntimeSelection', () => {
  it('accepts only the explicit native host and rejects legacy or malformed identities', () => {
    const base = derive();
    expect(normalizeOpenCodeRuntimeSelection(base)).toEqual(base);
    expect(normalizeOpenCodeRuntimeSelection({ ...base, runtime: { ...base.runtime, generation: 2, kind: 'host' } })).toMatchObject({
      runtime: { generation: 2, kind: 'host' },
    });
    for(const runtime of [{...base.runtime,generation:1},{...base.runtime,kind:'plain'},{...base.runtime,kind:'companion'},{...base.runtime,channel:'devryan'}])expect(normalizeOpenCodeRuntimeSelection({...base,runtime})).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, runtime: { ...base.runtime, generation: 3 } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, runtime: { ...base.runtime, generation: '1' } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, runtime: { ...base.runtime, kind: 'sidecar' } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, runtime: { ...base.runtime, channel: 'beta' } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, version: 2 })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, opencode: { ...base.opencode, databasePath: 'relative.db' } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, opencode: { ...base.opencode, databaseSource: 'mtime' } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection({ ...base, opencode: { ...base.opencode, configDirectory: 7 } })).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection(null)).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection([])).toBeNull();
    expect(normalizeOpenCodeRuntimeSelection('{}')).toBeNull();
  });
});

describe('write/read round trip', () => {
  it('writes atomically with owner-only mode into the data directory and reads it back', () => {
    const dataDir = path.join(makeTempDir(), 'nested', 'openchamber');
    const selection = derive();

    const file = writeOpenCodeRuntimeSelection(selection, { dataDir });

    expect(file).toBe(path.join(dataDir, OPENCODE_RUNTIME_SELECTION_FILE));
    expect(getOpenCodeRuntimeSelectionPath({ dataDir })).toBe(file);
    expect(fs.readdirSync(dataDir)).toEqual([OPENCODE_RUNTIME_SELECTION_FILE]);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readOpenCodeRuntimeSelection({ dataDir })).toEqual(selection);
  });

  it('resolves the data directory from OPENCHAMBER_DATA_DIR when no dataDir is given', () => {
    const dataDir = makeTempDir();
    const env = { OPENCHAMBER_DATA_DIR: dataDir };
    writeOpenCodeRuntimeSelection(derive(), { env });
    expect(readOpenCodeRuntimeSelection({ env })).toMatchObject({ runtime: { kind: 'host' } });
  });

  it('keeps owner-only mode when a leftover temp file had another mode', () => {
    if (process.platform === 'win32') return;
    const dataDir = makeTempDir();
    const tmp = path.join(dataDir, `${OPENCODE_RUNTIME_SELECTION_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, 'stale', { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);

    const file = writeOpenCodeRuntimeSelection(derive(), { dataDir });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('forgets only a record the given owner wrote', () => {
    const dataDir = makeTempDir();
    const selection = derive();
    writeOpenCodeRuntimeSelection(selection, { dataDir });

    expect(forgetOwnOpenCodeRuntimeSelection({ dataDir, ownerPid: selection.ownerPid + 1 })).toBe(false);
    expect(readOpenCodeRuntimeSelection({ dataDir })).toEqual(selection);
    expect(forgetOwnOpenCodeRuntimeSelection({ dataDir, ownerPid: selection.ownerPid })).toBe(true);
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
    expect(forgetOwnOpenCodeRuntimeSelection({ dataDir, ownerPid: selection.ownerPid })).toBe(false);
  });

  it('clears the manifest, and clearing a missing one is a no-op', () => {
    const dataDir = makeTempDir();
    writeOpenCodeRuntimeSelection(derive(), { dataDir });
    clearOpenCodeRuntimeSelection({ dataDir });
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
    expect(() => clearOpenCodeRuntimeSelection({ dataDir })).not.toThrow();
  });

  it('refuses to write an invalid selection and leaves no file behind', () => {
    const dataDir = makeTempDir();
    expect(() => writeOpenCodeRuntimeSelection({ version: 1 }, { dataDir })).toThrow(TypeError);
    expect(fs.existsSync(path.join(dataDir, OPENCODE_RUNTIME_SELECTION_FILE))).toBe(false);
  });

  it('reads null for a missing, malformed or unknown-version manifest without throwing', () => {
    const dataDir = makeTempDir();
    const file = path.join(dataDir, OPENCODE_RUNTIME_SELECTION_FILE);
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
    fs.writeFileSync(file, '{ not json');
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...derive(), version: 99 }));
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...derive(), runtime: { generation: 1, kind: 'plain', binary: '', channel: 'opencode' } }));
    expect(readOpenCodeRuntimeSelection({ dataDir })).toBeNull();
  });
});

describe('resolveOpenCodeDatabaseSelection', () => {
  it('prefers the manifest over the newest file on disk', () => {
    const dataDir = makeTempDir();
    const opencodeDataPath = makeTempDir();
    fs.writeFileSync(path.join(opencodeDataPath, 'opencode.db'), 'x');
    const selection = derive({ env: { XDG_DATA_HOME: path.dirname(opencodeDataPath) } });
    writeOpenCodeRuntimeSelection(selection, { dataDir });

    const resolved = resolveOpenCodeDatabaseSelection({ dataDir, opencodeDataPath, ownerPid: selection.ownerPid });

    expect(resolved).toEqual({ path: selection.opencode.databasePath, source: 'selection', selection });
    expect(resolved.path.endsWith('opencode.db')).toBe(true);
  });

  it('ignores a record written by another server process (external or restarted runtime)', () => {
    const dataDir = makeTempDir();
    const opencodeDataPath = makeTempDir();
    fs.writeFileSync(path.join(opencodeDataPath, 'opencode.db'), 'x');
    const selection = derive({ env: { XDG_DATA_HOME: path.dirname(opencodeDataPath) } });
    writeOpenCodeRuntimeSelection(selection, { dataDir });

    expect(resolveOpenCodeDatabaseSelection({ dataDir, opencodeDataPath, ownerPid: selection.ownerPid + 1 })).toEqual({
      path: path.join(opencodeDataPath, 'opencode.db'),
      source: 'legacy-newest',
      selection: null,
    });
    // The default owner is this process.
    expect(resolveOpenCodeDatabaseSelection({ dataDir, opencodeDataPath }).source)
      .toBe(selection.ownerPid === process.pid ? 'selection' : 'legacy-newest');
  });

  it('falls back to the legacy newest-by-mtime resolver without a manifest', () => {
    const dataDir = makeTempDir();
    const opencodeDataPath = makeTempDir();
    fs.writeFileSync(path.join(opencodeDataPath, 'opencode.db'), 'x');

    expect(resolveOpenCodeDatabaseSelection({ dataDir, opencodeDataPath })).toEqual({
      path: path.join(opencodeDataPath, 'opencode.db'),
      source: 'legacy-newest',
      selection: null,
    });
  });

  it('derives the OpenCode data path from env when none is given', () => {
    const dataDir = makeTempDir();
    const xdg = makeTempDir();
    expect(resolveOpenCodeDatabaseSelection({ dataDir, env: { XDG_DATA_HOME: xdg } })).toEqual({
      path: path.join(xdg, 'opencode', 'opencode.db'),
      source: 'legacy-newest',
      selection: null,
    });
  });
});

it("stale generation-one manifests never authorize writable native data",()=>{const dataDir=makeTempDir(),legacy={...derive(),runtime:{...derive().runtime,generation:1}};fs.writeFileSync(getOpenCodeRuntimeSelectionPath({dataDir}),JSON.stringify(legacy));expect(readOpenCodeRuntimeSelection({dataDir})).toBeNull();expect(resolveOpenCodeDatabaseSelection({dataDir,ownerPid:legacy.ownerPid}).source).toBe("legacy-newest");expect(()=>writeOpenCodeRuntimeSelection(legacy,{dataDir})).toThrow(TypeError);});
