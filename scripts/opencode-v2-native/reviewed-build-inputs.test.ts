import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin,REVIEWED_PONYTAIL_MODULE} from '../native-runtime-assets.mjs';

test('actual reviewed Slim static import and Ponytail builder virtual module bundle without ambient discovery',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const inputs=await prepareReviewedNativeInputs(repository);
 const parent=path.join(repository,'.cache/v2-validation');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'reviewed-build-'));
 try{
  const entry=path.join(root,'entry.ts');
  const slim=path.join(repository,'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js');
  await fs.writeFile(entry,`import slim,{bindReviewedSlimHost,bindReviewedAstGrepAsset,ast_grep_search} from ${JSON.stringify(slim)};
import instructions from ${JSON.stringify(REVIEWED_PONYTAIL_MODULE)};
export {slim,bindReviewedSlimHost,bindReviewedAstGrepAsset,ast_grep_search,instructions};\n`);
  const result=await Bun.build({entrypoints:[entry],target:'bun',metafile:true,plugins:[reviewedNativeInputPlugin(inputs)]});
  expect(result.success).toBe(true);
  if(!result.success)throw new AggregateError(result.logs,'Reviewed static graph failed');
  const text=await result.outputs[0].text();
  expect(text).toContain('reviewed_slim_host_unbound');
  expect(text).toContain('reviewed_ast_asset_unbound');
  expect(text).toContain('PONYTAIL MODE ACTIVE');
  expect(text).not.toContain('.cache/v2-spike');
  if(!result.metafile)throw new Error('Actual linked inventory missing');
  expect(Object.keys(result.metafile.inputs)).toContain(`devryan-reviewed:${REVIEWED_PONYTAIL_MODULE}`);
  await fs.writeFile(entry,"import data from 'devryan:reviewed-unknown';export {data};\n");
  await expect(Bun.build({entrypoints:[entry],target:'bun',plugins:[reviewedNativeInputPlugin(inputs)]})).rejects.toThrow('Bundle failed');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
