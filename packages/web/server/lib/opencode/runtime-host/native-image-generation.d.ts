import type {NativeExecutionAuthorization} from './native-admission-owner.js';
import type {NativeOpenAiAttempt} from './native-openai-auth.js';
import type {NativeImagegenOriginals,NativeImagegenRequest} from './native-imagegen.js';
export type NativeImageGenerationArguments=NativeImagegenRequest;
export type NativeImageGenerationOriginals=Pick<NativeImagegenOriginals,'withReviewedImagegenOwner'|'callReviewedImagegenResponses'>;
export function createNativeImageGeneration(options:{
  readonly withImageGeneration:<A>(invocation:NativeExecutionAuthorization,action:(owner:{readonly access:()=>Promise<NativeOpenAiAttempt>;readonly recheck:()=>Promise<void>})=>Promise<A>)=>Promise<A>;
  readonly originals:NativeImageGenerationOriginals;readonly fetchImpl?:typeof fetch;
}):(invocation:NativeExecutionAuthorization,args:NativeImageGenerationArguments,options?:{readonly signal?:AbortSignal})=>Promise<{readonly base64:string}>;
