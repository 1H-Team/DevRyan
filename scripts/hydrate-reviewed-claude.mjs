import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVIEWED_CLAUDE_ASSETS } from '../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
import { claudeArchiveURL, downloadClaudeInstallation, extractClaudeArchive, readClaudeDownload } from '../packages/web/server/lib/opencode/runtime-host/managed-claude-installation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REVIEWED_CLAUDE_SIZE = 267956720;
async function verifyBinary(file) {
  const stat = await fs.lstat(file), hash = createHash('sha256');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== REVIEWED_CLAUDE_SIZE) throw new Error('Reviewed Claude binary integrity mismatch');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (hash.digest('hex') !== REVIEWED_CLAUDE_ASSETS.claude.sha256) throw new Error('Reviewed Claude binary integrity mismatch');
}

/** Portable build inputs are pinned bytes; macOS additionally verifies and probes the publisher binary. */
export async function downloadPinnedClaude(directory, fetchImpl = fetch) {
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'packages/web/runtime/reviewed-inputs/claude-1.8.0/provenance.json'), 'utf8'));
  const archive = await readClaudeDownload(claudeArchiveURL(REVIEWED_CLAUDE_ASSETS.claude.version), 160 * 1024 * 1024, { fetchImpl });
  const binary = extractClaudeArchive(archive, provenance.nativeExecutable.archiveIntegrity);
  const file = path.join(directory, REVIEWED_CLAUDE_ASSETS.claude.path);
  await fs.writeFile(file, binary, { flag: 'wx', mode: REVIEWED_CLAUDE_ASSETS.claude.mode });
  await verifyBinary(file);
}

export async function hydrateReviewedClaude({ repository = root, fetchImpl = fetch } = {}) {
  const directory = path.join(repository, 'packages/web/runtime/reviewed-inputs/claude-1.8.0/assets');
  const destination = path.join(directory, REVIEWED_CLAUDE_ASSETS.claude.path);
  try { await verifyBinary(destination); return destination; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'devryan-claude-hydrate-'));
  try {
    if (process.platform === 'darwin') await downloadClaudeInstallation({ directory: scratch, version: REVIEWED_CLAUDE_ASSETS.claude.version, fetchImpl });
    else await downloadPinnedClaude(scratch, fetchImpl);
    const binary = path.join(scratch, REVIEWED_CLAUDE_ASSETS.claude.path);
    await verifyBinary(binary);
    await fs.copyFile(binary, destination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destination, REVIEWED_CLAUDE_ASSETS.claude.mode);
    return destination;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 2) throw new Error('hydrate-reviewed-claude accepts no arguments');
  console.log(await hydrateReviewedClaude());
}
