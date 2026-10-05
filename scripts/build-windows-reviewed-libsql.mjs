import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = '55bee86d1c284f1ddf2b9e280e870d2b6cef884a';
const inputs = Object.freeze({
  'Cargo.toml': 'cf729f40413e3131258e98579ab760b2e75238255cd56729ebb65b4f410ea953',
  'Cargo.lock': '897f93398893ce805b389b482ddf7555b75365a5f48a2e345703f21c1c58d74e',
  'rust-toolchain.toml': 'df9ff8a9ca1dcbadc9b912fa46d0e99d20f2e3695a4fa4c009df5f02b44bece8',
  'package.json': '9b38bb06405f07a6c7458bd3e821e3bebae0b19b4c6cd8b08607f36916228e50',
});

export function assertWindowsBinaryArchitecture(bytes, arch) {
  assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Windows binary header missing');
  const offset = bytes.readUInt32LE(60);
  assert.ok(offset >= 64 && offset + 6 <= bytes.length && bytes.toString('binary', offset, offset + 4) === 'PE\0\0', 'Windows PE header invalid');
  assert.ok(arch === 'x64' || arch === 'arm64', 'Windows architecture unsupported');
  assert.equal(bytes.readUInt16LE(offset + 4), arch === 'arm64' ? 0xaa64 : 0x8664, 'Windows binary architecture differs from host');
}

const smoke = String.raw`
const assert=require('node:assert/strict'),native=require(process.argv[1]);
const db=native.databaseOpen(':memory:','','aes256cbc','',0,'');
try{
 native.databaseExecSync.call(db,'CREATE TABLE probe(value TEXT); BEGIN; INSERT INTO probe VALUES (\'Windows 日本語\'); COMMIT; BEGIN; INSERT INTO probe VALUES (\'discard\'); ROLLBACK;');
 const row=native.statementGet.call(native.databasePrepareSync.call(db,'SELECT value, count(*) AS count FROM probe'),[]);
 assert.equal(row.value,'Windows 日本語'); assert.equal(row.count,1);
 assert.equal(native.databaseInTransaction(db),false);
}finally{native.databaseClose.call(db);}
console.log(JSON.stringify({status:'passed',platform:process.platform,arch:process.arch,runtime:process.versions.bun?'bun':'node',version:process.versions.bun??process.versions.node}));
`;

async function build() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('windows_libsql_native_host_required');
  const source = path.join(repository, '.cache/libsql-source');
  const output = path.join(repository, '.cache/windows-native', process.arch);
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  const toolchain = `1.85.1-${target}`;
  await fs.mkdir(output, { recursive: true });
  const report = { schema: 1, status: 'failed', version: '0.5.29', sourceCommit: commit, target, toolchain, inputs,
    scope: 'Existing pinned libsql source build and native ABI smoke only; no controller, confinement or runtime admission acceptance' };
  const verifySource = async () => {
    report.stage = 'source-path';
    assert.equal(await fs.realpath(source), source);
    report.stage = 'source-commit';
    const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: source });
    assert.equal(head.stdout.trim(), commit);
    report.stage = 'source-clean';
    const status = await execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source });
    assert.equal(status.stdout, '');
    report.inputSha256 = {};
    for (const [name, expected] of Object.entries(inputs)) {
      report.stage = `source-bytes-${name}`;
      const actual = hash(await fs.readFile(path.join(source, name)));
      report.inputSha256[name] = actual;
      assert.equal(actual, expected);
    }
  };
  try {
    await verifySource();
    report.stage = 'compiler-identity';
    const compiler = (await execute('rustc', [`+${toolchain}`, '--version', '--verbose'])).stdout.replace(/\r\n/g, '\n');
    assert.ok(compiler.includes('release: 1.85.1\n') && compiler.includes(`host: ${target}\n`));
    report.compiler = compiler.trim();
    const compilerPath = (await execute('rustup', ['which', '--toolchain', toolchain, 'rustc'])).stdout.trim();
    const compilerBytes = await fs.readFile(compilerPath); assertWindowsBinaryArchitecture(compilerBytes, process.arch);
    report.compilerSha256 = hash(compilerBytes);
    const platformKeys = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'INCLUDE', 'LIB', 'LIBPATH', 'RUSTUP_HOME', 'CARGO_HOME'];
    const env = Object.fromEntries(platformKeys.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
    env.CARGO_TARGET_DIR = path.join(repository, '.cache', `sql-${process.arch}`, 'target');
    report.stage = 'source-build';
    try {
      const result = await execute('cargo', [`+${toolchain}`, 'build', '--locked', '--release', '--target', target], { cwd: source, env, timeout: 1200000, maxBuffer: 4 * 1024 * 1024 });
      await fs.writeFile(path.join(output, 'libsql-build.log'), result.stdout + result.stderr, { flag: 'wx' });
    } catch (error) {
      await fs.writeFile(path.join(output, 'libsql-build.log'), String(error.stdout ?? '') + String(error.stderr ?? ''), { flag: 'wx' });
      throw new Error('windows_libsql_source_build_failed');
    }
    const binary = path.join(env.CARGO_TARGET_DIR, target, 'release/libsql_js.dll');
    report.stage = 'binary-identity';
    const bytes = await fs.readFile(binary); assertWindowsBinaryArchitecture(bytes, process.arch);
    const staged = path.join(output, `DevRyan-libsql-win32-${process.arch}.node`);
    await fs.writeFile(staged, bytes, { flag: 'wx' });
    report.binary = path.basename(staged); report.sha256 = hash(bytes); report.smokes = [];
    for (const executable of [process.execPath, 'bun']) {
      report.stage = executable === process.execPath ? 'node-abi' : 'bun-abi';
      const result = await execute(executable, ['-e', smoke, staged], { cwd: repository, env, timeout: 30000, maxBuffer: 65536 });
      const value = JSON.parse(result.stdout.trim()); assert.equal(value.status, 'passed'); assert.equal(value.platform, 'win32'); assert.equal(value.arch, process.arch);
      if (value.runtime === 'bun') assert.equal(value.version, '1.3.14');
      report.smokes.push(value);
    }
    await verifySource(); report.stage = 'complete'; report.status = 'asset-candidate-passed';
  } catch (error) { report.errorCode = /^windows_libsql_[a-z_]+$/.test(error.message) ? error.message : 'windows_libsql_build_or_identity_failed'; }
  await fs.writeFile(path.join(output, 'libsql-source-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, errorCode: report.errorCode, output }));
  if (report.status !== 'asset-candidate-passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
