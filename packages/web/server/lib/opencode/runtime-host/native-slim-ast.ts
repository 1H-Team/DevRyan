import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {AstSearchInput,AstReplaceInput,ReviewedAstDefinition} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {Permission} from '@opencode/core/permission';
import type {WorkerInput,NativeResult} from './worker-protocol.js';
import {REVIEWED_AST_ASSET_SHA256} from './reviewed-package-transforms.js';

export type AstWorkerInput=Extract<WorkerInput,{tool:'ast_grep_search'|'ast_grep_replace'}>;
const inside=(root:string,file:string)=>file===root||file.startsWith(root+path.sep);
const protectedPath=(file:string)=>file.split(/[\\/]/).some(part=>part.toLowerCase()==='.git');
const record=(input:unknown):input is Record<string,unknown>=>!!input&&typeof input==='object'&&!Array.isArray(input);
const strings=(input:unknown):string[]|undefined=>{
 if(input===undefined)return;
 if(!Array.isArray(input))throw new Error('native_ast_input_invalid');
 return input.map((item:unknown)=>{if(typeof item!=='string')throw new Error('native_ast_input_invalid');return item;});
};

/** Original package schemas validate every field after native before hooks. */
export function validateReviewedAstInput(input:unknown,tool:AstWorkerInput['tool'],definition:Pick<ReviewedAstDefinition<unknown>,'args'>):AstSearchInput|AstReplaceInput{
 if(!record(input)||Object.keys(input).some(key=>!Object.hasOwn(definition.args,key)))throw new Error('native_ast_input_invalid');
 for(const [key,schema] of Object.entries(definition.args))schema.parse(input[key]);
 if(typeof input.pattern!=='string'||typeof input.lang!=='string')throw new Error('native_ast_input_invalid');
 const common={pattern:input.pattern,lang:input.lang,paths:strings(input.paths),globs:strings(input.globs)};
 if(tool==='ast_grep_search'){
  if(input.context!==undefined&&typeof input.context!=='number')throw new Error('native_ast_input_invalid');
  return {...common,...(input.context===undefined?{}:{context:input.context})};
 }
 if(typeof input.rewrite!=='string'||input.dryRun!==undefined&&typeof input.dryRun!=='boolean')throw new Error('native_ast_input_invalid');
 return {...common,rewrite:input.rewrite,...(input.dryRun===undefined?{}:{dryRun:input.dryRun})};
}

/** No CLI flags, protected metadata, escaping paths or symlink paths become AST operands. */
export async function rebaseReviewedAstPaths(paths:readonly string[]|undefined,request:AstWorkerInput):Promise<string[]>{
 return Promise.all((paths?.length?paths:['.']).map(async value=>{
  if(!value||value.startsWith('-')||value.includes('\0')||protectedPath(value))throw new Error('native_ast_path_denied');
  const logical=path.resolve(request.logicalDirectory,value);
  if(!inside(request.logicalProjectDirectory,logical))throw new Error('native_ast_path_denied');
  const target=path.join(request.projectDirectory,path.relative(request.logicalProjectDirectory,logical));
  if(protectedPath(target)||await fs.realpath(target)!==target)throw new Error('native_ast_path_denied');
  return path.relative(request.directory,target)||'.';
 }));
}

/** Executed only by the already supervised private-view worker, never the controller. */
export async function runReviewedAstWorker(request:AstWorkerInput,callbacks:{
 readonly assertPermission:(input:Permission.AssertInput)=>Promise<void>;
 readonly progress:(update:Readonly<Record<string,unknown>>)=>Promise<void>;
}):Promise<typeof NativeResult.Type>{
 if(!path.isAbsolute(request.reviewedAst.path)||path.basename(request.reviewedAst.path)!=='DevRyan-ast-grep-darwin-arm64'
  ||request.reviewedAst.sha256!==REVIEWED_AST_ASSET_SHA256||await fs.realpath(request.reviewedAst.path)!==request.reviewedAst.path
  ||await fs.realpath(request.directory)!==request.directory||process.cwd()!==request.directory
  ||!inside(request.projectDirectory,request.directory))throw new Error('native_ast_worker_boundary_invalid');
 const stat=await fs.lstat(request.reviewedAst.path);
 if(!stat.isFile()||!(stat.mode&0o111)||stat.size>64*1024*1024)throw new Error('native_ast_asset_invalid');
 const bytes=await fs.readFile(request.reviewedAst.path);
 if(createHash('sha256').update(bytes).digest('hex')!==REVIEWED_AST_ASSET_SHA256)throw new Error('native_ast_asset_invalid');
 const originals=await import('../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js');
 const definition=request.tool==='ast_grep_search'?originals.ast_grep_search:originals.ast_grep_replace;
 const input=validateReviewedAstInput(request.input,request.tool,definition);
 const paths=await rebaseReviewedAstPaths(input.paths,request);
 if(input.globs?.some(value=>value.includes('\0')||protectedPath(value)))throw new Error('native_ast_path_denied');
 await callbacks.assertPermission({sessionID:request.context.sessionID,agent:request.context.agent,action:request.tool,
  resources:input.paths?.length?[...input.paths]:['.'],source:{type:'tool',messageID:request.context.messageID,id:request.context.id}});
 originals.bindReviewedAstGrepAsset(request.reviewedAst.path);
 const updates:Readonly<Record<string,unknown>>[]=[];
 const context={metadata:(update:{readonly metadata:{readonly output:string}})=>{updates.push(update.metadata);}};
 // Explicit user globs can override the CLI's normal hidden-file exclusion.
 // Keep metadata exclusion last so no positive user glob can admit it.
 const globs=[...(input.globs??[]),'!.[gG][iI][tT]/**','!**/.[gG][iI][tT]/**'];
 const content=request.tool==='ast_grep_search'?await originals.ast_grep_search.execute({...input,paths,globs},context)
  :'rewrite' in input?await originals.ast_grep_replace.execute({...input,paths,globs},context):(()=>{throw new Error('native_ast_input_invalid');})();
 for(const update of updates)await callbacks.progress(update);
 // The original tool returns failures as formatted strings. A failed apply
 // must discard its private contribution rather than publish partial writes.
 if(content.startsWith('Error:'))throw new Error(content);
 return {content};
}
