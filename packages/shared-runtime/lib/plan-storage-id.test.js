import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolvePlanProjectStorageId } from './plan-storage-id.js';

describe('plan project storage directory', () => {
  test('preserves all previously writable compatibility IDs', async () => {
    for (const id of ['', 'path_L3JlcG8', `path_${'a'.repeat(250)}`]) {
      expect(await resolvePlanProjectStorageId(id)).toBe(id);
    }
  });

  test('uses the full identity digest beyond the filesystem component limit', async () => {
    const id = `path_${'a'.repeat(251)}`;
    const key = await resolvePlanProjectStorageId(id);
    expect(key).toBe(`path_sha256_${createHash('sha256').update(id).digest('hex')}`);
    expect(key.length).toBeLessThanOrEqual(255);
    expect(await resolvePlanProjectStorageId(`${id}b`)).not.toBe(key);
  });
});
