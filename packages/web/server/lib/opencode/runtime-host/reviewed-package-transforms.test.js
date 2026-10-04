import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {rewriteReviewedSlimServer,SLIM_SERVER_SOURCE_SHA256} from './reviewed-package-transforms.js';
const file=new URL('../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('exact reviewed source produces deterministic guarded transforms and original AST exports',async()=>{
 const source=await fs.readFile(file),first=rewriteReviewedSlimServer(source),again=rewriteReviewedSlimServer(source);
 expect(hash(source)).toBe(SLIM_SERVER_SOURCE_SHA256);expect(first).toEqual(again);
 expect(first.outputSHA256).toBe(hash(first.contents));expect(first.transforms).toHaveLength(36);
 expect(first.contents).toContain('return { event: async () => {} };');
 expect(first.contents).toContain('ast_grep_search,\n  ast_grep_replace,\n  bindReviewedAstGrepAsset');
 expect(first.contents).toContain('throw new Error("reviewed_ast_asset_unbound")');
 expect(first.contents).toContain('var ast_grep_search = tool({');expect(first.contents).toContain('const output2 = formatReplaceResult(result, args.dryRun !== false)');
 expect(first.contents).not.toContain('v1Hooks = await OhMyOpenCodeLite(pluginInput)');
 expect(first.contents).not.toContain('const interviewBridge = createV2InterviewBridge(ctx, interviewConfig)');
 expect(first.contents).toContain('reviewed_slim_hook_missing');
 expect(first.contents).toContain('reviewed_interview_owner_required');
 expect(first.contents).toContain('await documents.resolveExisting(ctx.directory, outputFolder, idea)');
});
test('changed executable source cannot acquire reviewed transform authority',async()=>{
 const source=await fs.readFile(file);
 expect(()=>rewriteReviewedSlimServer(Buffer.concat([source,Buffer.from('\n')]))).toThrow('reviewed_slim_source_changed');
});
