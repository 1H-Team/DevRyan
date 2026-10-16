import {describe,expect,it,vi} from 'vitest';
import {OPENCODE_CAPABILITY_ABSENT} from '../opencode/opencode-generation.js';
import {createFreeZenCooldowns} from '@openchamber/shared-runtime';
import {GIT_GENERATION_ZEN_MODEL,GIT_GENERATION_ZEN_VARIANT,createGitZenTextTransport} from './zen-text.js';
import {generateCommitMessageDirect} from './commit-message.js';
import {generatePullRequestDescriptionDirect} from './pr-description.js';
const context={selectedFiles:[{path:'fixture.ts',index:'M',workingDir:' '}],stagedOnly:true};
const drafts={commit:JSON.stringify({subject:'fix: recover native generation',details:['Preserve native settlement']}),pr:JSON.stringify({title:'Recover native generation',body:'## Summary\n- Native helper\n## Testing\n- Isolated graph'})};
const client={generation:()=>2};
describe('admitted native Git text transport',()=>{
 it('defaults to DeepSeek V4.1 Flash with provider Default reasoning',()=>{expect(GIT_GENERATION_ZEN_MODEL).toBe('deepseek-v4.1-flash');expect(GIT_GENERATION_ZEN_VARIANT).toBeUndefined();});
 it.each(['commit','pr'])('%s retains provider/agent/variant and rotates only after actual helper settlement',async kind=>{
  let running=false;const settled=[],generateHelperText=vi.fn(async input=>{
   expect(running).toBe(false);running=true;expect(input.providerID).toBe('opencode');expect(Object.hasOwn(input,'variant')).toBe(false);expect(input.agent).toBe(kind==='commit'?'devryan-commit':'devryan-pr');
   try{await Promise.resolve();if(input.modelID==='a')throw Object.assign(new Error('private upstream detail'),{statusCode:429});return {text:input.modelID==='b'?'{}':drafts[kind]};}
   finally{running=false;settled.push(input.modelID);}
  });
  const options={...createGitZenTextTransport({openCodeClient:client,generateHelperText,directory:'/fixture',agent:kind==='commit'?'devryan-commit':'devryan-pr'}),models:['a','b','c'],cooldowns:createFreeZenCooldowns()};
  const attempts=[];const result=kind==='commit'?await generateCommitMessageDirect({context,...options,onAttempt:attempt=>attempts.push(attempt)}):await generatePullRequestDescriptionDirect({prompt:'Describe fixture',...options,onAttempt:attempt=>attempts.push(attempt)});
  expect(result._generation).toMatchObject({model:'c',attempts:3});expect(settled).toEqual(['a','b','c']);expect(attempts.map(item=>item.reason)).toEqual(['rate_limited','invalid_output',undefined]);expect(JSON.stringify(attempts)).not.toContain('private');expect(running).toBe(false);
  expect(new Set(generateHelperText.mock.calls.map(([input])=>input.operationID)).size).toBe(1);
 });
 it('ends model rotation when the owner returns an unsettled helper',async()=>{
  const generateHelperText=vi.fn(async()=>{throw Object.assign(Error('held'),{code:'native_helper_unsettled',statusCode:503});});
  const options={...createGitZenTextTransport({openCodeClient:client,generateHelperText,directory:'/fixture',agent:'devryan-commit'}),models:['a','b'],cooldowns:createFreeZenCooldowns()};
  await expect(generateCommitMessageDirect({context,...options})).rejects.toMatchObject({reason:'unsettled',code:'native_helper_unsettled'});
  expect(generateHelperText).toHaveBeenCalledTimes(1);
 });
 it('refuses a missing native helper before any old session or provider request',async()=>{
  const transport=createGitZenTextTransport({openCodeClient:client,directory:'/fixture',agent:'devryan-commit'});
  await expect(transport.requestText({prompt:'fixture',zenModel:'a',timeoutMs:10})).rejects.toMatchObject({reason:OPENCODE_CAPABILITY_ABSENT});await transport.afterAttempt();
 });
 it.each(['commit','pr'])('%s stops rotation on a changed configured selection without revealing provider text',async kind=>{
  const generateHelperText=vi.fn(async()=>{throw Object.assign(Error('private source'),{code:'native_helper_selection_changed',statusCode:403});});
  const transport=createGitZenTextTransport({openCodeClient:client,generateHelperText,directory:'/fixture',agent:kind==='commit'?'devryan-commit':'devryan-pr',
   selection:{providerID:'saved',modelID:'selected',selectionMode:'configured',revision:'one'}});
  const options={...transport,models:['a','b'],cooldowns:createFreeZenCooldowns()};
  await expect(kind==='commit'?generateCommitMessageDirect({context,...options}):generatePullRequestDescriptionDirect({prompt:'Draft',...options}))
   .rejects.toMatchObject({code:'native_helper_selection_changed',reason:'selection_changed'});
  expect(generateHelperText).toHaveBeenCalledTimes(1);
 });
 it('active fallback uses Default reasoning even when a stale selection includes a variant',async()=>{
  const generateHelperText=vi.fn(async()=>({text:'Draft'}));
  const transport=createGitZenTextTransport({openCodeClient:client,generateHelperText,directory:'/fixture',agent:'devryan-pr',
   selection:{providerID:'active',modelID:'selected',variant:'high',selectionMode:'active',revision:'active-session'}});
  expect(await transport.requestText({prompt:'Draft',timeoutMs:100})).toBe('Draft');await transport.afterAttempt();
  expect(generateHelperText.mock.calls[0][0]).not.toHaveProperty('variant');
 });
});
