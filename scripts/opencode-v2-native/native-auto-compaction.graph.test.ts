import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
// Child logs and projections land in the test's own temp root (removed afterwards) unless DEVRYAN_KEEP_ARTIFACTS=1.
const keptDiagnostics=(root:string)=>process.env.DEVRYAN_KEEP_ARTIFACTS==='1'?path.join(repository,'.cache/v2-validation'):root;
// The shipped native host is the compiled executable; the bundled-source run proved
// nothing the compiled run does not, so only the compiled program runs.
for(const compiled of [true])test(`pinned native automatic compaction preserves Plan lineage compiled=${compiled}`,async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/auto-plan-'));let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const original=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');let source=await fs.readFile(original,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Automatic-compaction fixture seam changed: '+before);source=source.replace(before,after);};
  source=`import {createPrivilegedOpenCodeClient} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/opencode-client/privileged.js'))};
import {validateCanonicalPlanSource} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/plans/canonical-source.js'))};\n`+source;
  replace('let initialPairReleased=false;','let initialPairReleased=true;let primaryRequests=0;');
  replace('const options = { database:',"const options = { app:{name:'DevRyan automatic compaction fixture',version:'2.1.4',channel:'fixture'},database:");
  replace('  withSessionLock: lock,','  readPlanPolicy:async()=>({readOnly:true}),validatePlanImplementation:async()=>{},\n  withSessionLock: lock,');
  const beginOutput='      const output = JSON.stringify(body).includes(\'structured summary\')';
  replace(beginOutput,`      if(kind==='primary'&&++primaryRequests===1){
       const prefix='<!--plan-->\\n# Plan\\n- Original ',message={id:'prefix_output',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:prefix,annotations:[]}]};
       const tool={id:'read_output',type:'function_call',call_id:'read_call',name:'read',arguments:JSON.stringify({path:directories[0]+'/README.md'}),status:'completed'};
       const result={id:'prefix_response',object:'response',created_at:Math.floor(Date.now()/1000),model:'gpt-6.1-sol',status:'completed',output:[message,tool],usage:{input_tokens:300000,output_tokens:5,total_tokens:300005}};
       const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item:{...message,content:[],status:'in_progress'}},
        {type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
        {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:prefix},
        {type:'response.output_text.done',item_id:message.id,output_index:0,content_index:0,text:prefix},
        {type:'response.output_item.done',output_index:0,item:message},
        {type:'response.output_item.added',output_index:1,item:{...tool,arguments:'',status:'in_progress'}},
        {type:'response.function_call_arguments.delta',output_index:1,item_id:tool.id,delta:tool.arguments},
        {type:'response.function_call_arguments.done',output_index:1,item_id:tool.id,arguments:tool.arguments},
        {type:'response.output_item.done',output_index:1,item:tool},{type:'response.completed',response:result}];
       response.writeHead(200,{'content-type':'text/event-stream'});response.end(events.map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join(''));return;
      }
${beginOutput}`);
  replace(" : 'Owned native integration completion';"," : 'and current continuation.\\n';");
  const start=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create('),end=source.indexOf('} catch (error) { primaryFailure = error;');
  if(start<0||end<start)throw Error('Automatic-compaction main fixture changed');
  source=source.slice(0,start)+`
  const directory=directories[0];await fs.writeFile(path.join(directory,'README.md'),'Owned read-only fixture');
  const session=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-6.1-sol'}},{directory}));
  await callerContext.run(caller,()=>client.prompts.prompt(session.id,{agent:'build',model:{providerID:'openai',modelID:'gpt-6.1-sol'},planMode:true,parts:[{type:'text',text:'Plan the smallest change. Read README.md before finishing.'}]},{directory}));
  const privileged=createPrivilegedOpenCodeClient(deps);let sequence,completed=false;
  const hasSettledSuccessor=(value)=>{const boundary=value.nativeSequence.findLastIndex(row=>row.type==='compaction'&&row.reason==='auto'&&row.status==='completed');
   const successor=boundary<0?undefined:value.nativeSequence.slice(boundary+1).findLast(row=>row.type==='assistant'),tail=value.records.at(-1);
   return Boolean(successor&&tail?.info.id===successor.id&&tail.info.role==='assistant'&&tail.info.finish==='stop'
    &&Number.isSafeInteger(tail.info.time?.completed)&&tail.info.time.completed>0
    &&!tail.parts.some(part=>part.type==='tool'&&!['completed','error'].includes(part.state?.status)));};
  const diagnostic=[];let lastDiagnostic;
  const diagnose=async(statuses)=>{const value={records:sequence.records.map(row=>({id:row.info.id,role:row.info.role,parentID:row.info.parentID,finish:row.info.finish,completed:row.info.time?.completed??null,error:Boolean(row.info.error),ownership:row.turnOwnership?{source:row.turnOwnership.source,userMessageID:row.turnOwnership.userMessageID}:null,tools:row.parts.filter(part=>part.type==='tool').map(part=>({id:part.id,status:part.state?.status}))})),nativeSequence:sequence.nativeSequence,status:statuses[session.id]?{type:statuses[session.id].type}:null};
   const encoded=JSON.stringify(value);if(encoded!==lastDiagnostic&&diagnostic.length<256){lastDiagnostic=encoded;diagnostic.push({at:Date.now(),...value});await fs.writeFile(path.join(root,'plan-projection-evidence.json'),JSON.stringify({journal:'not-configured-in-this-native-fixture',observations:diagnostic}));}};
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){sequence=await privileged.readCanonicalPlanSequence(session.id,{directory});
   const statuses=await client.sessions.status({directory});await diagnose(statuses);
   completed=hasSettledSuccessor(sequence)&&!statuses[session.id];if(completed)break;
   await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(completed,true,'Actual native automatic compaction did not settle');
  assert.equal(primaryRequests,2);assert.ok(kinds.has('compaction'),'Automatic compaction must make a physical native request');
  const boundary=sequence.nativeSequence.findIndex(row=>row.type==='compaction');assert.ok(boundary>0);
  // A completed compaction summary and a later idle read can precede its real successor.
  const summaryID=sequence.nativeSequence[boundary].id+':summary',summaryIndex=sequence.records.findIndex(row=>row.info.id===summaryID);assert.ok(summaryIndex>=0);
  const summaryOnly={records:sequence.records.slice(0,summaryIndex+1),nativeSequence:sequence.nativeSequence.slice(0,boundary+1)};
  assert.equal(summaryOnly.records.at(-1).info.finish,'stop');assert.equal(hasSettledSuccessor(summaryOnly),false,'Completed compaction summary is not its successor');
  for(const patch of [{id:'msg_wrong_association'},{time:{created:1}},{time:{created:1,completed:0}}]){const changed=structuredClone(sequence);Object.assign(changed.records.at(-1).info,patch);assert.equal(hasSettledSuccessor(changed),false);}
  const unsettled=structuredClone(sequence);unsettled.records.at(-1).parts.push({type:'tool',state:{status:'running'}});assert.equal(hasSettledSuccessor(unsettled),false);
  const prefixID=sequence.nativeSequence.slice(0,boundary).findLast(row=>row.type==='assistant')?.id;assert.ok(prefixID);
  const verified=validateCanonicalPlanSource({sessionID:session.id,sourceMessageID:prefixID,records:sequence.records,nativeSequence:sequence.nativeSequence});
  assert.equal(verified.content,'# Plan\\n- Original and current continuation.\\n');
  assert.equal(verified.sourceIdentity.rootUserMessageID,sequence.nativeSequence.find(row=>row.type==='user').id);
  assert.equal(verified.sourceIdentity.currentSourceMessageID,sequence.records.at(-1).info.id);
  assert.equal(verified.sourceIdentity.memberUserMessageIDs.length,2);
  assert.equal(verified.sourceIdentity.memberAssistantMessageIDs.length,2);
  for(const status of ['running','failed']){const changed=structuredClone(sequence.nativeSequence);changed[boundary].status=status;
   assert.throws(()=>validateCanonicalPlanSource({sessionID:session.id,sourceMessageID:prefixID,records:sequence.records,nativeSequence:changed}));}
  result={automatic:true,primaryRequests,physicalCompactions:receipts.filter(row=>row.kind==='compaction').length,sourceIdentity:verified.sourceIdentity};
`+source.slice(end);
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(original),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(original),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  const plugins=[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))];
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'auto-plan.mjs',asset:'[name]-[hash].[ext]'},plugins});
  if(!built.success)throw new AggregateError(built.logs,'Automatic-compaction source graph build failed');await writeNativeFixtureOutputs(built.outputs);
  let command=[process.execPath,path.join(root,'auto-plan.mjs')];
  if(compiled){
   const disk=Bun.spawn(['df','-h',repository],{stdout:'pipe',stderr:'pipe'});if(await disk.exited!==0)throw Error('Disk check unavailable');
   const executable=path.join(root,'DevRyan-auto-plan-fixture');
   const output=await Bun.build({entrypoints:[entry],target:'bun',compile:{target:'bun-darwin-arm64',outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
    plugins:[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
   if(!output.success)throw new AggregateError(output.logs,'Compiled automatic-compaction fixture failed');await fs.chmod(executable,0o755);command=[executable];
  }
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  child=Bun.spawn(command,{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const diagnostic=await fs.readFile(path.join(root,'plan-projection-evidence.json'),'utf8').catch(()=>null);
  await fs.writeFile(path.join(keptDiagnostics(root),`native-auto-compaction-${compiled?'compiled':'source'}-projection.json`),JSON.stringify({compiled,code,...diagnostic?{projection:JSON.parse(diagnostic)}:{projection:null}}));
  if(code!==0){const errors=await fs.readFile(path.join(root,'rpc-errors.jsonl'),'utf8').catch(()=>'');throw Error(JSON.stringify({code,stderr,errors}));}
  expect(JSON.parse(stdout)).toMatchObject({automatic:true,primaryRequests:2,physicalCompactions:1});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}if(process.env.DEVRYAN_KEEP_ARTIFACTS!=='1')await fs.rm(root,{recursive:true,force:true});}
},180000);
