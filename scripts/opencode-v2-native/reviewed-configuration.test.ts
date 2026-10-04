import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin,rewriteSealedNodeRequire} from '../native-runtime-assets.mjs';

test('sealed reviewed configuration imports under Node and builds original roles without ambient IO',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/reviewed-config-'));
 try{
  const reviewed=await prepareReviewedNativeInputs(repository);
  const output=path.join(root,'DevRyan-native-configuration.mjs');
  const build=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/reviewed-configuration-entry.ts')],target:'node',conditions:['node'],format:'esm',minify:true,plugins:[reviewedNativeInputPlugin(reviewed)]});
  expect(build.success).toBe(true);if(!build.success)throw new Error(build.logs.join('\n'));
  await fs.writeFile(output,rewriteSealedNodeRequire(await build.outputs[0].text()));
  const child= Bun.spawn(['node','--input-type=module','-e',`
   process.on('uncaughtException',error=>{process.stderr.write(error.name+': '+error.message+'\\n');process.exitCode=1;});
   import fs from 'node:fs';import fsp from 'node:fs/promises';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
   const assetBytes=fs.readFileSync(${JSON.stringify(output)});
   const refuse=()=>{throw new Error('ambient_io_forbidden')};
   for(const name of ['readFileSync','writeFileSync','mkdirSync','readdirSync','statSync','existsSync'])fs[name]=refuse;
   for(const name of ['readFile','writeFile','mkdir','readdir','stat','open'])fsp[name]=refuse;
   for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[name]=refuse;
   globalThis.fetch=refuse;syncBuiltinESMExports();
   const api=await import('data:text/javascript;base64,'+assetBytes.toString('base64'));
   const input={directory:${JSON.stringify(root)},configuration:{autoUpdate:false,backgroundJobs:{strategy:'checkpoint-compatible',maxRetainedSnapshots:2,readContextMaxFiles:3,orchestratorWake:{enabled:false}},agents:{orchestrator:{model:'saved/root',variant:'high'},fixer:{inheritModelFrom:'orchestrator'},librarian:{model:'saved/lib'},explorer:{skills_include_local:true}},disabled_agents:['observer'],council:{default_preset:'default',presets:{default:{alpha:{models:[{id:'saved/alpha',variant:'medium'}]},master:{model:'saved/master'}}}}},hostConfiguration:{agent:{orchestrator:{model:'saved/host',variant:null}},mcp:{}},prompts:{librarian:{prompt:'EXACT CAPTURED PROMPT\\n',appendPrompt:'EXACT APPEND\\n'}},localSkills:['fixture-skill']};
   const before=JSON.stringify(input),resolved=api.resolveSlimAgents(input),again=api.resolveSlimAgents(input);
   if(JSON.stringify(input)!==before||JSON.stringify(resolved)!==JSON.stringify(again))throw new Error('mutated_or_nondeterministic');
   if(resolved.backgroundJobs.strategy!=='checkpoint-compatible'||resolved.backgroundJobs.maxRetainedSnapshots!==2||resolved.backgroundJobs.readContextMaxFiles!==3)throw new Error('normalized_board_settings_lost');
   if(resolved.agents.orchestrator.model!=='saved/host'||resolved.agents.orchestrator.variant!==null)throw new Error('saved_selection_lost');
   if(!resolved.agents.librarian.prompt.includes('EXACT CAPTURED PROMPT\\n')||!resolved.agents.librarian.prompt.includes('EXACT APPEND\\n'))throw new Error('prompt_bytes_lost');
   if(!resolved.agents.orchestrator.prompt.includes('Council Mode')||!resolved.agents['councillor-alpha']||resolved.agents.observer)throw new Error('builtin_graph_lost');
   if(!resolved.agents.explorer.prompt||!resolved.agents.fixer.prompt)throw new Error('builtin_prompt_absent');
   const selected={...input,configuration:{...input.configuration,preset:'base',agents:{orchestrator:{model:'saved/root',variant:'high'},fixer:{model:'saved/fixer',variant:'medium'},librarian:{model:[{id:'saved/first',variant:'high'},{id:'saved/backup',variant:'low'}]}},presets:{base:{orchestrator:{model:'preset/root',variant:'low'},fixer:{model:'preset/fixer',variant:'low'},explorer:{model:'preset/explorer',variant:'low'}},alternate:{orchestrator:{model:'alternate/root',variant:'low'},fixer:{model:'alternate/fixer',variant:'low'},explorer:{model:'alternate/explorer',variant:'medium'}}}}};
   for(const activePreset of ['base','alternate']){
    const chosen={...selected,activePreset},beforeSelection=JSON.stringify(chosen),actual=api.resolveSlimAgents(chosen);
    if(JSON.stringify(chosen)!==beforeSelection)throw new Error('saved_preset_input_mutated');
    if(actual.agents.orchestrator.model!=='saved/host'||actual.agents.orchestrator.variant!==null||actual.agents.fixer.model!=='saved/fixer'||actual.agents.fixer.variant!=='medium')throw new Error('saved_preset_overrode_explicit_selection');
    if(actual.agents.explorer.model!==(activePreset==='base'?'preset/explorer':'alternate/explorer'))throw new Error('configured_preset_selection_lost');
    if(JSON.stringify(actual.runtimeChains.librarian)!==JSON.stringify(['saved/first','saved/backup'])||actual.modelArrays.librarian[1].variant!=='low')throw new Error('saved_fallback_order_lost');
   }
   const hostAgents={orchestrator:{model:{providerID:'saved',modelID:'object'},variant:null,backupModel:{providerID:'saved',modelID:'backup',variant:'high'}},council:{model:'saved/coordinator',councillors:[{model:'saved/second',variant:'high'},{model:'saved/first',variant:null}]}};
   const hostResult=api.resolveSlimAgents({...selected,activePreset:'base',hostConfiguration:{agent:hostAgents,mcp:{}}});
   if(JSON.stringify(hostResult.agents.orchestrator.model)!==JSON.stringify(hostAgents.orchestrator.model)||JSON.stringify(hostResult.agents.orchestrator.backupModel)!==JSON.stringify(hostAgents.orchestrator.backupModel)||hostResult.agents.orchestrator.variant!==null)throw new Error('host_object_selection_or_backup_lost');
   if(JSON.stringify(hostResult.agents.council.councillors)!==JSON.stringify(hostAgents.council.councillors))throw new Error('saved_council_order_lost');
   if(!api.slimCommandDeclarations.loop.template||!api.ponytailInstructions.ultra||!api.ponytailCommandDeclaration.template)throw new Error('declarations_absent');
   const interview=api.reviewedSlimInterviewOriginals;
   if(!interview||typeof interview.createInterviewService!=='function'||typeof interview.createInterviewHandler!=='function')throw new Error('interview_originals_absent');
   if(!(new interview.InterviewDocumentOwnershipError('owned.md','ses_owner') instanceof Error))throw new Error('ownership_error_class_lost');
   const candidates=[];const resumed=await interview.resolveExistingInterviewPath(${JSON.stringify(root)},'interview','existing',{exists:async file=>{candidates.push(file);return file.endsWith('/interview/existing.md')}});
   if(!resumed?.endsWith('/interview/existing.md')||candidates.length!==1)throw new Error('owned_resume_resolver_changed');
   const handler=interview.createInterviewHandler({authorize:async()=>{},outputFolder:'interview'});if(typeof handler!=='function')throw new Error('original_handler_absent');
   process.stdout.write('verified');
  `],{cwd:root,stdout:'pipe',stderr:'pipe',env:{...process.env,HOME:root,XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,TMPDIR:root,GIT_CEILING_DIRECTORIES:repository}});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  const errorSummary=stderr.split('\n').map(line=>line.length>400?'[long source line omitted]':line).join('\n');expect({code,stderr:errorSummary}).toEqual({code:0,stderr:''});expect(stdout).toBe('verified');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
