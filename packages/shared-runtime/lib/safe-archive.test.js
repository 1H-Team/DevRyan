import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import {
  ArchiveRejectionError,
  downloadArchive,
  installSkillArchive,
  preflightSkillArchive,
} from './safe-archive.js';

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fs.promises.rm(target, { recursive: true, force: true })));
});

async function makeTempDir() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shared-archive-test-'));
  cleanup.push(dir);
  return dir;
}

function makeArchive(files = { 'SKILL.md': '# Example\n' }) {
  const zip = new AdmZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(contents));
  }
  return zip.toBuffer();
}

function expectArchiveCode(action, code) {
  expect(action).toThrow(ArchiveRejectionError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('downloadArchive', () => {
  test('rejects an oversized declared length before consuming the body', async () => {
    let consumed = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '6' }),
      body: {
        async *[Symbol.asyncIterator]() {
          consumed = true;
          yield new Uint8Array([1]);
        },
        async cancel() {},
      },
    });

    await expect(downloadArchive('https://clawdhub.com/archive.zip', {
      fetchImpl,
      maxArchiveBytes: 5,
    })).rejects.toMatchObject({ code: 'ARCHIVE_DOWNLOAD_TOO_LARGE' });
    expect(consumed).toBe(false);
  });

  test('reads a response incrementally and enforces the compressed byte cap', async () => {
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }));

    await expect(downloadArchive('https://clawdhub.com/archive.zip', {
      fetchImpl,
      maxArchiveBytes: 5,
    })).rejects.toMatchObject({ code: 'ARCHIVE_DOWNLOAD_TOO_LARGE' });
  });

  test('enforces the streamed cap when content length is missing or malformed', async () => {
    for (const contentLength of [null, 'not-a-number', '2']) {
      const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
        headers: contentLength === null ? {} : { 'content-length': contentLength },
      });
      await expect(downloadArchive('https://clawdhub.com/archive.zip', {
        fetchImpl,
        maxArchiveBytes: 5,
      })).rejects.toMatchObject({ code: 'ARCHIVE_DOWNLOAD_TOO_LARGE' });
    }
  });

  test('aborts a stalled download at the configured timeout', async () => {
    const fetchImpl = async (_url, init) => new Promise((_resolve, rejectPromise) => {
      init.signal.addEventListener('abort', () => rejectPromise(init.signal.reason), { once: true });
    });
    await expect(downloadArchive('https://clawdhub.com/archive.zip', {
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'ARCHIVE_DOWNLOAD_TIMEOUT' });
  });

  test('reports a timeout when the response body stalls after headers arrive', async () => {
    const fetchImpl = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
    }));
    await expect(downloadArchive('https://clawdhub.com/archive.zip', {
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'ARCHIVE_DOWNLOAD_TIMEOUT' });
  });

  test('rejects cross-origin, non-HTTPS redirects', async () => {
    const fetchImpl = async () => new Response(null, {
      status: 302,
      headers: { location: 'http://untrusted.example/archive.zip' },
    });

    await expect(downloadArchive('https://clawdhub.com/archive.zip', { fetchImpl }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' });
  });

  test('rejects invalid redirect destinations and unapproved reported response origins', async () => {
    const invalidRedirect = async () => new Response(null, {
      status: 302,
      headers: { location: 'https://[' },
    });
    await expect(downloadArchive('https://clawdhub.com/archive.zip', { fetchImpl: invalidRedirect }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' });

    const unapprovedResponse = async () => ({
      ok: true,
      status: 200,
      url: 'https://untrusted.example/archive.zip',
      headers: new Headers(),
      body: null,
    });
    await expect(downloadArchive('https://clawdhub.com/archive.zip', { fetchImpl: unapprovedResponse }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' });
  });

  test('allows an explicitly approved HTTPS redirect origin', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.clawdhub.com/archive.zip' },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    };

    const result = await downloadArchive('https://clawdhub.com/archive.zip', {
      fetchImpl,
      allowedOrigins: ['https://cdn.clawdhub.com'],
    });
    expect(result).toEqual(Buffer.from([1, 2, 3]));
    expect(calls).toHaveLength(2);
  });
});

describe('preflightSkillArchive', () => {
  test('accepts a bounded regular skill archive', () => {
    const result = preflightSkillArchive(makeArchive({
      'SKILL.md': '# Skill\n',
      'scripts/run.js': 'export {};\n',
    }));
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['SKILL.md', 'scripts/run.js']);
  });

  test('rejects traversal and absolute paths', () => {
    for (const unsafeName of ['../escape', '/absolute', 'C:/drive', '\\\\server\\share']) {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from('# Skill'));
      const entry = zip.addFile('safe', Buffer.from('x'));
      entry.entryName = unsafeName;
      expectArchiveCode(() => preflightSkillArchive(zip.toBuffer()), 'ARCHIVE_INVALID_PATH');
    }
  });

  test('rejects empty, NUL, overlong, and over-deep paths', () => {
    for (const unsafeName of [
      '',
      'bad\0name',
      `${'a'.repeat(513)}`,
      `${Array.from({ length: 33 }, () => 'nested').join('/')}/file`,
    ]) {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from('# Skill'));
      const entry = zip.addFile('safe', Buffer.from('x'));
      entry.entryName = unsafeName;
      expectArchiveCode(() => preflightSkillArchive(zip.toBuffer()), 'ARCHIVE_INVALID_PATH');
    }
  });

  test('rejects malformed UTF-8 entry names', () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# Skill'));
    const malformed = zip.addFile('bad', Buffer.from('x'));
    malformed.rawEntryName[0] = 0xc3;
    malformed.rawEntryName[1] = 0x28;
    expectArchiveCode(() => preflightSkillArchive(zip.toBuffer()), 'ARCHIVE_INVALID_PATH');
  });

  test('rejects case collisions and file-directory conflicts', () => {
    const caseZip = new AdmZip();
    caseZip.addFile('SKILL.md', Buffer.from('# Skill'));
    caseZip.addFile('Readme.md', Buffer.from('one'));
    caseZip.addFile('README.md', Buffer.from('two'));
    expectArchiveCode(() => preflightSkillArchive(caseZip.toBuffer()), 'ARCHIVE_PATH_COLLISION');

    const conflictZip = new AdmZip();
    conflictZip.addFile('SKILL.md', Buffer.from('# Skill'));
    conflictZip.addFile('scripts', Buffer.from('file'));
    conflictZip.addFile('scripts/run.js', Buffer.from('nested'));
    expectArchiveCode(() => preflightSkillArchive(conflictZip.toBuffer()), 'ARCHIVE_PATH_COLLISION');
  });

  test('rejects encrypted and Unix special-file entries', () => {
    const encryptedZip = new AdmZip(makeArchive());
    encryptedZip.getEntry('SKILL.md').header.flags |= 0x1;
    expectArchiveCode(() => preflightSkillArchive(encryptedZip.toBuffer()), 'ARCHIVE_UNSAFE_ENTRY');

    const linkZip = new AdmZip();
    linkZip.addFile('SKILL.md', Buffer.from('# Skill'));
    const link = linkZip.addFile('link', Buffer.from('target'));
    link.header.made = 0x0314;
    link.header.attr = (0xa1ff << 16) >>> 0;
    expectArchiveCode(() => preflightSkillArchive(linkZip.toBuffer()), 'ARCHIVE_UNSAFE_ENTRY');
  });

  test('rejects a missing root manifest and declared size limits', () => {
    expectArchiveCode(() => preflightSkillArchive(makeArchive({ 'nested/SKILL.md': '# Nested' })), 'ARCHIVE_MISSING_SKILL_FILE');
    expectArchiveCode(
      () => preflightSkillArchive(makeArchive({ 'SKILL.md': '12345' }), { maxFileBytes: 4 }),
      'ARCHIVE_SIZE_LIMIT',
    );
  });

  test('rejects excessive entry and total declared sizes', () => {
    expectArchiveCode(
      () => preflightSkillArchive(makeArchive({ 'SKILL.md': '# Skill', 'one.txt': '1' }), { maxEntries: 1 }),
      'ARCHIVE_ENTRY_LIMIT',
    );
    expectArchiveCode(
      () => preflightSkillArchive(makeArchive({ 'SKILL.md': '1234', 'one.txt': '1234' }), {
        maxFileBytes: 8,
        maxTotalBytes: 7,
      }),
      'ARCHIVE_SIZE_LIMIT',
    );
  });

  test('rejects corrupt and truncated ZIP data', () => {
    const valid = makeArchive();
    for (const corrupt of [Buffer.from('not a zip'), valid.subarray(0, Math.floor(valid.length / 2))]) {
      expectArchiveCode(() => preflightSkillArchive(corrupt), 'ARCHIVE_CORRUPT');
    }
  });
});

