import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadNativeReviewedConfiguration} from './native-reviewed-configuration.js';

test('configuration import executes only sealed bytes and validates its exact native declarations',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/config-asset-'));
 const filename=path.join(root,'DevRyan-native-configuration.mjs'),buildId='a'.repeat(64);
 const source=`export const nativeBuildID=${JSON.stringify(buildId)};
 export const reviewedImagegenOriginals={withReviewedImagegenOwner(){},callReviewedImagegenResponses(){}};
 export const createReviewedDocumentCache=()=>({});export const resolveSlimAgents=input=>({agents:input.agents});
 export const createOwnedNativeDocument=()=>({});export const reviewedSlimInterviewOriginals={createInterviewService(){},createInterviewHandler(){},resolveExistingInterviewPath(){},InterviewDocumentOwnershipError:class{}};export const reviewedDocumentOriginals={createDocumentTool(){},processFilePart(){},withReviewedDocumentOwner(){}};
 export const createReviewedSlimTaskBoardRenderer=()=>({});export const formatReviewedSlimTaskBoard=()=>'';export const isReviewedSlimFailoverError=()=>false;export const selectReviewedSlimFallback=()=>({});
 export const slimCommandDeclarations=Object.fromEntries(['deepwork','loop','reflect'].map(name=>[name,{template:name,description:name}]));
 export const ponytailInstructions={lite:'lite',full:'full',ultra:'ultra',review:'review'};
 export const ponytailCommands=Object.fromEntries(['ponytail','ponytail-audit','ponytail-debt','ponytail-gain','ponytail-help','ponytail-review'].map(name=>[name,{template:name,description:name}]));
 export const interviewCommandDeclaration={template:'<omos-interview-command>$ARGUMENTS</omos-interview-command>',description:'Original interview'};
 export const ponytailCommandDeclaration={template:'original',description:'original'};`;
 const asset={path:filename,size:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')};
 try{
  await fs.writeFile(filename,source,{mode:0o644});
  const loaded=await loadNativeReviewedConfiguration({reviewedConfiguration:asset,manifest:{buildId}});
  expect(loaded.resolveSlimAgents({agents:{builder:{model:'saved/model'}}})).toEqual({agents:{builder:{model:'saved/model'}}});
  expect(Object.isFrozen(loaded.reviewedImagegenOriginals)).toBe(true);
  expect(typeof loaded.reviewedImagegenOriginals.callReviewedImagegenResponses).toBe('function');
  expect(Object.keys(loaded.slimCommandDeclarations)).toEqual(['deepwork','loop','reflect']);
  await expect(loadNativeReviewedConfiguration({reviewedConfiguration:asset,manifest:{buildId:'b'.repeat(64)}})).rejects.toMatchObject({code:'native_reviewed_configuration_unverified'});
  await fs.writeFile(filename,source.replace('original','modified'));
  await expect(loadNativeReviewedConfiguration({reviewedConfiguration:asset,manifest:{buildId}})).rejects.toMatchObject({code:'native_reviewed_configuration_unverified'});
  await fs.rename(filename,path.join(root,'elsewhere.mjs'));await fs.symlink(path.join(root,'elsewhere.mjs'),filename);
  await expect(loadNativeReviewedConfiguration({reviewedConfiguration:asset,manifest:{buildId}})).rejects.toMatchObject({code:'native_reviewed_configuration_unverified'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
