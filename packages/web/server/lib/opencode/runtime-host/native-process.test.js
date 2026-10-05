import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createNativeControllerProcess, prepareSupervisedController } from './native-process.js';
import {parseNativeBoot,parseNativeCommand,parseNativeReply} from './native-process-protocol.js';

const fixture = async (action, bootReply) => {
  const base = path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'native-process-'));
  const binary = path.join(root, 'DevRyan-protocol-fixture');
  await fs.writeFile(binary, `#!/usr/bin/env node
import readline from 'node:readline';
let boot, held;
const send = value => process.stdout.write(JSON.stringify({protocol:1,...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
  const input=JSON.parse(line);
  if(input.type==='boot') {boot=input;send(${bootReply ? JSON.stringify(bootReply) : "{type:'bound',bundleID:boot.bundleID,instanceID:boot.instanceID,buildId:boot.buildId,url:'http://127.0.0.1:54321',port:54321,catalog:{asserted:true},migration:{v1:'not-needed'}}"});return;}
  if(input.action==='hold'){held=input;return;}
  if(input.action==='release'){send({id:held.id,ok:true,result:'settled'});send({id:input.id,ok:true});return;}
  if(input.action==='open'){process.stderr.write('private-output native_observation_');setTimeout(()=>{process.stderr.write('unavailable private-output native_observation_unavailable');send({id:input.id,ok:true});},10);return;}
  if(input.action==='close'){send({id:input.id,ok:true});process.exit(0);}
  send({id:input.id,ok:true});
});
`, { mode: 0o700 });
  const globals = Object.fromEntries(['home','config','data','state','cache','bin','log','repos','tmp'].map(key => [key,path.join(root,key)]));
  for(const directory of Object.values(globals)) await fs.mkdir(directory);
  const boot = {protocol:1,type:'boot',bundleID:'test',instanceID:randomUUID(),buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),databasePath:path.join(root,'db'),globals,
    directory:root,locations:[{directory:root,readRoots:[root],protectedRoots:[]}],bridge:{url:'http://127.0.0.1:1',token:'c'.repeat(64)},httpToken:'d'.repeat(64),configuration:{},reviewedPlugins:[],
    migrationEvidence:{path:path.join(root,'migration.json'),sha256:'e'.repeat(64)},catalogRequirements:{agents:[],plugins:[],tools:[],models:[]}};
  let controller;
  try { await action({root,boot,binary,start:async options => (controller=await createNativeControllerProcess({binary,cwd:root,boot,environment:{PATH:process.env.PATH},timeoutMs:3000,...options}))}); }
  finally { if(controller && !controller.hasExited()) await controller.killForRecovery(); await fs.rm(root,{recursive:true,force:true}); }
};

test('typed catalog diagnostics preserve exact route intent without making availability a startup gate',async()=>{
 await fixture(async({boot})=>{
  const selection={source:{kind:'councillor',id:'council',index:1},providerID:'cursor-acp',modelID:'composer-2.5',variant:'high'};
  expect(parseNativeBoot({...boot,catalogRequirements:{...boot.catalogRequirements,selections:[selection]}}).catalogRequirements.selections).toEqual([selection]);
  const row={...selection,directory:boot.directory,status:'unknown',reason:'catalog_unavailable'};
  const bound={protocol:1,type:'bound',bundleID:boot.bundleID,instanceID:boot.instanceID,buildId:boot.buildId,url:'http://127.0.0.1:54321',port:54321,catalog:{asserted:true,availability:{selections:[row]}},migration:{v1:'not-needed'}};
  expect(parseNativeReply(bound).catalog.availability.selections).toEqual([row]);
  for(const changed of [{status:'available'},{reason:'unsupported'},{variant:undefined},{source:{kind:'invented'}},{directory:'relative'}])
   expect(()=>parseNativeReply({...bound,catalog:{...bound.catalog,availability:{selections:[{...row,...changed}]}}})).toThrow('Invalid native process protocol');
 });
});

