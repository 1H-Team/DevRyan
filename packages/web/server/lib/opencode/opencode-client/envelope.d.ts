export const NO_CONTENT: Readonly<{noContent:true}>;
export function isNoContent(value:unknown):boolean;
export function readResponseBody(response:{status:number;text:()=>Promise<string>;body?:ReadableStream<Uint8Array>|null},options?:{maxResponseBytes?:number;signal?:AbortSignal;onResponseRead?:(event:{phase:'start'|'chunk'|'end';bytes:number})=>void}):Promise<{empty:boolean;text:string;value:unknown;parsed:boolean}>;
export function unwrapV1Payload(value:unknown):unknown;
export function unwrapData(value:unknown):unknown;
export function unwrapLocated(value:unknown):{location:Record<string,unknown>|null;data:unknown};
export function unwrapPage(value:unknown):{data:unknown[];next:string|undefined;previous:string|undefined};
export function unwrapList(value:unknown):unknown[];