describe('installSkillArchive', () => {
  test('extracts into a sibling staging directory and installs an audited tree', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    const result = await installSkillArchive({
      archiveBuffer: makeArchive({ 'SKILL.md': '# Skill', 'scripts/run.sh': 'exit 0\n' }),
      targetDir,
    });

    expect(await fs.promises.readFile(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Skill');
    expect(result.files).toBe(2);
    expect((await fs.promises.readdir(parent)).filter((name) => name.startsWith('.example.'))).toEqual([]);
  });

  test('does not leave staging data when the root manifest is missing', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    await expect(installSkillArchive({
      archiveBuffer: makeArchive({ 'nested/SKILL.md': '# Nested' }),
      targetDir,
    })).rejects.toMatchObject({ code: 'ARCHIVE_MISSING_SKILL_FILE' });
    expect(await fs.promises.readdir(parent)).toEqual([]);
  });

  test('audits actual expanded bytes and cleans staging after rejection', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    await expect(installSkillArchive({
      archiveBuffer: makeArchive({ 'SKILL.md': 'x', 'one.txt': 'y' }),
      targetDir,
      limits: { maxFileBytes: 100, maxTotalBytes: 100 },
      fsOps: {
        writeFile(destination, data, options) {
          return fs.promises.writeFile(destination, Buffer.concat([data, Buffer.alloc(60)]), options);
        },
      },
    })).rejects.toMatchObject({ code: 'ARCHIVE_SIZE_LIMIT' });
    expect(await fs.promises.readdir(parent)).toEqual([]);
  });

  test('requires explicit replacement approval', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    await fs.promises.mkdir(targetDir);
    await fs.promises.writeFile(path.join(targetDir, 'SKILL.md'), '# Old');

    await expect(installSkillArchive({ archiveBuffer: makeArchive(), targetDir }))
      .rejects.toThrow('replacement was not approved');
    expect(await fs.promises.readFile(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Old');
  });

  test('restores the previous installation when commit fails', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    await fs.promises.mkdir(targetDir);
    await fs.promises.writeFile(path.join(targetDir, 'SKILL.md'), '# Old');
    let renameCalls = 0;

    await expect(installSkillArchive({
      archiveBuffer: makeArchive({ 'SKILL.md': '# New' }),
      targetDir,
      replace: true,
      fsOps: {
        async rename(source, destination) {
          renameCalls += 1;
          if (renameCalls === 2) {
            const error = new Error('injected commit failure');
            error.code = 'EACCES';
            throw error;
          }
          return fs.promises.rename(source, destination);
        },
      },
    })).rejects.toThrow('could not be committed');

    expect(await fs.promises.readFile(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Old');
    expect((await fs.promises.readdir(parent)).filter((name) => name.startsWith('.example.'))).toEqual([]);
  });

  test('uses a copied sibling staging tree when a rename reports EXDEV', async () => {
    const parent = await makeTempDir();
    const targetDir = path.join(parent, 'example');
    let injected = false;
    const result = await installSkillArchive({
      archiveBuffer: makeArchive({ 'SKILL.md': '# Copied' }),
      targetDir,
      fsOps: {
        async rename(source, destination) {
          if (!injected && source.includes('.example.staging-')) {
            injected = true;
            const error = new Error('cross-device');
            error.code = 'EXDEV';
            throw error;
          }
          return fs.promises.rename(source, destination);
        },
      },
    });

    expect(injected).toBe(true);
    expect(result.files).toBe(1);
    expect(await fs.promises.readFile(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# Copied');
    expect((await fs.promises.readdir(parent)).filter((name) => name.startsWith('.example.'))).toEqual([]);
  });
});
