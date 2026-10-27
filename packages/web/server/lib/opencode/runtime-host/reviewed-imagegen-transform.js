import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const REVIEWED_IMAGEGEN_SOURCE_SHA256='37fc82bf739d0a87a8f6274ffe3b180d4d20c4d3381f5d7d89c0f5c483f32246';
/** Preserve original schema, request body, SSE parser and versioned PNG save. */
export function rewriteReviewedImagegen(source){
 if(hash(source)!==REVIEWED_IMAGEGEN_SOURCE_SHA256)throw Error('reviewed_imagegen_source_changed');
 let contents=Buffer.from(source).toString('utf8');const transforms=[];
 const exact=(id,before,after)=>{if(contents.split(before).length!==2)throw Error('reviewed_imagegen_transform_changed');contents=contents.replace(before,after);transforms.push({id,originalSHA256:hash(before),outputSHA256:hash(after)});};
 const start=contents.indexOf('// src/auth.ts'),end=contents.indexOf('// src/codex.ts');
 if(start<0||end<start)throw Error('reviewed_imagegen_transform_changed');
 exact('close-ambient-auth',contents.slice(start,end),'');
 exact('pure-original-tool-builder','import { tool } from "@opencode-ai/plugin";','import { tool } from "@opencode-ai/plugin/tool";');
 exact('retained-model-hotfix','var SUBSCRIPTION_MODEL = "gpt-5.5";','var SUBSCRIPTION_MODEL = "gpt-6-astra";');
 exact('retained-effort-hotfix','    model: SUBSCRIPTION_MODEL,','    model: SUBSCRIPTION_MODEL,\n    reasoning: { effort: "medium" },');
 exact('owned-fetch','const res = await fetch(CODEX_RESPONSES_ENDPOINT, {','const res = await requireReviewedImagegenOwner().fetch(CODEX_RESPONSES_ENDPOINT, {');
 exact('owned-reference-read','const buf = await fs2.readFile(abs);','const buf = await requireReviewedImagegenOwner().readFile(abs);');
 exact('owned-versioned-write','await fs3.writeFile(savedPath, Buffer.from(base64, "base64"));','await requireReviewedImagegenOwner().writeFile(savedPath, Buffer.from(base64, "base64"));');
 exact('owned-generation',`          const auth = await loadOpenAIAuth();
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.");
          }
          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory);
          const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls);`,`          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory);
          const base64 = await requireReviewedImagegenOwner().generate(args, inputImageDataUrls);`);
 const a=contents.indexOf('        description: ['),b=contents.indexOf('        args: {',a),c=contents.indexOf('        async execute(args, ctx) {',b);
 if(a<0||b<a||c<b)throw Error('reviewed_imagegen_transform_changed');
 const description=contents.slice(a+'        description: '.length,b).trim().replace(/,$/,''),args=contents.slice(b+'        args: '.length,c).trim().replace(/,$/,'');
 exact('original-registration-schema',contents.slice(a,c),'        description: reviewedImagegenDescription,\n        args: reviewedImagegenArguments,\n');
 const exported=`\nimport {AsyncLocalStorage} from 'node:async_hooks';
const imagegenOwners=new AsyncLocalStorage();
function requireReviewedImagegenOwner(){const owner=imagegenOwners.getStore();if(!owner)throw Error('reviewed_imagegen_owner_required');return owner;}
export function withReviewedImagegenOwner(owner,action){return imagegenOwners.run(owner,action);}
export const reviewedImagegenDescription=${description};
const reviewedImagegenArguments=${args};
export const reviewedImagegenInputSchema=tool.schema.object(reviewedImagegenArguments);
export {GptImagePlugin,callViaCodexResponses as callReviewedImagegenResponses,parseImageGenerationResultFromSSE as parseReviewedImagegenSSE};\n`;
 contents+=exported;transforms.push({id:'owned-exports',originalSHA256:hash(''),outputSHA256:hash(exported)});
 return {contents,sourceSHA256:hash(source),outputSHA256:hash(contents),transforms};
}
/** The captured optional color helper is absent; close runtime package discovery. */
export function rewriteReviewedImagegenDebug(source){
 if(hash(source)!=='d7b26d7c92f8ea7794b77ce11f3c11cd18c9084df7c357e3c7025344fa28aac6')throw Error('reviewed_imagegen_debug_changed');
 const before="const supportsColor = require('supports-color');",after='const supportsColor = undefined;',text=Buffer.from(source).toString('utf8');
 if(text.split(before).length!==2)throw Error('reviewed_imagegen_debug_changed');return text.replace(before,after);
}
