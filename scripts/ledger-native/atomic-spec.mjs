// The shared specification of the atomic-file primitives (plan package L2):
// every case of the JavaScript's own test file that concerns
// writeFileAtomic, withCrossProcessFileLock and cleanupStaleAtomicFiles,
// restated as data, plus edge cases that test file does not reach. Each
// scenario runs against the JavaScript (the arm script beside this file) and
// against the Rust probe; results, error codes, file-system traces, progress,
// observations and the tree after every run must be equal once process ids,
// random identifiers and wall-clock times are masked. `expect` restates the
// original assertions and is checked on every arm.
//
// Shapes: a scenario is `{ name, source, steps }`; a step is `{ setup: [...] }`
// (write with `content` or `hex` bytes / symlink with `target` / mkdir /
// utimes / chmod; `<pid>` in a text becomes the arm's pid),
// `{ clock: { set | setToMtime | advance } }` or `{ run }`. A run names `op`
// (writeFileAtomic, lock, cleanup), `path`, `data`, `options`, where `now`
// and `wait` come from (`clock` or the real ones), `isAlive` (true, false or
// the real check), `signal: { abortAfter }`, `faults: [{ op, path?, nth?, code }]`,
// `alter: [{ op, path?, nth?, arg?, directory | content }]` (the call's
// argument becomes a directory or that text just before the call),
// `observe: [{ op, read: [argument], exists: [argument] }]` and `callback` steps
// (inspect, write, recordElapsed, throw, return). A failed run or call also
// records `failure`: Node's code, errno, syscall, path, dest and message.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JS_ARM = path.join(here, 'atomic-js-arm.mjs');

const ID = 'a'.repeat(32);
const lockText = (token, pid, createdAt) => JSON.stringify({ ownerToken: token, pid, createdAt });
const files = (tree) => tree.filter((entry) => entry.type === 'file');
const names = (tree) => tree.map((entry) => entry.path);
const ops = (run) => run.trace.map((entry) => entry.op);
const fsOps = (run) => run.trace.filter((entry) => !['now', 'wait', 'isAlive', 'randomToken', 'randomId', 'signal'].includes(entry.op));