test('a pre-bound startup refusal preserves only its safe code and still awaits owned exit', async () => {
  for (const [reply, code] of [
    [{ id: 'boot', ok: false, error: { code: 'native_catalog_mismatch', status: 503, message: 'private detail' } }, 'native_catalog_mismatch'],
    [{ id: 'boot', ok: false, error: { code: 'private detail', status: 503, message: 'private detail' } }, 'native_process_failed'],
    [{ id: 'unrelated', ok: false, error: { code: 'native_catalog_mismatch', status: 503, message: 'private detail' } }, 'native_process_response_uncorrelated'],
    [{ id: 'boot', ok: true, result: 'unbound success' }, 'native_process_response_uncorrelated'],
  ]) await fixture(async ({ start, root }) => {
    let recovered = false;
    await expect(start({ afterExit: async () => { recovered = true; } })).rejects.toMatchObject({ code, message: code });
    expect(recovered).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'state/managed-opencode-processes.json'), 'utf8')).processes).toEqual([]);
  }, reply);
});

test('native process correlates concurrent commands and close awaits actual exit and owner recovery', async () => {
  await fixture(async ({root,start}) => {
    let recovered=false;
    const controller=await start({afterExit:async()=>{await new Promise(resolve=>setTimeout(resolve,20));recovered=true;}});
    expect(controller.bound.catalog.asserted).toBe(true);
    const hold=controller.call({action:'hold',sessionID:'ses_test'});
    await controller.call({action:'release',sessionID:'ses_test'});
    expect(await hold).toBe('settled');
    const closing=controller.close();expect(controller.close()).toBe(closing);
    expect((await closing).code).toBe(0);expect(recovered).toBe(true);expect(controller.hasExited()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root,'state/managed-opencode-processes.json'),'utf8')).processes).toEqual([]);
  });
});

test('a timed out native operation refuses reuse until the owned child has exited and recovery settles', async () => {
  await fixture(async ({start}) => {
    let recovered=false;
    const controller=await start({afterExit:async()=>{recovered=true;}});
    await expect(controller.call({action:'hold',sessionID:'ses_test'},{timeoutMs:20})).rejects.toMatchObject({code:'native_process_command_timeout'});
    await expect(controller.call({action:'open'})).rejects.toMatchObject({code:'native_process_command_timeout'});
    await controller.killForRecovery();expect(recovered).toBe(true);expect(controller.hasExited()).toBe(true);
  });
});

test('credential settlement remains attached when bounded recovery times out', async () => {
  await fixture(async ({ start }) => {
    let release;
    const cleanup = new Promise(resolve => { release = resolve; });
    const controller = await start({ timeoutMs: 500, afterExit: () => cleanup });
    try {
      await expect(controller.call({ action: 'hold', sessionID: 'ses_test' }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'native_process_command_timeout' });
      let settled = false;
      const settlement = controller.killAndWaitForExit().then(() => { settled = true; });
      await expect(controller.killForRecovery()).rejects.toMatchObject({ code: 'native_process_exit_unconfirmed' });
      expect(settled).toBe(false);
      release(); await settlement; expect(settled).toBe(true);
    } finally { release(); await controller.killAndWaitForExit(); }
  });
});

test('uncertain reverse commands release the credential queue after child settlement before queued owner cleanup', async () => {
  await fixture(async ({ start }) => {
    let queue = Promise.resolve(), cleaned = false;
    const withQueue = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
    const controller = await start({ afterExit: () => withQueue(async () => { cleaned = true; }) });
    const operation = withQueue(async () => {
      try { await controller.call({ action: 'hold', sessionID: 'ses_test' }, { timeoutMs: 20 }); }
      catch (error) { await controller.killAndWaitForTermination(); throw error; }
    });
    await expect(operation).rejects.toMatchObject({ code: 'native_process_command_timeout' });
    await controller.killAndWaitForExit();
    expect(cleaned).toBe(true);
  });
});

