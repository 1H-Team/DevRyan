import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createParentReadFreshness } from './parent-read-freshness.js';

describe('parent reads across managed writes', () => {
  let directory;
  let freshness;
  let input;
  const read = async (overrides = {}) => {
    const current = { ...input, tool: 'read', callId: 'call_read', barrierClear: true, ...overrides };
    await freshness.beginRead(current);
    await freshness.observeRead(current);
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-read-freshness-'));
    freshness = createParentReadFreshness();
    input = { directory, rootSessionId: 'ses_root', tool: 'edit', args: { filePath: 'source.txt' } };
    await fs.writeFile(path.join(directory, 'source.txt'), 'original');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('requires a read after the barrier clears and detects later writes', async () => {
    await expect(freshness.assertWrite(input)).rejects.toMatchObject({ code: 'managed_read_refresh_required' });
    await read({ barrierClear: false });
    await expect(freshness.assertWrite(input)).rejects.toThrow('Read the current target');
    await read();
    await expect(freshness.assertWrite(input)).resolves.toBeUndefined();
    await fs.writeFile(path.join(directory, 'source.txt'), 'modified');
    await expect(freshness.assertWrite(input)).rejects.toThrow('Read the current target');
    await read();
    await expect(freshness.assertWrite(input)).resolves.toBeUndefined();
  });

  it('does not promote a provisional read when the child finishes during it', async () => {
    const reading = { ...input, tool: 'read', callId: 'call_race', barrierClear: false };
    await freshness.beginRead(reading);
    await freshness.observeRead({ ...reading, barrierClear: true });
    await expect(freshness.assertWrite(input)).rejects.toThrow('Read the current target');
  });

  it('rejects a file that changed during the read even with a clear barrier', async () => {
    const reading = { ...input, tool: 'read', callId: 'call_race', barrierClear: true };
    await freshness.beginRead(reading);
    await fs.writeFile(path.join(directory, 'source.txt'), 'modified during read');
    await freshness.observeRead(reading);
    await expect(freshness.assertWrite(input)).rejects.toThrow('Read the current target');
  });

  it('shares physical file identities across aliases, but not roots or restarts', async () => {
    await fs.symlink('source.txt', path.join(directory, 'alias.txt'));
    await read({ args: { filePath: 'alias.txt', offset: 1, limit: 2 } });
    await expect(freshness.assertWrite(input)).resolves.toBeUndefined();
    await expect(freshness.assertWrite({ ...input, rootSessionId: 'ses_other' })).rejects.toThrow();
    freshness = createParentReadFreshness();
    await expect(freshness.assertWrite(input)).rejects.toThrow();
  });

  it('allows new files but requires every existing patch target to be refreshed', async () => {
    await expect(freshness.assertWrite({ ...input, tool: 'write', args: { filePath: 'new.txt' } })).resolves.toBeUndefined();
    const patch = { ...input, tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: source.txt\n@@\n-original\n+modified\n*** End Patch' } };
    await expect(freshness.assertWrite(patch)).rejects.toThrow();
    await read();
    await expect(freshness.assertWrite(patch)).resolves.toBeUndefined();
    await expect(freshness.assertWrite({ ...input, args: {} })).rejects.toMatchObject({ reason: 'target_unresolved' });
  });

  it('keeps unknown fingerprints blocked and never treats an after hook alone as a read', async () => {
    await freshness.observeRead({ ...input, tool: 'read', callId: 'unregistered', barrierClear: true });
    await expect(freshness.assertWrite(input)).rejects.toThrow();
    await fs.truncate(path.join(directory, 'source.txt'), 8 * 1024 * 1024 + 1);
    await read();
    await expect(freshness.assertWrite(input)).rejects.toThrow();
  });
});
