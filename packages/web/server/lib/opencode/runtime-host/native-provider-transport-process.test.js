import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { createNativeProviderProcess } from './native-provider-process.js';
import { startReadOnlySessionExecution } from '../../../../../harness-runtime/lib/session-execution.js';
const syntheticTransports = new WeakSet();
vi.mock('./native-claude-process-incarnation.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, captureClaudeTransportIncarnation(child, executable) {
    // Only the existing mocked read-only transports use fixture incarnations;
    // provider boot still attests its real supervised native runtime process.
    if (syntheticTransports.has(child)) return Promise.resolve({ version: 1, pid: child.pid, hostId: 'a'.repeat(64),
      bootId: '12345678-1234-1234-1234-123456789abc', startId: '12345', startIdKind: 'linux-proc-start-ticks' });
    return original.captureClaudeTransportIncarnation(child, executable);
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  return { ...original, spawn(command, args, options) {
    const env = { ...options.env }; delete env.DYLD_INSERT_LIBRARIES;
    return original.spawn(command, args, { ...options, env });
  } };
});
vi.mock('../../../../../harness-runtime/lib/session-execution.js', () => ({ startReadOnlySessionExecution: vi.fn() }));
vi.mock('./native-process.js', () => ({ prepareSupervisedController: async boot => ({
  profile: path.join(boot.globals.state, 'profile'), receiptPath: path.join(boot.globals.state, 'receipt'),
  arguments: [path.join(boot.globals.state, 'supervisor.mjs')],
}) }));
vi.mock('../parent-death-watchdog.js', () => ({ startParentDeathWatchdog: () => ({ dispose() {} }) }));
vi.mock('../managed-process-registry.js', () => ({ reapOrphanedManagedOpenCodeProcesses: async () => ({ kept: [], reaped: [] }),
  registerManagedOpenCodeProcess() {}, unregisterManagedOpenCodeProcess() {},
}));
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test.each(['killAndWaitForExit', 'close'])('provider private channel handles batched transport frames and %s waits both confined child receipts', async stop => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-provider-transport-'))), runs = [];
  let owner;
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp'].map(key => [key, path.join(root, key)]));
  await Promise.all(Object.values(globals).map(p => fs.mkdir(p)));
  const asset = path.join(root, 'owned-claude'); await fs.writeFile(asset, 'owned');
  const boot = { protocol: 1, type: 'provider-boot', provider: 'anthropic', instanceID: randomUUID(), buildId: 'a'.repeat(64), requestAuthorization: 'b'.repeat(64), globals,
    profiles: [{ id: 'selected', type: 'oauth-token', credentialPolicy: 'access-only', claudeConfigDir: globals.home }],
    assets: { claude: { path: asset, sha256: createHash('sha256').update('owned').digest('hex') }, libsql: { path: asset, sha256: 'c'.repeat(64) } },
    transport: { launcher: process.execPath, storage: globals.tmp, directories: [globals.repos] } };
  const inputs = ['d', 'e'].map((letter, index) => ({ protocol: 1, type: 'claude-transport', action: 'start', id: randomUUID(),
    attemptID: letter.repeat(64), sessionID: `ses_${index}`, directory: globals.repos, profileID: 'selected', args: ['--print'] }));
  await fs.writeFile(path.join(globals.state, 'profile'), 'private');
  await fs.writeFile(path.join(globals.state, 'supervisor.mjs'), `
import {spawn} from 'node:child_process';
const worker=spawn(process.execPath,[${JSON.stringify(path.join(globals.state, 'provider.mjs'))}],{stdio:'inherit',detached:true});
process.on('SIGTERM',()=>worker.kill('SIGTERM'));
worker.on('close',code=>process.exit(code ?? 125));
`);
  await fs.writeFile(path.join(globals.state, 'provider.mjs'), `
import fs from 'node:fs'; import readline from 'node:readline';
let boot; const starts=${JSON.stringify(inputs)}; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
function exit(){fs.writeFileSync(${JSON.stringify(path.join(globals.state, 'receipt'))},JSON.stringify({terminated:true,confined:true,cancelled:true,exitCode:0}));process.exit(0);}
process.on('SIGTERM',exit);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.type==='provider-boot'){if(x.ownerIncarnation.pid!==process.pid)throw Error('fixture owner mismatch');boot=x;send({protocol:1,type:'provider-bound',instanceID:boot.instanceID,buildId:boot.buildId,url:'http://127.0.0.1:3456/',port:3456,health:'healthy'});return;}
 if(x.type==='claude-transport-reply'){
  if(x.action==='started'){const f={protocol:1,type:'claude-transport',action:'stdin',id:x.id,attemptID:x.attemptID,chunk:Buffer.alloc(16384,120).toString('base64')};process.stdout.write(Array.from({length:5},(_,index)=>JSON.stringify({...f,sequence:index+1})+'\\n').join(''));}return;
 }
 if(x.action==='health'){send({protocol:1,id:x.id,ok:true,result:{health:'healthy'}});process.stdout.write(starts.map(x=>JSON.stringify(x)+'\\n').join(''));return;}
 send({protocol:1,id:x.id,ok:true,result:null});if(x.action==='close')exit();
});
`);
  startReadOnlySessionExecution.mockImplementation(async options => {
    const settled = defer(), writes = [], child = { pid: 200 + runs.length, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, done) { writes.push(chunk.length); done(); } }) };
    const run = { options, child, writes, settled, cancelled: false }; runs.push(run);
    syntheticTransports.add(child);
    options.signal.addEventListener('abort', () => { run.cancelled = true; }, { once: true });
    return { child, result: settled.promise, cancel() { run.cancelled = true; } };
  });
  try {
    owner = await createNativeProviderProcess({ binary: process.execPath, cwd: root, environment: { PATH: process.env.PATH }, boot,
      databasePath: path.join(root, 'db'), supervisor: { launcher: process.execPath },
      resolveCredential: async () => ({ profileID: 'selected', accessToken: 'dummy-access', fingerprint: 'f'.repeat(64), expiresAt: Date.now() + 3600000 }) });
    for (const input of inputs) await owner.authorizeAttempt({ attemptID: input.attemptID, sessionID: input.sessionID, directory: input.directory });
    await owner.health(); await vi.waitFor(() => expect(runs).toHaveLength(2));
    await vi.waitFor(() => expect(runs.map(run => run.writes.length)).toEqual([5, 5]));
    expect(owner.isFailed()).toBe(false);
    let finished = false; const death = owner[stop]().then(value => { finished = true; return value; });
    await vi.waitFor(() => expect(runs.every(run => run.cancelled)).toBe(true));
    runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await Promise.resolve(); expect(finished).toBe(false);
    runs[1].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 });
    expect((await death).receipt).toMatchObject({ terminated: true, confined: true });
  } finally {
    for (const run of runs) run.settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 });
    await owner?.killAndWaitForExit().catch(() => {}); await fs.rm(root, { recursive: true, force: true });
  }
});