/** Scenarios restated from the JavaScript's test file, by its test titles. */
export const RESTATED = [
  {
    name: 'write: private atomic replacement, no temporary left',
    source: 'fsyncs a private atomic replacement and leaves no temporary file',
    steps: [{ clock: { set: 1_700_000_000_000 } }, { run: { op: 'writeFileAtomic', path: 'records/one.json', data: '{"ok":true}\n', now: 'clock', options: { randomId: ID } } }],
    expect({ runs: [run], final }) {
      assert.equal(run.ok, true);
      const written = final.find((entry) => entry.path === 'records/one.json');
      assert.equal(written.content, '{"ok":true}\n');
      assert.equal(written.mode, 0o600);
      assert.deepEqual(names(final).filter((name) => name.includes('.tmp-')), []);
      assert.ok(ops(run).includes('handle.sync'));
    },
  },
  {
    name: 'cleanup: stale temporary removed, fresh one kept',
    source: 'cleans stale temporary files without touching fresh ones',
    steps: [
      { setup: [{ write: 'record.json.tmp-old', content: 'old' }, { write: 'record.json.tmp-new', content: 'new' }, { utimes: 'record.json.tmp-old', atime: 0, mtime: 0 }] },
      { clock: { set: 10_000 } },
      { run: { op: 'cleanup', path: 'record.json', now: 'clock', options: { staleAfterMs: 1_000 } } },
    ],
    expect({ runs: [run], final }) {
      assert.equal(run.value, 1);
      assert.deepEqual(names(final), ['record.json.tmp-new']);
      assert.equal(final[0].content, 'new');
    },
  },
  {
    name: 'write: a failed directory sync is refused, the bytes stay published',
    source: 'refuses unconfirmed replacement durability and preserves the published bytes',
    steps: [{ clock: { set: 5 } }, { run: { op: 'writeFileAtomic', path: 'record.json', data: '{"new":true}\n', now: 'clock', options: { randomId: ID }, faults: [{ op: 'handle.sync', path: '.', code: 'EIO' }] } }],
    expect({ runs: [run], final }) {
      assert.equal(run.error, 'EIO');
      assert.ok(run.trace.some((entry) => entry.op === 'handle.close' && entry.args[0] === '.'), 'the directory handle is closed');
      assert.deepEqual(names(final), ['record.json']);
      assert.equal(final[0].content, '{"new":true}\n');
    },
  },
  {
    name: 'lock: a private exclusive lock is created and released',
    source: 'creates and releases a private exclusive lock',
    steps: [{ run: { op: 'lock', path: 'project.lock', options: { randomToken: 'owner-a' }, callback: [{ inspect: 'project.lock' }] } }],
    expect({ pid, runs: [run], final }) {
      assert.equal(run.ok, true);
      const owner = JSON.parse(run.callback[0].content);
      assert.equal(owner.ownerToken, 'owner-a');
      assert.equal(owner.pid, pid);
      assert.equal(run.callback[0].mode, 0o600);
      assert.deepEqual(final, []);
    },
  },
  {
    name: 'lock: a dead owner is recovered at once, a live owner never stolen',
    source: 'recovers a dead owner immediately but never steals from a live owner',
    steps: [
      { setup: [{ write: 'project.lock', content: lockText('dead', 999_999, 0) }] },
      { run: { op: 'lock', path: 'project.lock', isAlive: false, options: { randomToken: 'new-owner' }, callback: [{ return: 'acquired' }] } },
      { setup: [{ write: 'project.lock', content: '{"ownerToken":"live","pid":<pid>,"createdAt":0}' }] },
      { clock: { set: 0 } },
      { run: { op: 'lock', path: 'project.lock', now: 'clock', wait: 'clock', isAlive: true, options: { timeoutMs: 10, retryMs: 5 }, callback: [{ return: 'never' }] } },
    ],
    expect({ runs: [recovered, refused], final }) {
      assert.equal(recovered.value, 'acquired');
      assert.equal(refused.error, 'LOCK_TIMEOUT');
      assert.equal(JSON.parse(final[0].content).ownerToken, 'live');
      assert.deepEqual(refused.trace.filter((entry) => entry.op === 'wait').map((entry) => entry.ms), [5, 5]);
    },
  },
  {
    name: 'lock: only a synced complete inode is linked; temporaries go after contention',
    source: 'publishes only a synced complete inode and cleans temporary files after contention',
    steps: [
      { run: { op: 'lock', path: 'atomic.lock', options: { randomToken: 'atomic-owner' }, observe: [{ op: 'link', read: [0], exists: [1] }], callback: [{ inspect: 'atomic.lock' }] } },
      { setup: [{ write: 'atomic.lock', content: '{"ownerToken":"other","pid":<pid>,"createdAt":0}' }] },
      { run: { op: 'lock', path: 'atomic.lock', options: { timeoutMs: 0 } } },
    ],
    expect({ runs: [first, second], final }) {
      const order = fsOps(first).map((entry) => entry.op);
      assert.ok(order.indexOf('handle.sync') < order.indexOf('link'), 'synced before the link');
      assert.equal(order.filter((op) => op === 'link').length, 1);
      assert.equal(JSON.parse(first.observations[0].read0).ownerToken, 'atomic-owner');
      assert.equal(first.observations[0].exists1, false);
      assert.equal(JSON.parse(first.callback[0].content).ownerToken, 'atomic-owner');
      assert.deepEqual(first.after, []);
      assert.equal(second.error, 'LOCK_TIMEOUT');
      assert.deepEqual(names(final), ['atomic.lock']);
    },
  },
  {
    name: 'lock: only unsupported hard links fall back to an exclusive create',
    source: 'only unsupported hard links allow exclusive-create fallback; permission and I/O errors propagate',
    steps: ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EIO', 'ENOSPC'].map((code) => ({
      run: { op: 'lock', path: 'fallback.lock', faults: [{ op: 'link', code }], callback: [{ return: 'entered' }] },
    })),
    expect({ runs }) {
      runs.forEach((run, index) => {
        if (index < 3) assert.equal(run.value, 'entered');
        else { assert.equal(run.ok, false); assert.equal(run.error, ['EPERM', 'EACCES', 'EIO', 'ENOSPC'][index - 3]); assert.deepEqual(run.callback, []); }
        assert.deepEqual(run.after, []);
      });
    },
  },
  {
    name: 'lock: a legacy malformed lock waits the default thirty seconds',
    source: 'legacy malformed mutation locks keep the default thirty-second threshold',
    steps: [
      { setup: [{ write: 'legacy.lock', content: '{' }] },
      { clock: { setToMtime: 'legacy.lock' } },
      { run: { op: 'lock', path: 'legacy.lock', now: 'clock', wait: 'clock', options: { timeoutMs: 45_000, retryMs: 1_000 }, callback: [{ recordElapsed: true }] } },
    ],
    expect({ runs: [run], final }) {
      assert.equal(run.ok, true);
      assert.equal(run.callback[0].elapsed, 30_000);
      assert.deepEqual(final, []);
    },
  },
  {
    name: 'lock: a fresh malformed lock is waited on, a stale one recovered',
    source: 'waits on fresh malformed locks and recovers stale malformed locks',
    steps: [
      { setup: [{ write: 'project.lock', content: 'partial' }] },
      { clock: { setToMtime: 'project.lock' } },
      { run: { op: 'lock', path: 'project.lock', now: 'clock', wait: 'clock', options: { timeoutMs: 5, retryMs: 5, malformedStaleMs: 100 }, callback: [{ return: 'never' }] } },
      { clock: { advance: 1_000 } },
      { run: { op: 'lock', path: 'project.lock', now: 'clock', options: { malformedStaleMs: 100, randomToken: 'replacement' }, callback: [{ return: 'recovered' }] } },
    ],
    expect({ runs: [waited, recovered] }) {
      assert.equal(waited.error, 'LOCK_TIMEOUT');
      assert.equal(waited.after[0].content, 'partial');
      assert.equal(recovered.value, 'recovered');
    },
  },
  {
    name: 'lock: release leaves a replacement with another token',
    source: 'does not unlink a replacement owned by a different token during release',
    steps: [{ run: { op: 'lock', path: 'project.lock', options: { randomToken: 'original' }, callback: [{ write: 'project.lock', content: '{"ownerToken":"replacement","pid":<pid>,"createdAt":1}' }] } }],
    expect({ runs: [run], final }) {
      assert.equal(run.ok, true);
      assert.equal(JSON.parse(final[0].content).ownerToken, 'replacement');
    },
  },
];

