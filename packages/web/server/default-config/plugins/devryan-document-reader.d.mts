/** Source-hash-guarded native integration exports; ambient legacy plugin setup is never invoked. */
import type {NativeDocumentOriginals,NativeDocumentPayload,NativeDocumentParsed} from '../../lib/opencode/runtime-host/native-document.ts';
export const reviewedDocumentDescription:string;
export const reviewedDocumentInputSchema:import('@opencode/schema/tool').Tool.ValueSchema<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentInput>;
export const createDocumentTool:NativeDocumentOriginals['createDocumentTool'];
export const processFilePart:NativeDocumentOriginals['processFilePart'];
export const withReviewedDocumentOwner:NativeDocumentOriginals['withReviewedDocumentOwner'];
/** Existing original parser; the host must run it through its supervised parser owner. */
export function parseAttachmentPayload(input:NativeDocumentPayload):Promise<NativeDocumentParsed>;
export function createDocumentID(sourceHash:string,entryName:string):string;
export function createSourceID(sourceHash:string,sourceName:string):string;

export interface ReviewedDocumentCache {readonly readCachedSource:(sessionID:string,sourceID:string)=>Promise<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentSource|null>;readonly readCachedDocument:(sessionID:string,documentID:string)=>Promise<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentRecord|null>;readonly listSessionDocuments:(sessionID:string)=>Promise<readonly import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentRecord[]>;readonly saveParsedSource:(input:Parameters<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentOwners['saveParsedSource']>[0])=>Promise<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentSource>;readonly saveFailedSource:(input:Parameters<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentOwners['saveFailedSource']>[0])=>Promise<import('../../lib/opencode/runtime-host/native-document.ts').NativeDocumentSource>;readonly prune:()=>Promise<void>}
export function createReviewedDocumentCache(input:{readonly root:string;readonly authorizeWrite:(file:string,context:{readonly reason:'content'}|{readonly reason:'maintenance';readonly operation:'stat'|'readdir'|'rm'|'rmdir'})=>Promise<void>;readonly authorizeRead?:(file:string,context:{readonly reason:'content'}|{readonly reason:'maintenance';readonly operation:'stat'|'readdir'|'rm'|'rmdir'})=>Promise<void>}):ReviewedDocumentCache;
