import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const REVIEWED_BROWSER_SOURCE_SHA256='64f49724a62f824aa2ae7546cbea4bf08048618a7216d22deb3e2484dbe845dd';
/** Retain original validation, lease/sequence state and output algorithms; close ambient authority. */
export function rewriteReviewedBrowser(source){
 if(hash(source)!==REVIEWED_BROWSER_SOURCE_SHA256)throw new Error('reviewed_browser_source_changed');
 let contents=Buffer.from(source).toString('utf8');const transforms=[];
 const replace=(id,start,end,output)=>{
  if(contents.split(start).length!==2||contents.split(end).length!==2)throw new Error('reviewed_browser_transform_changed');
  const at=contents.indexOf(start),until=contents.indexOf(end,at+start.length),original=contents.slice(at,until);
  if(until<0)throw new Error('reviewed_browser_transform_changed');
  contents=contents.slice(0,at)+output+contents.slice(until);transforms.push({id,originalSHA256:hash(original),outputSHA256:hash(output)});
 };
 replace('owned-browser-environment','const getManagedEnvironment = () => {','// A confined worker cannot write the install root,',
  'const getManagedEnvironment = () => requireReviewedBrowserOwner().environment;\n\n');
 replace('owned-browser-ffmpeg','const managedFfmpegDirectory = (binaryPath) => {',"// Rust's Command uses posix_spawn",
  'const managedFfmpegDirectory = () => requireReviewedBrowserOwner().environment.ffmpegDirectory;\n\n');
 const original='const runBinary = ({',replacement='const runBinary = input => requireReviewedBrowserOwner().runBinary(input);\nconst runReviewedBrowserBinary = ({';
 if(contents.split(original).length!==2)throw new Error('reviewed_browser_transform_changed');contents=contents.replace(original,replacement);transforms.push({id:'owned-browser-launch',originalSHA256:hash(original),outputSHA256:hash(replacement)});
 replace('owned-browser-private-transport','const requestJson = async ({ environment, url, method, body, signal, errorCode }) => {','const retryOnceOnTransportFailure = async (operation) => {',
  'const requestJson = async input => requireReviewedBrowserOwner().requestLease(input);\n\n');
 replace('owned-browser-canonical-turn','const resolveTurnMessageID = async (scope, client) => {','export const DevRyanBrowserPlugin = async (pluginContext = {}) => {',
  'const resolveTurnMessageID = async scope => requireReviewedBrowserOwner().resolveTurn(scope);\n\n');
 // Native execution is always confined; caller environment cannot disable the sequence restriction.
 const confined="process.env.DEVRYAN_EXECUTION_WORKER === '1' && String(input?.command)";
 if(contents.split(confined).length!==2)throw new Error('reviewed_browser_transform_changed');
 contents=contents.replace(confined,'String(input?.command)');transforms.push({id:'owned-browser-confined-recording',originalSHA256:hash(confined),outputSHA256:hash('String(input?.command)')});
 // Register the exact original public schema without constructing a lease client in the controller.
 const declarationStart="        description: 'Drive a temporary DevRyan in-app browser lease";
 const argsStart='        args: {',executeStart='        async execute(input, context) {';
 if(contents.split(declarationStart).length!==2||contents.split(argsStart).length!==2||contents.split(executeStart).length!==2)throw new Error('reviewed_browser_transform_changed');
 const declarationAt=contents.indexOf(declarationStart),argsAt=contents.indexOf(argsStart,declarationAt),executeAt=contents.indexOf(executeStart,argsAt);
 const description=contents.slice(declarationAt+'        description: '.length,argsAt).trim().replace(/,$/,'');
 const args=contents.slice(argsAt+'        args: '.length,executeAt).trim().replace(/,$/,'');
 const registration=contents.slice(declarationAt,executeAt);
 const registrationOutput='        description: reviewedBrowserDescription,\n        args: reviewedBrowserArguments,\n';
 contents=contents.slice(0,declarationAt)+registrationOutput+contents.slice(executeAt);
 const declarations=`\nexport const reviewedBrowserDescription=${description};\nconst reviewedBrowserArguments=${args};\nexport const reviewedBrowserInputSchema=tool.schema.object(reviewedBrowserArguments);\n`;
 contents+=declarations;transforms.push({id:'owned-browser-registration-schema',originalSHA256:hash(registration),outputSHA256:hash(registrationOutput+declarations)});
 const exports=`\nimport {AsyncLocalStorage as BrowserAsyncLocalStorage} from 'node:async_hooks';
const reviewedBrowserOwners=new BrowserAsyncLocalStorage();
function withReviewedBrowserOwner(owner,action){return reviewedBrowserOwners.run(owner,action);}
function requireReviewedBrowserOwner(){const owner=reviewedBrowserOwners.getStore();if(!owner)throw new Error('reviewed_browser_owner_required');return owner;}
export {withReviewedBrowserOwner,runReviewedBrowserBinary};\n`;
 contents+=exports;transforms.push({id:'owned-browser-exports',originalSHA256:hash(''),outputSHA256:hash(exports)});
 return {contents,sourceSHA256:hash(source),outputSHA256:hash(contents),transforms};
}
