import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';

test('agents-core static import bundles without ambient discovery and the retired Ponytail module no longer resolves',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const inputs=await prepareReviewedNativeInputs(repository);
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-reviewed-build-')));
 try{
  const entry=path.join(root,'entry.ts');
  const slim=path.join(repository,'packages/agents-core/src/devryan/index.ts');
  await fs.writeFile(entry,`import slim,{bindReviewedSlimHost,bindReviewedAstGrepAsset,ast_grep_search} from ${JSON.stringify(slim)};
export {slim,bindReviewedSlimHost,bindReviewedAstGrepAsset,ast_grep_search};\n`);
  const result=await Bun.build({entrypoints:[entry],target:'bun',metafile:true,plugins:[reviewedNativeInputPlugin(inputs)]});
  expect(result.success).toBe(true);
  if(!result.success)throw new AggregateError(result.logs,'Reviewed static graph failed');
  const text=await result.outputs[0].text();
  expect(text).toContain('reviewed_slim_host_unbound');
  expect(text).toContain('reviewed_ast_asset_unbound');
  expect(text).not.toContain('.cache/v2-spike');
  if(!result.metafile)throw new Error('Actual linked inventory missing');
  expect(Object.keys(result.metafile.inputs).some(input=>input.includes('ponytail'))).toBe(false);
  for(const id of ['devryan:reviewed-unknown','devryan:reviewed-ponytail-instructions']){
   await fs.writeFile(entry,`import data from ${JSON.stringify(id)};export {data};\n`);
   await expect(Bun.build({entrypoints:[entry],target:'bun',plugins:[reviewedNativeInputPlugin(inputs)]})).rejects.toThrow('Bundle failed');
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
