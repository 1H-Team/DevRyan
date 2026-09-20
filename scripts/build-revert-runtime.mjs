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
  'test/server/httpapi-session.test.ts'], path.join(source, 'packages/opencode'));
await run('bun', ['run', 'script/build.ts', '--single', '--skip-install', '--skip-embed-web-ui'], path.join(source, 'packages/opencode'),
  { ...process.env, OPENCODE_VERSION: contract.runtimeVersion, OPENCODE_CHANNEL: 'devryan' });
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'companion.json'), { force: true });
await run(process.execPath, ['scripts/build-session-execution.mjs', output, '--verify']);
const binary = `DevRyan-opencode-${platform}${extension}`;
const upstreamPlatform = platform.replace(/^win32-/, 'windows-');
await fs.copyFile(path.join(source, 'packages/opencode/dist', `opencode-${upstreamPlatform}`, 'bin', `opencode${extension}`), path.join(output, binary));
await fs.chmod(path.join(output, binary), 0o755);
const fixture = path.join(root, '.cache/revert-runtime-context');
await fs.mkdir(fixture, { recursive: true });
for (const name of ['package.json', 'bun.lock']) await fs.copyFile(path.join(root, 'tests/fixtures/revert-runtime', name), path.join(fixture, name));
await run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], fixture);
await run(process.execPath, ['scripts/verify-concurrent-revert-execution.mjs'], root, { ...process.env,
  DEVRYAN_TEST_CONTEXT_MODE_CONFIG: fixture,
  DEVRYAN_TEST_OPENCODE_BINARY: path.join(output, binary),
  DEVRYAN_TEST_EXECUTION_LAUNCHER: path.join(output, `DevRyan-execution-${platform}${extension}`) });
const manifest = { ...contract.capability, acceptance: true, version: contract.runtimeVersion, baseCommit: contract.baseCommit,
  patchSha256: contract.patchSha256, binary, platform: process.platform, arch: process.arch,
  sha256: hash(await fs.readFile(path.join(output, binary))) };
await fs.writeFile(path.join(output, 'companion.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Verified Revert runtime: ${output}`);
