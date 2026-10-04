import type {Tool} from '@opencode/schema/tool';
export interface NativeImagegenInput {readonly prompt:string;readonly out:string;readonly quality:'low'|'medium'|'high'|'auto';readonly size?:string;readonly images?:readonly string[]}
export interface NativeImagegenRequest {readonly prompt:string;readonly quality:NativeImagegenInput['quality'];readonly size?:string;readonly referenceImages:readonly string[]}
export interface NativeImagegenOriginals {
 readonly withReviewedImagegenOwner:<A>(owner:{readonly fetch?:typeof fetch;readonly readFile?:(absolute:string)=>Promise<Buffer>;readonly writeFile?:(absolute:string,bytes:Buffer)=>Promise<void>;readonly generate?:(args:NativeImagegenInput,references:readonly string[])=>Promise<string>},action:()=>Promise<A>)=>Promise<A>;
 readonly callReviewedImagegenResponses:(auth:{readonly access:string;readonly accountId?:string},args:Pick<NativeImagegenInput,'prompt'|'quality'|'size'>,references:readonly string[])=>Promise<string>;
 readonly parseReviewedImagegenSSE:(stream:ReadableStream<Uint8Array>)=>Promise<string>;
 readonly GptImagePlugin:(input:unknown)=>Promise<{readonly tool:{readonly gpt_imagegen:{readonly execute:(args:NativeImagegenInput,context:{readonly directory:string})=>Promise<{readonly output:string;readonly metadata:{readonly out:string;readonly versioned:boolean;readonly billing:'subscription'}}>}}}>;
 readonly reviewedImagegenDescription:string;
 readonly reviewedImagegenInputSchema:Tool.ValueSchema<NativeImagegenInput> & {parse(value:unknown):NativeImagegenInput};
}
