import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { listAntigravityAccountsPaths } from './auth.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('discovers canonical and historical overlay accounts in that order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-quota-overlays-'));
  roots.push(root);
  const canonical = path.join(root, '.devryan', 'runtime-agent-overlays');
  const legacy = path.join(root, '.openchamber', 'runtime-agent-overlays');
  fs.mkdirSync(path.join(canonical, 'current'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'previous'), { recursive: true });
  expect(listAntigravityAccountsPaths({ overlayRoots: [canonical, legacy] }).slice(2)).toEqual([
    path.join(canonical, 'current', 'antigravity-accounts.json'),
    path.join(legacy, 'previous', 'antigravity-accounts.json'),
  ]);
});
