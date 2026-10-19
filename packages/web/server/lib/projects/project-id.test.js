import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('resolves the canonical active-project plan directory under the data root in use', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-plans-home-'));
    const projectPath = '/Users/example/Repositories/Test/';
    const plans = 'projects/path_L1VzZXJzL2V4YW1wbGUvUmVwb3NpdG9yaWVzL1Rlc3Q/plans';
    try {
      expect(await resolveProjectPlansDirectory(projectPath, home)).toBe(path.join(home, '.config', 'devryan', plans));
      // Before the startup migration the pre-rename folder still holds the plans.
      fs.mkdirSync(path.join(home, '.config', 'openchamber'), { recursive: true });
      expect(await resolveProjectPlansDirectory(projectPath, home)).toBe(path.join(home, '.config', 'openchamber', plans));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns no directory for an incomplete identity', async () => {
    expect(await resolveProjectPlansDirectory('', '/Users/example')).toBe('');
    expect(await resolveProjectPlansDirectory('/Users/example/project', '')).toBe('');
  });
});