test('observation warnings retain one finite gap across stderr chunks without persisting raw output', () => fixture(async ({ start, root, boot }) => {
  const logFile = path.join(root, 'native-controller.jsonl'), gaps = [];
  const controller = await start({ logFile, onObservationUnavailable: id => { gaps.push(id); throw new Error('observer unavailable'); } });
  await controller.call({ action: 'open' });
  const exit = await controller.close();
  expect(gaps).toEqual([boot.instanceID]);
  expect(exit.observationUnavailable).toBe(true);
  const text = await fs.readFile(logFile, 'utf8');
  expect(JSON.parse(text).observationUnavailable).toBe(true);
  expect(text).not.toContain('private-output');
  expect(text).not.toContain('observer unavailable');
}));


test('queued command inspection can omit an input ID while delivery/recovery commands remain strict',()=>{
 const permit={token:'a'.repeat(64),revision:0,sessionID:'ses_scope'};
 const input={protocol:1,id:'inspection',action:'queued-primary-idle-owned',sessionID:'ses_scope',permit};
 expect(parseNativeCommand(input)).toEqual(input);
 expect(parseNativeCommand({...input,messageID:'msg_exact'}).messageID).toBe('msg_exact');
 expect(()=>parseNativeCommand({...input,messageID:42})).toThrow();
 expect(()=>parseNativeCommand({...input,action:'reconcile-primary-owned'})).toThrow();
 expect(()=>parseNativeCommand({...input,permit:{...permit,sessionID:'ses_foreign'}})).toThrow();
});

// The confined controller consumes the setup credential seed that provisioning
// writes into the otherwise read-only config directory (native-setup-seed.js).
const nativeLauncher = path.join(process.env.DEVRYAN_EXECUTION_ARTIFACTS
  || path.resolve(import.meta.dirname, '../../../../runtime/darwin-arm64'), 'DevRyan-execution-darwin-arm64');
const launcherPresent = process.platform === 'darwin' && await fs.access(nativeLauncher).then(() => true, () => false);
test.skipIf(!launcherPresent)('the supervised controller may unlink only the setup credential seed in its read-only config', async () => {
  const base = path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'native-process-seed-')));
  try {
    const bundle = path.join(root, 'bundle'), global = path.join(bundle, 'global');
    const globals = Object.fromEntries(['home', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp'].map(key => [key, path.join(global, key)]));
    globals.config = path.join(bundle, 'config', 'opencode');
    for (const directory of [path.join(bundle, 'opencode'), ...Object.values(globals)]) await fs.mkdir(directory, { recursive: true });
    const seed = path.join(globals.config, 'native-setup-credentials.json'), config = path.join(globals.config, 'opencode.json');
    await fs.writeFile(seed, '{}'); await fs.writeFile(config, '{}');
    const boot = { instanceID: randomUUID(), databasePath: path.join(bundle, 'opencode', 'opencode.db'), globals };
    const supervised = await prepareSupervisedController(boot, { launcher: nativeLauncher });
    let run = 0;
    const confined = (...command) => {
      const args = [...supervised.arguments]; args[3] = path.join(root, `termination-${run++}.json`);
      return spawnSync(nativeLauncher, [...args, ...command], { cwd: root, encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', DEVRYAN_EXECUTION_WORKER: '1', DEVRYAN_EXECUTION_CWD: root, DYLD_INSERT_LIBRARIES: `${nativeLauncher}-spawn.dylib` } }).status;
    };
    expect(confined('/usr/bin/touch', path.join(globals.config, 'written'))).not.toBe(0);
    expect(confined('/bin/rm', config)).not.toBe(0);
    expect(confined('/bin/rm', seed)).toBe(0);
    await expect(fs.access(seed)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(config, 'utf8')).resolves.toBe('{}');
    await expect(fs.access(path.join(globals.config, 'written'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
