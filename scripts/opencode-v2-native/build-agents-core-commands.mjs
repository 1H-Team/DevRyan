// Bun-only helper for the package lane's Node oracle: bundles the agents-core
// command factories (deepwork, loop, reflect) into <outdir> and prints the
// agents-core source files the bundle linked.
import path from 'node:path';

const [outdir]=process.argv.slice(2);
if(!outdir||!path.isAbsolute(outdir))throw new Error('Absolute output directory required');
const repository=path.resolve(import.meta.dir,'../..'),hooks=path.join(repository,'packages/agents-core/src/hooks');
const entry=path.join(outdir,'commands-entry.ts');
await Bun.write(entry,[['createDeepworkCommandHook','deepwork'],['createLoopCommandHook','loop-command'],['createReflectCommandHook','reflect']]
 .map(([name,directory])=>`export {${name}} from ${JSON.stringify(path.join(hooks,directory,'index.ts'))};`).join('\n')+'\n');
const built=await Bun.build({entrypoints:[entry],target:'node',format:'esm',outdir,naming:'commands.mjs',metafile:true});
if(!built.success||!built.metafile)throw new AggregateError(built.logs,'agents-core command bundle failed');
const root=path.join(repository,'packages/agents-core')+path.sep;
const sources=Object.keys(built.metafile.inputs).map(file=>path.resolve(repository,file)).filter(file=>file.startsWith(root))
 .map(file=>path.relative(repository,file)).sort();
console.log(JSON.stringify({module:path.join(outdir,'commands.mjs'),sources}));
