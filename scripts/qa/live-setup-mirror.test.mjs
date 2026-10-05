import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {qaCache,qaHash,readQaPinnedFile,prepareLiveSetupMirror,parseQaSavedGraph} from './live-setup-mirror.mjs';
import {verifyQaNativeInput} from './native-profile-preparation.mjs';

test('saved graph rejects excess authority fields and malformed backup, Council and compaction shapes',()=>{
  const graph={agentSelections:{builder:{model:'openai/gpt-6.1-sol',variant:'medium',promptSha256:'a'.repeat(64)}},nativeBackupSelections:{slim:{runtimeChains:{builder:['xai/grok-4.6']},modelArrays:{builder:[{id:'xai/grok-4.6',variant:'high'}]},fallback:{enabled:true,maxRetries:2},effectiveExecutionVariant:'default'},devryan:{}},nativeCompactionSettings:{auto:true,keep:{tokens:1000}},councilMembers:[{providerId:'xai',modelId:'grok-4.6',variant:'high',agent:'builder',timeoutMs:180000}]};
  assert.deepEqual(parseQaSavedGraph(graph),graph);
  for(const mutate of [value=>{value.nativeBackupSelections.devryan.builder={model:'xai/grok-4.6',variant:'high',key:'synthetic-secret'};},
    value=>{value.councilMembers[0].token='synthetic-secret';},value=>{value.nativeCompactionSettings.keep.key='synthetic-secret';},
    value=>{value.nativeBackupSelections.slim.modelArrays.builder[0].id='openai/gpt-6.1-sol';},value=>{value.nativeBackupSelections.slim.runtimeChains.foreign=['xai/grok-4.6'];}]){
    const changed=structuredClone(graph);mutate(changed);assert.throws(()=>parseQaSavedGraph(changed),/qa_live_saved_graph_invalid/);
  }
});

test('mirror reads only nonsecret allowlisted input and seals the projected graph',async()=>{
  const root=await fs.mkdtemp(path.join(qaCache,'test-fixtures/live-mirror-'));
  try{
    const source=path.join(root,'source'),artifactRoot=path.join(root,'artifacts'),outputRoot=path.join(root,'output');
    for(const directory of [source,artifactRoot])await fs.mkdir(directory,{mode:0o700});
    const files={'opencode/opencode.jsonc':'{"agent":{"builder":{"model":"openai/gpt-6.1-sol","variant":"medium"}},"provider":{"xai":{"options":{"apiKey":"synthetic-secret","headers":{"Authorization":"synthetic-secret"}}}},"mcp":{"fixture":{"type":"local","command":["true"],"enabled":true}}}',
      'opencode/AGENTS.md':'# Independent QA\n','web-config/settings.json':'{"theme":"light","projects":[{"path":"/never-read"}],"sessionToken":"synthetic-secret"}'};
    for(const [file,bytes] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(source,file)),{recursive:true,mode:0o700});await fs.writeFile(path.join(source,file),bytes,{mode:0o600});}
    const inputFile=path.join(root,'input.json'),inputBytes=JSON.stringify({preparedInput:{sourceHome:source,files:[...Object.entries(files).map(([file,bytes])=>({path:file,sha256:qaHash(bytes)})),{path:'home/.claude/auth.json',sha256:'a'.repeat(64)},{path:'web-config/supabase.json',sha256:'a'.repeat(64)}]}});
    await fs.writeFile(inputFile,inputBytes,{mode:0o600});
    const graphFile=path.join(root,'graph.json'),graphBytes=JSON.stringify({agentSelections:{builder:{model:'openai/gpt-6.1-sol',variant:'medium',promptSha256:'b'.repeat(64)}},nativeBackupSelections:{slim:{runtimeChains:{},modelArrays:{},fallback:{},effectiveExecutionVariant:'default'},devryan:{}},nativeCompactionSettings:{},councilMembers:[]});
    await fs.writeFile(graphFile,graphBytes,{mode:0o600});const manifestPath=path.join(artifactRoot,'native-bundle.json');await fs.writeFile(manifestPath,'{}',{mode:0o600});
    const options={inputFile,inputSha256:qaHash(inputBytes),graphFile,graphSha256:qaHash(graphBytes),artifactRoot,outputRoot,
      verifyArtifacts:async({manifestSha256})=>({manifestSha256,manifest:{buildId:'c'.repeat(64),inputs:{reviewedPlugins:[]}}})};
    const result=await prepareLiveSetupMirror(options),record=JSON.parse(await readQaPinnedFile(result.preparationFile,result.sha256));
    assert.equal(record.inputDigest,await verifyQaNativeInput(record.preparedInput));assert.equal(record.disabledMcpEntries,1);
    const config=JSON.parse(await fs.readFile(path.join(record.preparedInput.sourceHome,'opencode/opencode.jsonc'),'utf8'));
    assert.equal(config.mcp.fixture.enabled,false);assert.deepEqual(config.provider.xai.options,{});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(record.preparedInput.sourceHome,'web-config/settings.json'),'utf8')),{theme:'light'});
    assert.deepEqual(await fs.readdir(path.join(record.preparedInput.sourceHome,'home')),[]);
    assert.equal(record.records.some(row=>row.path.includes('auth')||row.path.includes('supabase')),false);
    assert.equal((await fs.stat(result.preparationFile)).mode&0o777,0o400);
    const changed=path.join(root,'changed');await assert.rejects(prepareLiveSetupMirror({...options,outputRoot:changed,inputSha256:'a'.repeat(64)}),/qa_live_input_changed/);
    await fs.unlink(path.join(source,'opencode/AGENTS.md'));await fs.symlink(inputFile,path.join(source,'opencode/AGENTS.md'));
    await assert.rejects(prepareLiveSetupMirror({...options,outputRoot:path.join(root,'linked')}),/qa_live_input_path_invalid/);
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'linked/failed.json'),'utf8')).status,'failed');
    const hardlink=path.join(root,'hardlink');await fs.link(inputFile,hardlink);await assert.rejects(readQaPinnedFile(inputFile),/qa_live_input_invalid/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