/**
 * Cases of the JavaScript's test file that are not restated, and why. Its
 * other ten cases are RESTATED above, one scenario each.
 */
export const NOT_RESTATED = [
  { source: 'Windows persistence uses constructor owners, identity-bound quarantine and guarded deletion', why: 'Windows paths (owner objects, launcher locks): out of scope for the Unix port' },
  { source: 'replaces a user-owned file synchronously, keeping its mode and leaving no temporary file', why: 'writeFileAtomicSync is not part of the port' },
  { source: 'keeps the old bytes and removes its temporary file when the synchronous replace fails', why: 'writeFileAtomicSync is not part of the port' },
  { source: 'follows a symlink, even a dangling one, and keeps the link', why: 'writeFileAtomicSync is not part of the port' },
  { source: 'quarantines partial JSON and continues with an empty read', why: 'readJsonGuarded is not part of the port' },
];

/** Edge cases the JavaScript's own tests do not reach; compared between arms. */
export const EXTRA = [
  { name: 'write: real clock and random identifier, progress reported', steps: [{ run: { op: 'writeFileAtomic', path: 'a/b/c.json', data: 'x' } }],
    expect({ runs: [run] }) { assert.equal(run.ok, true); assert.equal(run.progress.length, 18); } },
  { name: 'write: empty data, mode and directory mode', steps: [{ clock: { set: 7 } }, { run: { op: 'writeFileAtomic', path: 'd/e.json', data: '', now: 'clock', options: { randomId: ID, mode: 0o640, directoryMode: 0o750 } } }],
    expect({ final }) { assert.equal(final.find((entry) => entry.path === 'd/e.json').mode, 0o640); } },
  { name: 'write: stale temporaries are cleaned first', steps: [
    { setup: [{ write: 'r.json.tmp-1-2-x', content: 'old' }, { utimes: 'r.json.tmp-1-2-x', atime: 0, mtime: 0 }, { write: 'r.json.tmp-young', content: 'young' }, { mkdir: 'r.json.tmp-dir' }] },
    { clock: { set: 1_000_000 } },
    { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID, staleTmpAgeMs: 1_000 } } }],
  expect({ final }) { assert.deepEqual(names(final), ['r.json', 'r.json.tmp-dir', 'r.json.tmp-young']); } },
  { name: 'write: rename failure removes the temporary', steps: [{ clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID }, faults: [{ op: 'rename', code: 'EACCES' }] } }],
    expect({ runs: [run], final }) { assert.equal(run.error, 'EACCES'); assert.deepEqual(final, []); } },
  { name: 'write: exclusive open refused', steps: [{ clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID }, faults: [{ op: 'open', code: 'EEXIST' }] } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'EEXIST'); } },
  { name: 'write: a failed write closes and removes', steps: [{ clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID }, faults: [{ op: 'handle.writeFile', code: 'ENOSPC' }] } }],
    expect({ runs: [run], final }) { assert.equal(run.error, 'ENOSPC'); assert.deepEqual(final, []); } },
  { name: 'write: a failed close is retried once by the cleanup', steps: [{ clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID }, faults: [{ op: 'handle.close', nth: 1, code: 'EIO' }] } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'EIO'); assert.equal(ops(run).filter((op) => op === 'handle.close').length, 2); } },
  { name: 'write: chmod failure after the rename', steps: [{ clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'r.json', data: 'new', now: 'clock', options: { randomId: ID }, faults: [{ op: 'chmod', code: 'EPERM' }] } }],
    expect({ runs: [run], final }) { assert.equal(run.error, 'EPERM'); assert.deepEqual(names(final), ['r.json']); } },
  { name: 'write: the parent is a file', steps: [{ setup: [{ write: 'plain', content: '' }] }, { clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'plain/r.json', data: 'x', now: 'clock', options: { randomId: ID } } }],
    expect({ runs: [run] }) { assert.equal(run.ok, false); } },
  { name: 'cleanup: a missing directory removes nothing', steps: [{ run: { op: 'cleanup', path: 'missing/r.json' } }],
    expect({ runs: [run] }) { assert.equal(run.value, 0); } },
  { name: 'cleanup: a vanished candidate is skipped, another stat error is thrown', steps: [
    { setup: [{ write: 'r.json.tmp-a', content: '' }, { write: 'r.json.tmp-b', content: '' }, { utimes: 'r.json.tmp-a', atime: 0, mtime: 0 }, { utimes: 'r.json.tmp-b', atime: 0, mtime: 0 }] },
    { clock: { set: 1e15 } },
    { run: { op: 'cleanup', path: 'r.json', now: 'clock', faults: [{ op: 'stat', nth: 1, code: 'ENOENT' }] } },
    { setup: [{ write: 'r.json.tmp-c', content: '' }] },
    { run: { op: 'cleanup', path: 'r.json', now: 'clock', faults: [{ op: 'stat', code: 'EACCES' }] } },
    { run: { op: 'cleanup', path: 'r.json', now: 'clock', faults: [{ op: 'rm', code: 'EBUSY' }] } }],
  expect({ runs: [first, second, third] }) { assert.equal(first.value, 1); assert.equal(second.error, 'EACCES'); assert.equal(third.error, 'EBUSY'); } },
  { name: 'lock: the lock vanishes while it is read', steps: [{ run: { op: 'lock', path: 'p.lock', faults: [{ op: 'link', nth: 1, code: 'EEXIST' }, { op: 'readFile', nth: 1, code: 'ENOENT' }], callback: [{ return: 1 }] } }],
    expect({ runs: [run] }) { assert.equal(run.value, 1); assert.equal(run.trace.filter((entry) => entry.op === 'link').length, 2); } },
  { name: 'lock: an unreadable lock is an error', steps: [{ setup: [{ write: 'p.lock', content: 'x' }] }, { run: { op: 'lock', path: 'p.lock', faults: [{ op: 'readFile', nth: 1, code: 'EACCES' }] } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'EACCES'); } },
  { name: 'lock: a pid beyond 32 bits is dead to the real check', steps: [{ setup: [{ write: 'p.lock', content: lockText('big', 2_147_483_648, 0) }] }, { run: { op: 'lock', path: 'p.lock', callback: [{ return: 'won' }] } }],
    expect({ runs: [run] }) { assert.equal(run.value, 'won'); } },
  { name: 'lock: the real check keeps a live pid (this process)', steps: [{ setup: [{ write: 'p.lock', content: '{"ownerToken":"me","pid":<pid>,"createdAt":0}' }] }, { clock: { set: 0 } }, { run: { op: 'lock', path: 'p.lock', now: 'clock', wait: 'clock', options: { timeoutMs: 60, retryMs: 25 } } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'LOCK_TIMEOUT'); assert.deepEqual(run.trace.filter((entry) => entry.op === 'wait').map((entry) => entry.ms), [25, 25, 10]); } },
  { name: 'lock: retry and timeout bounds (retryMs 0, timeoutMs negative)', steps: [{ setup: [{ write: 'p.lock', content: lockText('x', 1, 0) }] }, { clock: { set: 0 } }, { run: { op: 'lock', path: 'p.lock', now: 'clock', wait: 'clock', isAlive: true, options: { timeoutMs: -5, retryMs: 0 } } }, { run: { op: 'lock', path: 'p.lock', now: 'clock', wait: 'clock', isAlive: true, options: { timeoutMs: 3, retryMs: 0 } } }],
    expect({ runs: [first, second] }) { assert.equal(first.error, 'LOCK_TIMEOUT'); assert.deepEqual(second.trace.filter((entry) => entry.op === 'wait').map((entry) => entry.ms), [1, 1, 1]); } },
  { name: 'lock: abort before publishing and before the callback', steps: [
    { run: { op: 'lock', path: 'p.lock', signal: { abortAfter: 0 } } },
    { run: { op: 'lock', path: 'p.lock', signal: { abortAfter: 1 }, callback: [{ return: 'no' }] } }],
  expect({ runs: [first, second], final }) { assert.equal(first.error, 'ABORT_ERR'); assert.equal(second.error, 'ABORT_ERR'); assert.deepEqual(final, []); } },
  { name: 'lock: a throwing callback still releases', steps: [{ run: { op: 'lock', path: 'p.lock', callback: [{ throw: 'CALLBACK_FAILED' }] } }],
    expect({ runs: [run], final }) { assert.equal(run.error, 'CALLBACK_FAILED'); assert.deepEqual(final, []); } },
  { name: 'lock: a failed release replaces the result', steps: [{ run: { op: 'lock', path: 'p.lock', faults: [{ op: 'unlink', code: 'EACCES' }], callback: [{ return: 'value' }] } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'EACCES'); } },
  { name: 'lock: a temporary that cannot be removed fails the publication', steps: [{ run: { op: 'lock', path: 'p.lock', faults: [{ op: 'rm', nth: 1, code: 'EIO' }] } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'EIO'); } },
  { name: 'lock: a JSON lock that is not an owner is malformed', steps: [{ setup: [{ write: 'p.lock', content: '[1]' }, { utimes: 'p.lock', atime: 0, mtime: 0 }] }, { run: { op: 'lock', path: 'p.lock', callback: [{ return: 'ok' }] } }],
    expect({ runs: [run] }) { assert.equal(run.value, 'ok'); } },
  { name: 'lock: a dead owner replaced in between is not removed', steps: [{ setup: [{ write: 'p.lock', content: lockText('dead', 999_999, 0) }] }, { clock: { set: 0 } },
    { run: { op: 'lock', path: 'p.lock', now: 'clock', wait: 'clock', isAlive: false, options: { timeoutMs: 0 }, faults: [{ op: 'unlink', nth: 1, code: 'ENOENT' }] } }],
  expect({ runs: [run] }) { assert.ok(run.ok === true || run.ok === false); } },
  { name: 'lock: the lock path is a directory', steps: [{ setup: [{ mkdir: 'p.lock' }] }, { run: { op: 'lock', path: 'p.lock' } }],
    expect({ runs: [run] }) { assert.equal(run.ok, false); } },
  { name: 'lock: nested directories are created with 0o700', steps: [{ run: { op: 'lock', path: 'a/b/c.lock', callback: [{ inspect: 'a/b/c.lock' }] } }],
    expect({ runs: [run], final }) { assert.equal(run.ok, true); assert.equal(final.find((entry) => entry.path === 'a').mode, 0o700); } },
  { name: 'cleanup: the default 24-hour cutoff removes a temporary exactly that old; only <name>.tmp- names count', steps: [
    { setup: [
      { write: 'r.json.tmp-edge', content: 'edge' }, { utimes: 'r.json.tmp-edge', atime: 1_000, mtime: 1_000 },
      { write: 'r.json.tmp-young', content: 'young' }, { utimes: 'r.json.tmp-young', atime: 1_000, mtime: 1_000.5 },
      { write: 'r.json.tmpX', content: 'x' }, { utimes: 'r.json.tmpX', atime: 0, mtime: 0 },
      { write: 'r.json.tmp', content: 'bare' }, { utimes: 'r.json.tmp', atime: 0, mtime: 0 },
      { write: 'other.json.tmp-1', content: 'other' }, { utimes: 'other.json.tmp-1', atime: 0, mtime: 0 }] },
    { clock: { set: 1_000_000 + 24 * 60 * 60 * 1000 } },
    { run: { op: 'cleanup', path: 'r.json', now: 'clock' } }],
  expect({ runs: [run], final }) { assert.equal(run.value, 1); assert.deepEqual(names(final), ['other.json.tmp-1', 'r.json.tmp', 'r.json.tmp-young', 'r.json.tmpX']); } },
  { name: 'cleanup: a candidate that became a directory fails with ERR_FS_EISDIR', steps: [
    { setup: [{ write: 'r.json.tmp-a', content: '' }, { utimes: 'r.json.tmp-a', atime: 0, mtime: 0 }] }, { clock: { set: 1e15 } },
    { run: { op: 'cleanup', path: 'r.json', now: 'clock', alter: [{ op: 'rm', directory: true }] } }],
  expect({ runs: [run], final }) { assert.equal(run.error, 'ERR_FS_EISDIR'); assert.equal(run.failure.syscall, 'rm'); assert.equal(final[0].type, 'dir'); } },
  { name: 'write: a file in the middle of the path is ENOTDIR from mkdir', steps: [{ setup: [{ write: 'plain', content: '' }] }, { clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'plain/x/r.json', data: 'x', now: 'clock', options: { randomId: ID } } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'ENOTDIR'); assert.equal(run.failure.syscall, 'mkdir'); assert.equal(run.failure.path, 'plain/x'); } },
  { name: 'write: a dangling link in the middle of the path is ENOTDIR naming the link', steps: [{ setup: [{ symlink: 'dangling', target: 'nowhere' }] }, { clock: { set: 1 } }, { run: { op: 'writeFileAtomic', path: 'dangling/x/r.json', data: 'x', now: 'clock', options: { randomId: ID } } }],
    expect({ runs: [run] }) { assert.equal(run.error, 'ENOTDIR'); assert.equal(run.failure.path, 'dangling'); } },
  { name: 'lock: a pid this user may not signal (EPERM) is alive, so it is waited on and never stolen', steps: [
    { setup: [{ write: 'p.lock', content: lockText('init', 1, 0) }] }, { clock: { set: 0 } },
    { run: { op: 'lock', path: 'p.lock', now: 'clock', wait: 'clock', options: { timeoutMs: 50, retryMs: 25 }, callback: [{ return: 'stolen' }] } }],
  expect({ runs: [run], final }) {
    assert.equal(run.error, 'LOCK_TIMEOUT');
    assert.deepEqual(run.trace.filter((entry) => entry.op === 'isAlive').map((entry) => entry.result), [true, true, true]);
    assert.equal(JSON.parse(final[0].content).pid, 1);
  } },
  { name: 'lock: a lock file is read as lossy UTF-8 (an ill-formed token is still an owner, ill-formed text is malformed)', steps: [
    { setup: [{ write: 'p.lock', hex: `${Buffer.from('{"ownerToken":"').toString('hex')}ff${Buffer.from('","pid":999999,"createdAt":0}').toString('hex')}` }] },
    { run: { op: 'lock', path: 'p.lock', isAlive: false, callback: [{ return: 'won' }] } },
    { setup: [{ write: 'q.lock', hex: 'fffe7b' }, { utimes: 'q.lock', atime: 0, mtime: 0 }] },
    { run: { op: 'lock', path: 'q.lock', callback: [{ return: 'recovered' }] } }],
  expect({ runs: [dead, malformed], final }) { assert.equal(dead.value, 'won'); assert.equal(malformed.value, 'recovered'); assert.deepEqual(final, []); } },
  { name: 'lock: a dead owner rewritten with the same token before the re-read is removed (the token decides, not the bytes)', steps: [
    { setup: [{ write: 'p.lock', content: lockText('dead', 999_999, 0) }] },
    { run: { op: 'lock', path: 'p.lock', isAlive: false, alter: [{ op: 'readFile', nth: 2, content: lockText('dead', 999_999, 5) }], callback: [{ return: 'won' }] } }],
  expect({ runs: [run] }) {
    assert.equal(run.value, 'won');
    assert.equal(run.trace.filter((entry) => entry.op === 'readFile').length, 3, 'inspect, re-read, release');
    assert.equal(run.trace.filter((entry) => entry.op === 'unlink').length, 2, 'the dead lock, then the own one');
  } },
];

