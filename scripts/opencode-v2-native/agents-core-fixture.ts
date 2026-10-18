// Tests import a fresh single-file agents-core bundle, like the compiled
// controller, so module-level bindings (hosts, AST asset, image worker) never
// leak between fixtures that share one Bun test process.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type * as AgentsCore from '../../packages/agents-core/index.js';

export const AGENTS_CORE_ENTRY=path.resolve(import.meta.dir,'../../packages/agents-core/src/devryan/index.ts');

/** Bundles agents-core into `directory` (a test's own temp root) and returns its file URL. */
export async function bundleAgentsCore(directory:string):Promise<string>{
 const built=await Bun.build({entrypoints:[AGENTS_CORE_ENTRY],target:'bun',outdir:directory,naming:'agents-core-[hash].mjs'});
 const output=built.outputs[0];
 if(!built.success||built.outputs.length!==1||!output)throw new AggregateError(built.logs,'agents-core bundle failed');
 return pathToFileURL(output.path).href;
}

export async function importAgentsCore(directory:string):Promise<typeof AgentsCore>{
 return import(await bundleAgentsCore(directory));
}
