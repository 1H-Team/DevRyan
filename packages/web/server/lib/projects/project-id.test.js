import { describe, expect, it } from 'vitest';

import {
  createProjectIdFromPath,
  resolveProjectPlansDirectory,
} from './project-id.js';

describe('project identity', () => {
  it('derives stable project IDs from normalized paths', () => {
    expect(createProjectIdFromPath('/Users/example/Repositories/Test/')).toBe(
      'path_L1VzZXJzL2V4YW1wbGUvUmVwb3NpdG9yaWVzL1Rlc3Q',
    );
  });

  it('resolves the canonical active-project plan directory', async () => {
    expect(await resolveProjectPlansDirectory(
      '/Users/zoubair/Repositories/onehealth-connector/',
      '/Users/zoubair/',
    )).toBe(
      '/Users/zoubair/.config/openchamber/projects/'
      + 'path_L1VzZXJzL3pvdWJhaXIvUmVwb3NpdG9yaWVzL29uZWhlYWx0aC1jb25uZWN0b3I/plans',
    );
  });

  it('returns no directory for an incomplete identity', async () => {
    expect(await resolveProjectPlansDirectory('', '/Users/example')).toBe('');
    expect(await resolveProjectPlansDirectory('/Users/example/project', '')).toBe('');
  });
});
