// Fixture projects for the ledger dual run. Content comes from a seeded
// generator, so every twin of a fixture holds the same bytes; the Git history
// is committed with a fixed identity and date, so it is the same too.
import { execFileSync } from 'node:child_process';
import { constants as fsConstants, cpSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedGitEnvironment } from './dual-run-snapshot.mjs';

/** Deterministic PRNG (mulberry32). */
export function generator(seed) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (limit) => Math.floor(next() * limit);
  const words = ['const', 'value', 'return', 'ledger', 'publish', 'revert', 'lease', 'view', 'tree', 'blob', 'commit', 'index', 'await', 'async', 'function'];
  const line = (index) => `${'  '.repeat(int(3))}${words[int(words.length)]} ${words[int(words.length)]}_${index} = ${int(100000)};`;
  const text = (lines) => `${Array.from({ length: lines }, (_, index) => line(index)).join('\n')}\n`;
  const bytes = (length) => Buffer.from(Array.from({ length }, () => int(256)));
  return { next, int, text, bytes };
}

const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'Dual Run', GIT_AUTHOR_EMAIL: 'dual-run@example.invalid', GIT_COMMITTER_NAME: 'Dual Run',
  GIT_COMMITTER_EMAIL: 'dual-run@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
// Fixture Git reads no configuration, hooks or templates of the machine's
// owner (dual-run-snapshot.mjs isolatedGitEnvironment), whatever process builds it.
export const gitIn = (directory, args) => execFileSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { env: { ...isolatedGitEnvironment(), ...GIT_IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] });

export const NON_ASCII_TEXT = 'Grüße aus Zürich: café, naïve, 漢字かな交じり, emoji 🚀✨, combining é, RTL שלום.\n';

/**
 * A project of mixed kinds. `size`: 'tiny' (about 20 entries, the self-test),
 * 'small' (about 60) or 'full' (a few hundred, plus one text file past the
 * ledger's 8 MiB text limit).
 */
export async function writeProject(directory, { size = 'full', seed = 20261111 } = {}) {
  const g = generator(seed);
  const count = { full: 260, small: 40, tiny: 6 }[size];
  if (!count) throw new TypeError(`unknown fixture size ${size}`);
  await fs.mkdir(directory, { recursive: true });
  gitIn(directory, ['init', '--quiet', '--template=', '-b', 'main']);
  const write = async (relative, data, mode) => {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, mode ? { mode } : undefined);
    if (mode) await fs.chmod(file, mode);
  };
  for (let index = 0; index < count; index += 1) {
    await write(`src/m${index % 13}/f${index}.js`, g.text(3 + g.int(40)));
  }
  for (let index = 0; index < Math.ceil(count / 20); index += 1) {
    await write(`docs/note-${index}.md`, `# Note ${index}\n\n${NON_ASCII_TEXT.repeat(1 + index)}`);
    await write(`assets/blob-${index}.bin`, Buffer.concat([Buffer.from([0, 0xff, 0]), g.bytes(512 + g.int(4096))]));
  }
  await write('docs/ünïcödé-名前.txt', NON_ASCII_TEXT);
  await write('empty.txt', '');
  await write('no-newline.txt', 'last line without newline');
  await write('crlf.txt', 'one\r\ntwo\r\n');
  await write('tools/run.sh', '#!/bin/sh\necho dual-run\n', 0o755);
  await write('.gitignore', 'ignored/\n*.log\n');
  await write('ignored/skip.txt', 'ignored by git\n');
  await write('debug.log', 'ignored log\n');
  await fs.mkdir(path.join(directory, 'links'), { recursive: true });
  await fs.symlink('../src/m0/f0.js', path.join(directory, 'links', 'to-file'));
  await fs.symlink('../docs', path.join(directory, 'links', 'to-dir'));
  await fs.symlink('../missing/target', path.join(directory, 'links', 'dangling'));
  if (size === 'full') {
    // Past GRANULAR_TEXT_BYTES (8 MiB): stored whole, never as text runs.
    const block = g.text(400);
    const large = Buffer.alloc(8 * 1024 * 1024 + 4096);
    for (let offset = 0; offset < large.length; offset += block.length) large.write(block, offset, 'latin1');
    await write('big/large.txt', large);
  }
  gitIn(directory, ['add', '-A']);
  gitIn(directory, ['commit', '--quiet', '-m', 'fixture']);
  return directory;
}

/** Twin of a directory: same bytes, modes, link targets and times (clones where APFS allows). */
export function cloneDirectory(source, target) {
  cpSync(source, target, { recursive: true, mode: fsConstants.COPYFILE_FICLONE, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
}
