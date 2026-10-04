import path from 'node:path';
import type {ReviewedWebfetchContext,ReviewedWebfetchDefinition,ReviewedWebfetchInput,ReviewedWebfetchOwners} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

export interface ReviewedWebfetchOriginals {
 readonly createWebfetchTool:(context:unknown,options?:Readonly<Record<string,unknown>>)=>ReviewedWebfetchDefinition;
 readonly withReviewedWebfetchOwner:<T>(owner:ReviewedWebfetchOwners,action:()=>Promise<T>)=>Promise<T>;
}
export interface OwnedSlimWebfetchOwners extends Omit<ReviewedWebfetchOwners,'signal'|'sessionID'|'saveBinary'> {
 /** Fresh original caller/permit/epoch check; never a serialized policy fallback. */
 readonly assertCurrent:()=>Promise<void>;
 /** Recheck immediately before the existing owned publication commits, and settle on cancellation. */
 readonly saveBinary:(request:Parameters<ReviewedWebfetchOwners['saveBinary']>[0]&{readonly signal:AbortSignal;readonly recheck:()=>Promise<void>})=>Promise<string>;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Parse defaults through the exact package schemas; reject fields the package cannot execute. */
export function parseReviewedWebfetchInput(value:unknown,definition:ReviewedWebfetchDefinition):ReviewedWebfetchInput{
 if(!record(value)||Object.keys(value).some(key=>!Object.hasOwn(definition.args,key)))throw new Error('native_webfetch_input_invalid');
 const parsed:Record<string,unknown>={};
 for(const [key,schema] of Object.entries(definition.args))parsed[key]=schema.parse(value[key]);
 if(typeof parsed.url!=='string'||!['text','markdown','html'].includes(String(parsed.format))
  ||!['auto','always','never'].includes(String(parsed.prefer_llms_txt))
  ||typeof parsed.extract_main!=='boolean'||typeof parsed.include_metadata!=='boolean'||typeof parsed.save_binary!=='boolean'
  ||parsed.timeout!==undefined&&typeof parsed.timeout!=='number'||parsed.prompt!==undefined&&typeof parsed.prompt!=='string')throw new Error('native_webfetch_input_invalid');
 const format=parsed.format,prefer=parsed.prefer_llms_txt;
 if(format!=='text'&&format!=='markdown'&&format!=='html'||prefer!=='auto'&&prefer!=='always'&&prefer!=='never')throw new Error('native_webfetch_input_invalid');
 return {url:parsed.url,format,prefer_llms_txt:prefer,extract_main:parsed.extract_main,include_metadata:parsed.include_metadata,save_binary:parsed.save_binary,
  ...(typeof parsed.timeout==='number'?{timeout:parsed.timeout}:{}),...(typeof parsed.prompt==='string'?{prompt:parsed.prompt}:{})};
}

/** Original Slim algorithms with invocation-local authority. No ambient client, fetch, file write or DOM resolution. */
export function createOwnedSlimWebfetch(options:{
 readonly originals:ReviewedWebfetchOriginals;
 readonly configuration:Readonly<Record<string,unknown>>;
 readonly binaryDirectory:string;
 /** Capture the original small-model route once from the same frozen native configuration. */
 readonly smallModelRef?:()=>string|undefined;
 /** Owner supplies a cache scoped to the original authenticated grant and location. */
 readonly ownersFor:(context:ReviewedWebfetchContext)=>Promise<OwnedSlimWebfetchOwners>;
}):ReviewedWebfetchDefinition{
 if(!path.isAbsolute(options.binaryDirectory)||options.binaryDirectory.includes('\0'))throw new Error('native_webfetch_directory_invalid');
 const configuration=structuredClone(options.configuration);
 const smallModel=options.smallModelRef?.();
 const original=options.originals.createWebfetchTool({}, {...configuration,binaryDir:options.binaryDirectory,smallModelRef:()=>smallModel});
 return {...original,execute:async(value,context)=>{
  const input=parseReviewedWebfetchInput(value,original);
  if(!context.sessionID||!(context.abort instanceof AbortSignal))throw new Error('native_webfetch_context_invalid');
  context.abort.throwIfAborted();
  const owners=await options.ownersFor(context);
  const check=async()=>{context.abort.throwIfAborted();await owners.assertCurrent();context.abort.throwIfAborted();};
  await check();
  const bound:ReviewedWebfetchOwners={...owners,sessionID:context.sessionID,signal:context.abort,
   fetch:async(url,init)=>{
    await check();init.signal?.throwIfAborted();
    // Original initial permission includes fallback/probe URLs; each redirect still needs a fresh exact ask.
    await context.ask({permission:'webfetch',patterns:[url],always:[url],metadata:{url}});
    await check();
    const response=await owners.fetch(url,init);
    try{await check();return response;}catch(error){await response.body?.cancel().catch(()=>{});throw error;}
   },
   loadJSDOM:async()=>{await check();const loaded=await owners.loadJSDOM();await check();return loaded;},
   saveBinary:async(request)=>{
    await check();if(request.directory!==options.binaryDirectory||request.data.byteLength>10*1024*1024)throw new Error('native_webfetch_binary_invalid');
    const saved=await owners.saveBinary({...request,signal:context.abort,recheck:check});await check();
    if(!path.isAbsolute(saved)||!saved.startsWith(options.binaryDirectory+path.sep))throw new Error('native_webfetch_binary_path_invalid');return saved;
   },
   secondary:async(request)=>{
    await check();request.signal.throwIfAborted();
    const text=await owners.secondary(request);request.signal.throwIfAborted();await check();return text;
   }
  };
  const content=await options.originals.withReviewedWebfetchOwner(bound,()=>original.execute(input,context));
  await check();return content;
 }};
}
