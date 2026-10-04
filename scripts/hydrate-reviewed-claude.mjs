import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVIEWED_CLAUDE_ASSETS } from '../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveUrl = 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.251.tgz';
const archiveIntegrity = 'Qr5oMGVrOUyatsMlK0361OSnr3C785QBFIDoaiHMpaJ/nu/Ji2ccwI7nv0o54q3v3Y+zU9xbtEmcGxPRcR9ptA==';
const binarySize = 197171680;

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest(encoding);
}

async function verifyBinary(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size !== binarySize || await digest(file, 'sha256', 'hex') !== REVIEWED_CLAUDE_ASSETS.claude.sha256) {
    throw new Error('Reviewed Claude binary integrity mismatch');
  }
}

export async function hydrateReviewedClaude({ repository = root, fetchImpl = fetch } = {}) {
  const directory = path.join(repository, 'packages/web/runtime/reviewed-inputs/claude-1.8.0/assets');
  const destination = path.join(directory, REVIEWED_CLAUDE_ASSETS.claude.path);
  try {
    await verifyBinary(destination);
    return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(directory, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(directory, '.claude-download-'));
  try {
    const response = await fetchImpl(archiveUrl, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('Reviewed Claude archive download failed');
    const archive = path.join(scratch, 'claude.tgz');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));
    if (await digest(archive, 'sha512', 'base64') !== archiveIntegrity) throw new Error('Reviewed Claude archive integrity mismatch');
    const binary = path.join(scratch, 'claude');
    const child = spawn('tar', ['-xOzf', archive, 'package/claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error('Reviewed Claude archive extraction failed')));
    });
    await Promise.all([pipeline(child.stdout, createWriteStream(binary, { flags: 'wx' })), completion]);
    await verifyBinary(binary);
    await fs.chmod(binary, REVIEWED_CLAUDE_ASSETS.claude.mode);
    await fs.link(binary, destination);
    return destination;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 2) throw new Error('hydrate-reviewed-claude accepts no arguments');
  console.log(await hydrateReviewedClaude());
}
