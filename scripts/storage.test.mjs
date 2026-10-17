import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheGrowthFailure, newCacheEntries, snapshotCache } from './cache-guard.mjs';
import { auditCache, isPinnedRun, storageMain } from './storage.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, content = 'x', ageHours = 48) => {
    const file = path.join(root, '.cache', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const when = new Date(Date.now() - ageHours * 3_600_000);
    for (let target = file; target !== path.join(root, '.cache'); target = path.dirname(target)) fs.utimesSync(target, when, when);
  };
  return { root, put };
}

test('clean previews, then deletes disposable entries and keeps build caches, pins, recent work and young sessions', (t) => {
  const { root, put } = fixture(t);
  put('qa/web-chat-old/log.txt', 'a'.repeat(4096));
  put('qa/live-provider-handoff-x/storage-retention.json', JSON.stringify({ pinned: true }));
  put('qa/pinned-run/run.json', JSON.stringify({ pinned: true }));
  put('qa/running-now/log.txt', 'x', 0);
  put('v2-validation/package-abc/payload.bin', 'b'.repeat(8192));
  put('stray.log');
  put('sessions/2026-09-01-old/notes.md', 'x', 24 * 40);
  put('sessions/2026-10-15-recent/notes.md', 'x', 24);
  put('eslint/cache.json');
  put('worktrees/feature/file.txt');
  fs.symlinkSync(os.tmpdir(), path.join(root, '.cache/qa/link'));

  const removed = (audit) => audit.removals.map((row) => row.path).sort();
  const expected = ['.cache/qa/web-chat-old', '.cache/sessions/2026-09-01-old', '.cache/stray.log', '.cache/v2-validation/package-abc'];
  assert.deepEqual(removed(auditCache(root)), expected);

  const lines = [];
  assert.equal(storageMain(['clean'], root, (line) => lines.push(line)), 0);
  assert.match(lines[0], /^Would delete 4 entries/);
  assert.ok(fs.existsSync(path.join(root, '.cache/qa/web-chat-old')), 'preview deletes nothing');

  assert.equal(storageMain(['clean', '--apply'], root, () => {}), 0);
  for (const gone of expected) assert.equal(fs.existsSync(path.join(root, gone)), false, gone);
  assert.equal(fs.existsSync(path.join(root, '.cache/v2-validation')), false, 'emptied family folder is removed');
  for (const kept of ['qa/live-provider-handoff-x', 'qa/pinned-run', 'qa/running-now', 'qa/link', 'sessions/2026-10-15-recent', 'eslint/cache.json', 'worktrees/feature/file.txt']) {
    assert.ok(fs.existsSync(path.join(root, '.cache', kept)), kept);
  }
  assert.ok(fs.existsSync(os.tmpdir()), 'symlink target untouched');
  assert.equal(isPinnedRun(path.join(root, '.cache/qa/live-provider-handoff-x')), true);
});

test('report sizes families and the CLI rejects unknown commands and flags', (t) => {
  const { root, put } = fixture(t);
  put('perf/run-1/data.bin', 'c'.repeat(10_000));
  const lines = [];
  assert.equal(storageMain(['report'], root, (line) => lines.push(line)), 0);
  assert.match(lines[0], /^\.cache total .*; reclaimable/);
  assert.ok(lines.some((line) => line.endsWith('.cache/perf')));
  assert.equal(storageMain(['report', '--apply'], root, () => {}), 2);
  assert.equal(storageMain(['clean', '--force'], root, () => {}), 2);
  assert.equal(storageMain(['prune'], root, () => {}), 2);
});

test('cache guard names new scratch and ignores kept build caches', (t) => {
  const { root, put } = fixture(t);
  put('qa/existing/log.txt');
  const before = snapshotCache(root);
  put('eslint/new-cache.json');
  put('sessions/2026-10-16-notes/a.md');
  assert.equal(cacheGrowthFailure(root, before), null);
  fs.mkdirSync(path.join(root, '.cache/empty-family/projects/nested'), { recursive: true });
  assert.equal(cacheGrowthFailure(root, before), null, 'empty folders are not scratch');
  put('qa/new-run/log.txt');
  put('test-fixtures/a/b.txt');
  assert.deepEqual(newCacheEntries(before, snapshotCache(root)), ['qa/new-run', 'test-fixtures']);
  const report = cacheGrowthFailure(root, before);
  assert.match(report, /left 2 new entries in \.cache\/:\n- \.cache\/qa\/new-run \(.+\)\n {4}qa\/new-run\/log\.txt\n- \.cache\/test-fixtures \(.+\)\n {4}test-fixtures\/a\/b\.txt/);
});
