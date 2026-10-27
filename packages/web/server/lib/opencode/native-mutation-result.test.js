import {expect,test} from 'vitest';
import {projectNativeMutationResult} from './native-mutation-result.js';
test('mutation receipts identify the logical workspace and actually published paths without rewriting source text',()=>{
 const view='/private/view/worktree',lease={viewDirectory:view,projectDirectory:'/project'};
 const text=`source contains ${view}/keep-this.ts`,result={content:text,metadata:{path:`${view}/src/a.ts`,files:[{file:`${view}/src/a.ts`,patch:text}],diff:text}};
 const output=projectNativeMutationResult(result,{files:[{path:'src/a.ts'},{path:'../foreign'}],outcome:'partial'},lease,'edit');
 expect(output.content).toBe(text);expect(output.metadata.diff).toBe(text);expect(output.metadata.files).toEqual([{file:'/project/src/a.ts',patch:text}]);
 expect(output.metadata.path).toBe('/project/src/a.ts');expect(output.metadata.mutationReceipt).toEqual({directory:'/project',paths:['src/a.ts'],outcome:'partial'});
 expect(result.metadata.path).toBe(`${view}/src/a.ts`);
});
test('lookalike paths outside the private view and unrelated tool results retain their identity',()=>{
 const lease={viewDirectory:'/view',projectDirectory:'/project'},result={metadata:{path:'/view-other/a'}};
 expect(projectNativeMutationResult(result,{files:[]},lease,'write').metadata.path).toBe('/view-other/a');
 expect(projectNativeMutationResult(result,{files:[]},lease,'read')).toBe(result);
});
test('writer result exposes only validated snapshot and publication sequences',()=>{
 const lease={viewDirectory:'/view',projectDirectory:'/project',baseSequence:12},result={content:'Edited'};
 expect(projectNativeMutationResult(result,{files:[],sequence:18},lease,'edit').metadata.mutationReceipt)
  .toMatchObject({baseSequence:12,publicationSequence:18});
 expect(projectNativeMutationResult(result,{files:[],sequence:NaN},{...lease,baseSequence:-1},'edit').metadata.mutationReceipt)
  .toEqual({directory:'/project',paths:[],outcome:'published'});
});
