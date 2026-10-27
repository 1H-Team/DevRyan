import type {NativeDocumentOwners,NativeDocumentPart,NativeDocumentParsed,NativeDocumentPayload} from './native-document.js';
export interface NativeDocumentCache {
 readCachedSource:NativeDocumentOwners['readCachedSource'];
 saveParsedSource:(input:Parameters<NativeDocumentOwners['saveParsedSource']>[0])=>ReturnType<NativeDocumentOwners['saveParsedSource']>;
 saveFailedSource:(input:Parameters<NativeDocumentOwners['saveFailedSource']>[0])=>ReturnType<NativeDocumentOwners['saveFailedSource']>;
 listSessionDocuments:(sessionID:string)=>Promise<readonly import('./native-document.js').NativeDocumentRecord[]>;
 readCachedDocument:(sessionID:string,documentID:string)=>Promise<import('./native-document.js').NativeDocumentRecord|null>;
}
export function createNativeDocumentOwner(options:{
 locations:readonly {directory:string;readRoots?:readonly string[];protectedRoots?:readonly string[]}[];cacheRoot:string;
 createCache:(options:{root:string;authorizeWrite:(path:string,context?:{reason:'content'}|{reason:'maintenance';operation:'stat'|'readdir'|'rm'|'rmdir'})=>Promise<void>;authorizeRead:(path:string,context?:{reason:'content'}|{reason:'maintenance';operation:'stat'|'readdir'|'rm'|'rmdir'})=>Promise<void>})=>NativeDocumentCache;
 readSession:(input:{sessionID:string;directory:string})=>Promise<{id:string;directory:string;parentID?:string;revert?:unknown;time?:{archived?:number}}>;
 readUserAttachments:(input:{sessionID:string;directory:string})=>Promise<readonly {messageID:string;part:NativeDocumentPart}[]>;
 authorizeParent:(input:{sessionID:string;parentID:string;directory:string;sourceSessionID:string})=>Promise<void>;
 parseAttachment:(payload:NativeDocumentPayload,signal:AbortSignal)=>Promise<NativeDocumentParsed>;
}):{ownersFor:(input:{sessionID:string;directory:string;assertCurrent:()=>Promise<void>;signal:AbortSignal})=>Promise<NativeDocumentOwners>};