export const SCENARIOS = [...RESTATED, ...EXTRA];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;
const MS_TIME = /(?<![0-9])1[0-9]{12}(?:\.[0-9]+)?(?![0-9])/g;

/** Masks what differs between two processes: the pid, random names and wall-clock times. */
export function normalize(output) {
  const { pid } = output;
  const text = (value) => value
    .replaceAll(`.tmp-${pid}-`, '.tmp-<pid>-')
    .replaceAll(`"pid":${pid}`, '"pid":"<pid>"')
    .replace(UUID, '<uuid>')
    .replace(HEX32, (match) => (match === ID ? match : '<hex>'))
    .replace(MS_TIME, '<time>');
  const walk = (value, key) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, name === 'pid' && item === pid ? '<pid>' : walk(item, name)]));
    }
    return key === 'value' && typeof value === 'number' && value > 1e12 ? '<time>' : value;
  };
  const { pid: _, ...rest } = output;
  return walk(rest);
}

/** A private directory under `parent`, removed by the returned function. */
export function scenarioRoot(parent, name) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, `${name}-`));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

function runArm(command, args, scenario, root, env = {}) {
  const { expect: _, ...data } = scenario;
  const result = spawnSync(command, args, { input: JSON.stringify({ scenario: data, root }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Runs a scenario on the JavaScript arm in a child process: of `runtime`
 * (`{ command, env }`, the differential tests pass the reference runtime),
 * or of this Node.
 */
export const runJavaScript = (scenario, root, runtime = { command: process.execPath, env: {} }) => runArm(runtime.command, [JS_ARM], scenario, root, runtime.env);

/** Runs a scenario on the Rust probe. */
export const runRust = (scenario, root, probe) => runArm(probe, ['scenario'], scenario, root);
