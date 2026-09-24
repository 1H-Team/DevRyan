import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractDirectory = path.join(root, 'packages/web/server/lib/opencode/companion');
const contract = JSON.parse(await fs.readFile(path.join(contractDirectory, 'manifest.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const patch = path.join(contractDirectory, contract.patch);
if (hash(await fs.readFile(patch)) !== contract.patchSha256) throw new Error('Companion patch digest mismatch');
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
if (args.some((arg, i) => i % 2 === 0 && !['--source', '--output'].includes(arg)) || args.length % 2) {
  throw new Error('Usage: node scripts/build-revert-runtime.mjs [--source prepared-checkout] [--output directory]');
}
const platform = `${process.platform}-${process.arch}`, extension = process.platform === 'win32' ? '.exe' : '';
const output = path.resolve(option('--output') || path.join(root, 'packages/web/runtime', platform));
const source = path.resolve(option('--source') || path.join(root, '.cache/revert-runtime-source', contract.baseCommit));
const run = (command, args, cwd = root, env = process.env, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true });
  let text = ''; child.stdout?.on('data', (chunk) => { text += chunk; });
  child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(text.trim()) : reject(new Error(`${command} exited ${code}`)));
});
const upstreamPlatform = platform.replace(/^win32-/, 'windows-');
// A companion build depends only on the pinned source, reviewed patch, runtime
// version, platform and Bun. Reuse one that already passed its upstream
// typecheck and tests; the DevRyan acceptance fixture below always runs.
const bunVersion = await run('bun', ['--version'], root, process.env, true);
const companionKey = hash(JSON.stringify({ version: 1, baseCommit: contract.baseCommit, patchSha256: contract.patchSha256,
  upstreamVersion: contract.upstreamVersion, companionVersion: contract.companionVersion, platform, bunVersion }));
const companionCache = path.join(root, '.cache/revert-runtime-companion', platform, companionKey);
const cachedCompanion = async () => {
  if (option('--source')) return null;
  try {
    const record = JSON.parse(await fs.readFile(path.join(companionCache, 'companion-build.json'), 'utf8'));
    const binary = path.join(companionCache, `opencode${extension}`);
    if (record.key !== companionKey || record.sha256 !== hash(await fs.readFile(binary))) return null;
    return binary;
  } catch { return null; }
};
let companionBinary = await cachedCompanion();
if (companionBinary) console.log(`Reusing verified companion build ${companionKey}`);
else companionBinary = await buildCompanion();
// Cache warming on the default branch stops here; releases restore that entry.
if (process.env.DEVRYAN_REVERT_COMPANION_ONLY === '1') {
  console.log(`Verified companion build: ${companionBinary}`);
  process.exit(0);
}

async function buildCompanion() {
  if (!option('--source')) {
    try { await fs.access(path.join(source, '.git')); }
    catch {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await run('git', ['clone', '--filter=blob:none', '--no-checkout', contract.upstream, source]);
      await run('git', ['checkout', '--detach', contract.baseCommit], source);
    }
  }
  if (await run('git', ['rev-parse', 'HEAD'], source, process.env, true) !== contract.baseCommit) throw new Error('Companion checkout is not the pinned source');
  const dirty = await run('git', ['status', '--porcelain'], source, process.env, true);
  if (!dirty) await run('git', ['apply', patch], source);
  // Never reset a checkout. Check every patched file, including newly created files.
  await run('git', ['apply', '--reverse', '--check', patch], source);
  for (const [file, digest] of Object.entries(contract.files)) {
    if (hash(await fs.readFile(path.join(source, file))) !== digest) throw new Error(`Companion source differs: ${file}`);
  }
  const changed = await run('git', ['diff', '--name-only', 'HEAD'], source, process.env, true);
  const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], source, process.env, true);
  if ([...changed.split('\n'), ...untracked.split('\n')].some((file) => file && !Object.hasOwn(contract.files, file))) throw new Error('Companion checkout has unreviewed changes');
  await run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], source);
  await run('bun', ['typecheck'], path.join(source, 'packages/opencode'));
  // HTTP/SQLite integration fixtures need a bounded budget on loaded native builders.
  await run('bun', ['test', '--timeout', '30000', 'test/session/revert-compact.test.ts', 'test/server/workspace-routing.test.ts',
    'test/server/httpapi-session.test.ts', 'test/session/retention-gate.test.ts', 'test/session/execution-payload.test.ts',
    'test/session/execution-browser.test.ts', 'test/session/devryan-execution.test.ts'], path.join(source, 'packages/opencode'));
  await run('bun', ['run', 'script/build.ts', '--single', '--skip-install', '--skip-embed-web-ui'], path.join(source, 'packages/opencode'),
    // Report the plain upstream version: companion identity is a separate
    // capability-bearing record (companion.json), never a version suffix.
    { ...process.env, OPENCODE_VERSION: contract.upstreamVersion, OPENCODE_CHANNEL: 'devryan' });
  const built = path.join(source, 'packages/opencode/dist', `opencode-${upstreamPlatform}`, 'bin', `opencode${extension}`);
  if (option('--source')) return built;
  // Publish the cache entry atomically so an interrupted build is never reused.
  const staged = `${companionCache}.${process.pid}.tmp`;
  await fs.rm(staged, { recursive: true, force: true });
  await fs.mkdir(staged, { recursive: true });
  await fs.copyFile(built, path.join(staged, `opencode${extension}`));
  await fs.writeFile(path.join(staged, 'companion-build.json'),
    JSON.stringify({ key: companionKey, sha256: hash(await fs.readFile(built)) }, null, 2) + '\n');
  await fs.rm(companionCache, { recursive: true, force: true });
  await fs.rename(staged, companionCache);
  return path.join(companionCache, `opencode${extension}`);
}
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'companion.json'), { force: true });
await run(process.execPath, ['scripts/build-session-execution.mjs', output, '--verify']);
const binary = `DevRyan-opencode-${platform}${extension}`;
// Replace the inode: overwriting a previously executed Mach-O can retain stale
// kernel code-signature pages and make a valid new build die with SIGKILL.
const stagedBinary = path.join(output, `${binary}.${process.pid}.tmp`);
try {
  await fs.copyFile(companionBinary, stagedBinary);
  await fs.chmod(stagedBinary, 0o755);
  if (process.platform === 'darwin') {
    await run('codesign', ['--force', '--sign', '-', stagedBinary]);
    await run('codesign', ['--verify', '--strict', stagedBinary]);
  }
  await fs.rename(stagedBinary, path.join(output, binary));
} finally { await fs.rm(stagedBinary, { force: true }); }
await run(process.execPath, ['scripts/verify-concurrent-revert-execution.mjs'], root, { ...process.env,
  DEVRYAN_TEST_OPENCODE_BINARY: path.join(output, binary),
  DEVRYAN_TEST_EXECUTION_LAUNCHER: path.join(output, `DevRyan-execution-${platform}${extension}`) });
const manifest = { ...contract.capability, acceptance: true, companionVersion: contract.companionVersion,
  upstreamVersion: contract.upstreamVersion, baseCommit: contract.baseCommit,
  patchSha256: contract.patchSha256, binary, platform: process.platform, arch: process.arch,
  sha256: hash(await fs.readFile(path.join(output, binary))) };
await fs.writeFile(path.join(output, 'companion.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Verified Revert runtime: ${output}`);
