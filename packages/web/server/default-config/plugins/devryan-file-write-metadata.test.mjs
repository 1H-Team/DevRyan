import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DevRyanFileWriteMetadataPlugin } from './devryan-file-write-metadata.mjs';

const { afterEach, describe, expect, test } = process.env.VITEST
  ? await import('vitest')
  : await import('bun:test');

const tempDirectories = [];

const createFixture = async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-file-write-metadata-'));
  tempDirectories.push(directory);
  return {
    directory,
    hooks: await DevRyanFileWriteMetadataPlugin({ directory }),
  };
};

const beforeWrite = (hooks, callID, targetPath) => hooks['tool.execute.before'](
  { tool: 'oc_write', sessionID: 'session-1', callID },
  { args: { path: targetPath, content: 'SELECT 1;' } },
);

const afterWrite = async (hooks, callID, metadata = {}) => {
  const output = { title: '', output: 'ok', metadata };
  await hooks['tool.execute.after'](
    { tool: 'oc_write', sessionID: 'session-1', callID, args: {} },
    output,
  );
  return output;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('DevRyan file write metadata plugin', () => {
  test('marks a missing compatibility-write target as newly created', async () => {
    const { hooks } = await createFixture();
    await beforeWrite(hooks, 'call-create', 'migration.sql');

    const output = await afterWrite(hooks, 'call-create', { truncated: false });

    expect(output.metadata).toEqual({ truncated: false, exists: false });
  });

  test('marks an existing compatibility-write target as edited', async () => {
    const { directory, hooks } = await createFixture();
    fs.writeFileSync(path.join(directory, 'migration.sql'), 'SELECT 1;');
    await beforeWrite(hooks, 'call-edit', 'migration.sql');

    const output = await afterWrite(hooks, 'call-edit', { source: 'open-cursor' });

    expect(output.metadata).toEqual({ source: 'open-cursor', exists: true });
  });

  test('keeps concurrent calls isolated by session and call id', async () => {
    const { directory, hooks } = await createFixture();
    fs.writeFileSync(path.join(directory, 'existing.sql'), 'SELECT 1;');
    await beforeWrite(hooks, 'call-new', 'new.sql');
    await beforeWrite(hooks, 'call-existing', 'existing.sql');

    const existingOutput = await afterWrite(hooks, 'call-existing');
    const newOutput = await afterWrite(hooks, 'call-new');

    expect(existingOutput.metadata.exists).toBe(true);
    expect(newOutput.metadata.exists).toBe(false);
  });

  test('does not overwrite authoritative metadata from the tool provider', async () => {
    const { hooks } = await createFixture();
    await beforeWrite(hooks, 'call-authoritative', 'new.sql');

    const output = await afterWrite(hooks, 'call-authoritative', { exists: true, provider: 'native' });

    expect(output.metadata).toEqual({ exists: true, provider: 'native' });
  });

  test('does not change unrelated tool results', async () => {
    const { hooks } = await createFixture();
    const output = { title: '', output: 'ok', metadata: { source: 'stat' } };

    await hooks['tool.execute.before'](
      { tool: 'stat', sessionID: 'session-1', callID: 'call-stat' },
      { args: { path: 'migration.sql' } },
    );
    await hooks['tool.execute.after'](
      { tool: 'stat', sessionID: 'session-1', callID: 'call-stat', args: {} },
      output,
    );

    expect(output.metadata).toEqual({ source: 'stat' });
  });
});
