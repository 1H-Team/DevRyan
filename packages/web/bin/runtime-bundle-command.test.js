import {expect,test,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {parseArgs} from './cli.js';
import {runRuntimeBundleCommand} from './runtime-bundle-command.js';
const run=promisify(execFile);
test('runtime resume preserves command validation across fully specified quiet/JSON/plain modes',async()=>{
 for(const flags of [[],['--quiet'],['--json'],['--plain'],['--json','--quiet']]){
  const parsed=parseArgs(['runtime','bundle','resume','--expected-revision','17',...flags]);
  const resume=vi.fn(async()=>({state:'restart_required',revision:18}));
  await expect(runRuntimeBundleCommand({...parsed,expectedRevision:parsed.options.expectedRevision,environment:{XDG_STATE_HOME:'/repo-owned/state'},resume})).resolves.toMatchObject({revision:18});
  expect(resume).toHaveBeenCalledExactlyOnceWith({controlRoot:'/repo-owned/state/devryan/runtime-bundles',input:{expectedRevision:17}});
 }
});
test.each(['','0','-1','1.5','9007199254740992','abc'])('invalid expected revision %s cannot invoke recovery',async revision=>{
 const resume=vi.fn();await expect(runRuntimeBundleCommand({positionals:['runtime','bundle','resume'],expectedRevision:revision,resume})).rejects.toMatchObject({code:'bundle_selection_revision_conflict'});expect(resume).not.toHaveBeenCalled();
});
test('unsupported flags/IDs/paths and duplicate revision cannot choose a recovery target',async()=>{
 const resume=vi.fn();for(const args of [
  ['runtime','bundle','resume','B','--expected-revision','2'],
  ['runtime','bundle','resume','--expected-revision','2','--force'],
  ['runtime','bundle','resume','--expected-revision','2','--token-file','unused'],
  ['runtime','bundle','resume','--expected-revision','2','--expected-revision','3'],
 ]){const parsed=parseArgs(args);await expect(runRuntimeBundleCommand({...parsed,expectedRevision:parsed.options.expectedRevision,resume})).rejects.toMatchObject({code:'bundle_command_invalid'});}
 expect(resume).not.toHaveBeenCalled();
 await expect(runRuntimeBundleCommand({positionals:['runtime','bundle','resume'],expectedRevision:'2',environment:{DEVRYAN_RUNTIME_BUNDLE_ROOT:'relative'},resume})).rejects.toMatchObject({code:'bundle_recovery_owner_required'});
});
test('original dispatcher noninteractive invalid JSON/quiet commands fail deterministically before local owner access',async()=>{
 for(const flags of [[],['--quiet'],['--json']]){
  let error;try{await run(process.execPath,[path.join(import.meta.dirname,'cli.js'),'runtime','bundle','resume','--expected-revision','0',...flags],{env:{PATH:process.env.PATH,HOME:path.resolve(import.meta.dirname,'../../../.cache/v2-validation/unused-cli-home')},timeout:10000});}catch(cause){error=cause;}
  expect(error?.code).toBe(2);expect(error.stderr+error.stdout).toContain('bundle_selection_revision_conflict');
  if(flags.includes('--json'))expect(JSON.parse(error.stdout)).toMatchObject({status:'error',error:{code:'bundle_selection_revision_conflict'}});
 }
});
