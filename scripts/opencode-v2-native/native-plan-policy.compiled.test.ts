import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareReviewedNativeInputs, reviewedNativeInputPlugin } from '../native-runtime-assets.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
for (const compiled of [false, true]) test(`Plan admission, permission aliases and saved source proof compiled=${compiled}`, async () => {
  const base = path.join(repository, '.cache/v2-validation'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'native-plan-policy-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const entry = path.join(root, 'fixture.mjs');
    const host = path.join(repository, 'packages/web/server/lib/opencode/runtime-host');
    await fs.writeFile(entry, `
import assert from 'node:assert/strict';
import {createNativeAdmissionOwner} from ${JSON.stringify(path.join(host, 'native-admission-owner.js'))};
import {nativePermissionRules} from ${JSON.stringify(path.join(host, 'native-configuration-data.js'))};
import {validateCanonicalPlanSource} from ${JSON.stringify(path.join(repository, 'packages/web/server/lib/plans/canonical-source.js'))};
let readOnly=true;
const directory='/fixture/project',sessionID='ses_fixture';
const owner=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},getSession:async id=>({id,directory}),authorizeOperation:async()=>{},readPlanPolicy:async()=>({readOnly,objectiveID:'msg_user'})});
try{
const request=toolID=>({operation:'tool.execute',sessionID,messageID:'msg_assistant',input:{toolID,callID:'call_fixture',provenance:{kind:'native',id:'opencode.tool.'+toolID},input:{readOnly:false}}});
for(const tool of ['write','edit','patch','apply_patch','ast_grep_replace'])await assert.rejects(owner.handleRpc('native.admission.authorize',request(tool)),error=>error.code==='native_plan_write_denied');
for(const input of [{...request('read').input,provenance:undefined},{...request('read').input,provenance:{kind:'plugin',id:'unknown'},annotations:{readOnlyHint:true}}])await assert.rejects(owner.handleRpc('native.admission.authorize',{...request('read'),input}),error=>error.code==='native_plan_write_denied');
const authorization=request('shell'),permit=await owner.handleRpc('native.admission.authorize',authorization);
const invocation={directory,sessionID,messageID:'msg_assistant',callID:'call_fixture',tool:'shell',authorization,permit};
assert.equal(await owner.readOnlyExecution(invocation),true);
readOnly=false;await assert.rejects(owner.readOnlyExecution(invocation),error=>error.code==='native_plan_policy_changed');
assert.deepEqual(nativePermissionRules({bash:'deny',task:{explorer:'allow','*':'deny'},write:'ask',patch:'ask'}),[{action:'shell',resource:'*',effect:'deny'},{action:'subagent',resource:'explorer',effect:'allow'},{action:'subagent',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'ask'},{action:'edit',resource:'*',effect:'ask'}]);
assert.throws(()=>nativePermissionRules({write:'allow',patch:'deny'}),/native_permission_alias_conflict/);
const records=[{info:{id:'msg_user',sessionID,role:'user',metadata:{openchamberPlanMode:true}},parts:[{type:'text',text:'Plan it'}]},
{info:{id:'msg_plan',sessionID,role:'assistant',parentID:'msg_user',finish:'stop',time:{completed:10}},turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},parts:[{type:'text',text:'<!--plan-->\\n# Verified Plan\\n'}]}];
const proof=validateCanonicalPlanSource({sessionID,sourceMessageID:'msg_plan',records});assert.equal(proof.content,'# Verified Plan\\n');assert.equal(proof.sourceIdentity.successful,true);
records[1].info.finish='cancelled';assert.throws(()=>validateCanonicalPlanSource({sessionID,sourceMessageID:'msg_plan',records}),/plan_source_incomplete/);
console.log(JSON.stringify({writersDenied:5,readonlyShell:true,revoked:true,aliases:true,savedSource:true,cancelledRefused:true}));
}finally{owner.dispose();}
`);
    let command = [process.execPath, entry];
    if (compiled) {
      const disk = Bun.spawn(['df', '-h', repository], { stdout: 'ignore', stderr: 'pipe' });
      if (await disk.exited !== 0) throw Error('Disk check unavailable');
      const executable = path.join(root, 'DevRyan-plan-policy-fixture');
      const result = await Bun.build({ entrypoints: [entry], target: 'bun', compile: { outfile: executable,
        autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
        plugins: [reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))] });
      if (!result.success) throw new AggregateError(result.logs, 'Compiled Plan policy fixture failed');
      command = [executable];
    }
    const home = path.join(root, 'home'); await fs.mkdir(home);
    child = Bun.spawn(command, { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: root }, stdout: 'pipe', stderr: 'pipe' });
    if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw Error('Owned pipes required');
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw Error(JSON.stringify({ code, stderr }));
    expect(JSON.parse(stdout)).toEqual({ writersDenied: 5, readonlyShell: true, revoked: true, aliases: true, savedSource: true, cancelledRefused: true });
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited; } await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
