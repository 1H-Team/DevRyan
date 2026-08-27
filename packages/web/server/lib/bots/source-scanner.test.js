import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBotSourceScanner,
  normalizeBotSourceExclusions,
  publicBotSourceScan,
  wipeBotSourceScan,
} from './source-scanner.js';

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-library-scan-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('Production Bot Library source scanner', () => {
  it('scans only selected bounded text while rejecting secrets, .git, binaries, and exclusions', async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'ignored'));
    await fs.writeFile(path.join(root, 'guide.md'), '# Reviewed guide\n');
    await fs.writeFile(path.join(root, '.env'), 'API_KEY=definitely-secret-value\n');
    await fs.writeFile(path.join(root, 'token.txt'), 'access_token=abcdefghijklmnopqrstuv\n');
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(root, 'ignored', 'skip.txt'), 'skip me');
    const scanner = createBotSourceScanner();
    const scan = await scanner.scan({
      selectedPath: root,
      exclusions: { paths: ['ignored'] },
    });

    expect(publicBotSourceScan(scan)).toMatchObject({
      fileCount: 1,
      totalBytes: Buffer.byteLength('# Reviewed guide\n'),
      files: [{ relativePath: 'guide.md', contentType: 'text/markdown' }],
    });
    expect(scan.findings.map((entry) => entry.code).sort()).toEqual([
      'git_metadata_rejected',
      'secret_content_rejected',
      'secret_file_rejected',
      'unsupported_binary_rejected',
    ]);
    expect(JSON.stringify(publicBotSourceScan(scan))).not.toContain(root);
    wipeBotSourceScan(scan);
    expect(scan.files[0].bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects traversal, selected symlinks, and symlink escape attempts', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await fs.writeFile(path.join(outside, 'outside.md'), 'outside');
    await fs.symlink(path.join(outside, 'outside.md'), path.join(root, 'escape.md'));
    const scanner = createBotSourceScanner();

    await expect(scanner.scan({ selectedPath: `${root}/../${path.basename(outside)}` }))
      .rejects.toMatchObject({ code: 'bot_library_path_invalid' });
    await expect(scanner.scan({ selectedPath: path.join(root, 'escape.md') }))
      .rejects.toMatchObject({ code: 'bot_library_symlink_forbidden' });

    const scan = await scanner.scan({ selectedPath: root });
    expect(scan.files).toHaveLength(0);
    expect(scan.findings).toContainEqual(expect.objectContaining({
      code: 'symlink_rejected',
      relativePath: 'escape.md',
    }));
  });

  it('rejects invalid exclusion shapes and bounded-scan overflow deterministically', async () => {
    expect(() => normalizeBotSourceExclusions({ paths: ['../secret'] }))
      .toThrow(expect.objectContaining({ code: 'bot_library_source_invalid' }));
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'one.md'), 'one');
    await fs.writeFile(path.join(root, 'two.md'), 'two');
    const scanner = createBotSourceScanner({ maximumFiles: 1 });
    await expect(scanner.scan({ selectedPath: root }))
      .rejects.toMatchObject({ code: 'bot_library_scan_too_large', statusCode: 413 });
  });
});
