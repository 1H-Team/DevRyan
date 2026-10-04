import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const fail=()=>Object.assign(new Error('native_reviewed_configuration_unverified'),{code:'native_reviewed_configuration_unverified',status:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const command=value=>record(value)&&typeof value.description==='string'&&typeof value.template==='string'
  &&Object.keys(value).every(key=>['description','template'].includes(key));

/** Only a manifest-verified, self-contained asset may supply executable configuration. */
export async function loadNativeReviewedConfiguration({reviewedConfiguration:asset,manifest}) {
  if(!asset)return undefined;
  if(!path.isAbsolute(asset.path)||path.basename(asset.path)!=='DevRyan-native-configuration.mjs'
    ||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>16*1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256))throw fail();
  const stat=await fs.lstat(asset.path);
  if(!stat.isFile()||await fs.realpath(asset.path)!==asset.path||(stat.mode&0o777)!==0o644||stat.size!==asset.size)throw fail();
  const bytes=await fs.readFile(asset.path);
  if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw fail();
  // Import the bytes that passed the digest check; a later path replacement
  // cannot switch the module between validation and execution.
  const loaded=await import('data:text/javascript;base64,'+bytes.toString('base64'));
  if(!record(loaded.reviewedImagegenOriginals)||['withReviewedImagegenOwner','callReviewedImagegenResponses'].some(key=>typeof loaded.reviewedImagegenOriginals[key]!=='function')
    ||loaded.nativeBuildID!==manifest.buildId||typeof loaded.resolveSlimAgents!=='function'||typeof loaded.createReviewedDocumentCache!=='function'
    ||!record(loaded.reviewedSlimInterviewOriginals)||['createInterviewService','createInterviewHandler','resolveExistingInterviewPath','InterviewDocumentOwnershipError'].some(key=>typeof loaded.reviewedSlimInterviewOriginals[key]!=='function')
    ||typeof loaded.createOwnedNativeDocument!=='function'||!record(loaded.reviewedDocumentOriginals)
    ||['createDocumentTool','processFilePart','withReviewedDocumentOwner'].some(key=>typeof loaded.reviewedDocumentOriginals[key]!=='function')
    ||['createReviewedSlimTaskBoardRenderer','formatReviewedSlimTaskBoard','isReviewedSlimFailoverError','selectReviewedSlimFallback'].some(key=>typeof loaded[key]!=='function')
    ||!record(loaded.slimCommandDeclarations)||Object.keys(loaded.slimCommandDeclarations).sort().join(',')!=='deepwork,loop,reflect'
    ||!Object.values(loaded.slimCommandDeclarations).every(command)||!command(loaded.interviewCommandDeclaration)||!command(loaded.ponytailCommandDeclaration)
    ||!record(loaded.ponytailCommands)||Object.keys(loaded.ponytailCommands).sort().join(',')!=='ponytail,ponytail-audit,ponytail-debt,ponytail-gain,ponytail-help,ponytail-review'
    ||!Object.values(loaded.ponytailCommands).every(command)
    ||!record(loaded.ponytailInstructions)||Object.keys(loaded.ponytailInstructions).sort().join(',')!=='full,lite,review,ultra'
    ||!Object.values(loaded.ponytailInstructions).every(value=>typeof value==='string'&&value.length>0))throw fail();
  return Object.freeze({reviewedImagegenOriginals:Object.freeze({...loaded.reviewedImagegenOriginals}),resolveSlimAgents:loaded.resolveSlimAgents,createReviewedDocumentCache:loaded.createReviewedDocumentCache,
    reviewedSlimInterviewOriginals:loaded.reviewedSlimInterviewOriginals,
    createOwnedNativeDocument:loaded.createOwnedNativeDocument,reviewedDocumentOriginals:loaded.reviewedDocumentOriginals,
    createReviewedSlimTaskBoardRenderer:loaded.createReviewedSlimTaskBoardRenderer,formatReviewedSlimTaskBoard:loaded.formatReviewedSlimTaskBoard,
    isReviewedSlimFailoverError:loaded.isReviewedSlimFailoverError,selectReviewedSlimFallback:loaded.selectReviewedSlimFallback,
    slimCommandDeclarations:structuredClone(loaded.slimCommandDeclarations),interviewCommandDeclaration:structuredClone(loaded.interviewCommandDeclaration),ponytailInstructions:structuredClone(loaded.ponytailInstructions),
    ponytailCommands:structuredClone(loaded.ponytailCommands),
    ponytailCommandDeclaration:structuredClone(loaded.ponytailCommandDeclaration)});
}
