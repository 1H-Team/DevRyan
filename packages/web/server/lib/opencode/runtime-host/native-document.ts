import path from 'node:path';
export interface NativeDocumentInput {readonly action:'list'|'read'|'search';readonly document_id?:string;readonly offset?:number;readonly limit?:number;readonly query?:string;readonly max_results?:number}
export interface NativeDocumentRecord {readonly id:string;readonly name:string;readonly type:string;readonly text:string;readonly characters:number;readonly pages?:number}
export interface NativeDocumentSource {readonly documentRecords:readonly NativeDocumentRecord[];readonly [key:string]:unknown}
export interface NativeDocumentPayload {readonly bytes:Uint8Array;readonly name:string;readonly type:string}
export interface NativeParsedDocument {readonly name:string;readonly type:string;readonly text:string;readonly pages?:number;readonly [key:string]:unknown}
export interface NativeDocumentParsed {readonly sourceType:string;readonly documents:readonly NativeParsedDocument[];readonly manifest:readonly Readonly<Record<string,unknown>>[]}
export interface NativeDocumentContext {readonly sessionID:string;readonly abort:AbortSignal}
export interface NativeDocumentDefinition {readonly description:string;readonly args:Readonly<Record<string,{readonly parse:(value:unknown)=>unknown}>>;readonly execute:(input:NativeDocumentInput,context:NativeDocumentContext)=>Promise<string>}
export interface NativeDocumentPart {readonly id:string;readonly url:string;readonly filename?:string;readonly mime?:string;readonly name?:string;readonly mimeType?:string}
export interface NativeDocumentOwners {
 readonly assertCurrent:()=>Promise<void>;
 /** Must use canonical current/parent lineage and recheck the original grant before returning. */
 readonly listAccessibleDocuments:(sessionID:string,directory:string)=>Promise<readonly {readonly document:NativeDocumentRecord;readonly depth:number}[]>;
 readonly findAccessibleDocument:(sessionID:string,directory:string,id:string)=>Promise<{readonly document:NativeDocumentRecord;readonly depth:number}|null>;
 /** Exact attachment read grant; local .git/protected roots and untrusted references are denied by the owner. */
 readonly readAttachment:(part:NativeDocumentPart)=>Promise<{readonly buffer:Uint8Array;readonly mime:string}>;
 /** Existing supervised parser; cancellation waits for real parser settlement. */
 readonly parseAttachment:(payload:NativeDocumentPayload,signal:AbortSignal)=>Promise<NativeDocumentParsed>;
 readonly readCachedSource:(sessionID:string,sourceID:string)=>Promise<NativeDocumentSource|null>;
 readonly saveParsedSource:(input:{readonly sessionID:string;readonly sourceID:string;readonly sourceName:string;readonly sourceHash:string;readonly parsed:NativeDocumentParsed},recheck:()=>Promise<void>)=>Promise<NativeDocumentSource>;
 readonly saveFailedSource:(input:{readonly sessionID:string;readonly sourceID:string;readonly sourceName:string;readonly sourceType:string;readonly failure:{readonly code:string;readonly message:string}},recheck:()=>Promise<void>)=>Promise<NativeDocumentSource>;
}
export interface NativeDocumentOriginals {
 readonly createDocumentTool:(input:{readonly client:unknown;readonly directory:string})=>NativeDocumentDefinition;
 readonly processFilePart:(input:{readonly part:NativeDocumentPart;readonly sessionID:string})=>Promise<string|null>;
 readonly withReviewedDocumentOwner:<T>(owner:Omit<NativeDocumentOwners,'assertCurrent'|'parseAttachment'|'saveParsedSource'|'saveFailedSource'>&{
  readonly parseAttachment:(payload:NativeDocumentPayload)=>Promise<NativeDocumentParsed>;
  readonly saveParsedSource:(input:Parameters<NativeDocumentOwners['saveParsedSource']>[0])=>Promise<NativeDocumentSource>;
  readonly saveFailedSource:(input:Parameters<NativeDocumentOwners['saveFailedSource']>[0])=>Promise<NativeDocumentSource>;
 },action:()=>Promise<T>)=>Promise<T>;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function createOwnedNativeDocument(options:{readonly originals:NativeDocumentOriginals;readonly directory:string;readonly ownersFor:(context:NativeDocumentContext)=>Promise<NativeDocumentOwners>}){
 if(!path.isAbsolute(options.directory)||options.directory.includes('\0'))throw new Error('native_document_directory_invalid');
 const definition=options.originals.createDocumentTool({client:null,directory:options.directory});
 const run=async<T>(context:NativeDocumentContext,action:()=>Promise<T>)=>{
  if(!context.sessionID||!(context.abort instanceof AbortSignal))throw new Error('native_document_context_invalid');
  let unsettled:unknown;
  const owner=await options.ownersFor(context),check=async()=>{if(unsettled)throw unsettled;context.abort.throwIfAborted();await owner.assertCurrent();context.abort.throwIfAborted();};
  const same=(sessionID:string,directory:string)=>{if(sessionID!==context.sessionID||directory!==options.directory)throw new Error('native_document_scope_mismatch');};
  await check();
  try{
  const content=await options.originals.withReviewedDocumentOwner({...owner,
   listAccessibleDocuments:async(sessionID,directory)=>{same(sessionID,directory);await check();const records=await owner.listAccessibleDocuments(sessionID,directory);await check();return records;},
   findAccessibleDocument:async(sessionID,directory,id)=>{same(sessionID,directory);await check();const found=await owner.findAccessibleDocument(sessionID,directory,id);await check();return found;},
   readAttachment:async(part)=>{await check();const read=await owner.readAttachment(part);if(read.buffer.byteLength>20*1024*1024)throw new Error('native_document_attachment_too_large');await check();return read;},
   readCachedSource:async(sessionID,id)=>{if(sessionID!==context.sessionID)throw new Error('native_document_scope_mismatch');await check();const cached=await owner.readCachedSource(sessionID,id);await check();return cached;},
   parseAttachment:async(payload)=>{await check();try{const parsed=await owner.parseAttachment(payload,context.abort);await check();return parsed;}
    catch(cause){if(record(cause)&&cause.nativeProcessUnsettled===true)unsettled=cause;throw cause;}},
   saveParsedSource:async(input)=>{if(input.sessionID!==context.sessionID)throw new Error('native_document_scope_mismatch');await check();const saved=await owner.saveParsedSource(input,check);await check();return saved;},
   saveFailedSource:async(input)=>{if(input.sessionID!==context.sessionID)throw new Error('native_document_scope_mismatch');await check();const saved=await owner.saveFailedSource(input,check);await check();return saved;}
  },action);if(unsettled)throw unsettled;await check();return content;
  }catch(cause){throw unsettled??cause;}
 };
 const tool={...definition,execute:async(input:NativeDocumentInput,context:NativeDocumentContext)=>{
  if(!record(input)||Object.keys(input).some(key=>!Object.hasOwn(definition.args,key)))throw new Error('native_document_input_invalid');
  for(const [key,schema] of Object.entries(definition.args))schema.parse(input[key]);
  return run(context,()=>definition.execute(input,context));
 }};
 return {tool,transformAttachment:(part:NativeDocumentPart,context:NativeDocumentContext)=>run(context,()=>options.originals.processFilePart({part,sessionID:context.sessionID}))};
}
