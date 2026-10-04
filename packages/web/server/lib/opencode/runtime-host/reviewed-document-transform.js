import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const REVIEWED_DOCUMENT_SOURCE_SHA256='bef4052f50aa08644dd0c2191ee07d6811c9e0cff57f0090afe9613895cf5de4';
/** Exact production parser/tool algorithms; I/O authority is constructor-bound per invocation. */
export function rewriteReviewedDocumentReader(source){
 if(hash(source)!==REVIEWED_DOCUMENT_SOURCE_SHA256)throw new Error('reviewed_document_source_changed');
 let contents=Buffer.from(source).toString('utf8');const transforms=[];
 const replace=(id,start,end,output)=>{
  if(contents.split(start).length!==2||contents.split(end).length!==2)throw new Error('reviewed_document_transform_changed');
  const at=contents.indexOf(start),until=contents.indexOf(end,at+start.length),original=contents.slice(at,until);
  if(until<0)throw new Error('reviewed_document_transform_changed');
  contents=contents.slice(0,at)+output+contents.slice(until);transforms.push({id,originalSHA256:hash(original),outputSHA256:hash(output)});
 };
 replace('owned-document-parser','const runWorkerParse = async (payload, options = {}) => {','const resolveConfigRoot = () => {',
  'const runWorkerParse = async (payload) => requireReviewedDocumentOwner().parseAttachment(payload);\n\n');
 replace('owned-document-cache-read','const readCachedSource = async (sessionID, sourceID) => {','const saveParsedSource = async (',
  'const readCachedSource = async (sessionID, sourceID) => requireReviewedDocumentOwner().readCachedSource(sessionID, sourceID);\n\n');
 replace('owned-document-cache-save','const saveParsedSource = async (','const saveFailedSource = async (',
  'const saveParsedSource = async (input) => requireReviewedDocumentOwner().saveParsedSource(input);\n\n');
 replace('owned-document-cache-failure','const saveFailedSource = async (','const decodeDataUrl = (url) => {',
  'const saveFailedSource = async (input) => requireReviewedDocumentOwner().saveFailedSource(input);\n\n');
 replace('owned-document-attachment','const readAttachmentBytes = async (part) => {','const renderFailure = (name, failure) => [',
  'const readAttachmentBytes = async (part) => requireReviewedDocumentOwner().readAttachment(part);\n\n');
 replace('owned-document-list','const listAccessibleDocuments = async (client, sessionID, directory) => {','// Whether any ancestor task',
  'const listAccessibleDocuments = async (client, sessionID, directory) => requireReviewedDocumentOwner().listAccessibleDocuments(sessionID, directory);\n\n');
 replace('owned-document-find','const findAccessibleDocument = async (client, sessionID, directory, documentID) => {','const fitJsonOutput = (value) => {',
  'const findAccessibleDocument = async (client, sessionID, directory, documentID) => requireReviewedDocumentOwner().findAccessibleDocument(sessionID, directory, documentID);\n\n');
 const original=Buffer.from(source).toString('utf8');
 const cacheStart='const getSessionKey = (sessionID) =>',cacheEnd='const decodeDataUrl = (url) => {';
 const cacheAt=original.indexOf(cacheStart),cacheUntil=original.indexOf(cacheEnd,cacheAt);
 const listStart='const listSessionDocuments = async (sessionID) => {',listEnd='const listAccessibleDocuments = async (client, sessionID, directory) => {';
 const listAt=original.indexOf(listStart),listUntil=original.indexOf(listEnd,listAt);
 if(cacheAt<0||cacheUntil<0||listAt<0||listUntil<0||[cacheStart,cacheEnd,listStart,listEnd].some(anchor=>original.split(anchor).length!==2))throw new Error('reviewed_document_cache_changed');
 const cacheOriginal=original.slice(cacheAt,cacheUntil)+original.slice(listAt,listUntil);
 let cache=cacheOriginal.replaceAll('fs.promises.','cacheFS.');
 const detached='void pruneCache().catch(() => undefined);';
 if(cache.split(detached).length!==2)throw new Error('reviewed_document_cache_changed');
 cache=cache.replace(detached,'await pruneCache();');
 for(const [name,end] of [['getSessionCacheBytes','let prunePromise = null;'],['pruneCache','const createDocumentID =']]){
  const start=`const ${name} = async`,at=cache.indexOf(start),until=cache.indexOf(end,at);
  if(at<0||until<0)throw new Error('reviewed_document_cache_maintenance_changed');
  const block=cache.slice(at,until).replace(start,`const ${name}Original = async`);
  cache=cache.slice(0,at)+block+`const ${name} = (...args) => maintenance.run(true, () => ${name}Original(...args));\n\n`+cache.slice(until);
 }

 const cacheExport=`
function createReviewedDocumentCache({root,authorizeWrite,authorizeRead=authorizeWrite}) {
 if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||typeof authorizeWrite!=='function'||typeof authorizeRead!=='function')throw new Error('reviewed_document_cache_owner_required');
 const maintenance=new DocumentAsyncLocalStorage();
 const check=async(file,write=false,reason='content',operation)=>{
  const relative=path.relative(root,file);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('reviewed_document_cache_scope_invalid');
  await (write?authorizeWrite:authorizeRead)(file,reason==='maintenance'?{reason,operation}:{reason});
 };
 const cacheFS={};
 for(const name of ['stat','readFile','readdir'])cacheFS[name]=async(file,...args)=>{const reason=name!=='readFile'&&maintenance.getStore()?'maintenance':'content';await check(file,false,reason,name);const result=await fs.promises[name](file,...args);await check(file,false,reason,name);return result;};
 for(const name of ['mkdir','chmod','writeFile','rename','rm','rmdir','utimes'])cacheFS[name]=async(file,...args)=>{const reason=(name==='rm'||name==='rmdir')&&maintenance.getStore()?'maintenance':'content';await check(file,true,reason,name);if(name==='rename')await check(args[0],true,'content');return fs.promises[name](file,...args);};
 const getCacheRoot=()=>root;
${cache}
 const run=action=>async(...args)=>{await check(root);const value=await action(...args);await check(root);return value;};
 return Object.freeze({readCachedSource:run(readCachedSource),readCachedDocument:run(readCachedDocument),listSessionDocuments:run(listSessionDocuments),saveParsedSource:run(saveParsedSource),saveFailedSource:run(saveFailedSource),prune:run(pruneCache)});
}
`;
 transforms.push({id:'owned-original-document-cache',originalSHA256:hash(cacheOriginal),outputSHA256:hash(cacheExport)});
 const output=`\nimport {AsyncLocalStorage as DocumentAsyncLocalStorage} from 'node:async_hooks';
${cacheExport}\nconst reviewedDocumentOwners=new DocumentAsyncLocalStorage();
function withReviewedDocumentOwner(owner,action){return reviewedDocumentOwners.run(owner,action);}
function requireReviewedDocumentOwner(){const owner=reviewedDocumentOwners.getStore();if(!owner)throw new Error('reviewed_document_owner_required');return owner;}
const reviewedDocumentDefinition=createDocumentTool({client:null,directory:''});
export const reviewedDocumentDescription=reviewedDocumentDefinition.description;
export const reviewedDocumentInputSchema=tool.schema.object(reviewedDocumentDefinition.args);
export {createDocumentTool,processFilePart,parseAttachmentPayload,classifyDocument,renderSource,createDocumentID,createSourceID,withReviewedDocumentOwner,createReviewedDocumentCache};\n`;
 contents+=output;transforms.push({id:'owned-document-exports',originalSHA256:hash(''),outputSHA256:hash(output)});
 return {contents,sourceSHA256:hash(source),outputSHA256:hash(contents),transforms};
}
