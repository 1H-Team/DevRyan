export function createNativeReadGuard(options:{readonly directory:string;readonly readRoots?:readonly string[];readonly protectedRoots?:readonly string[]}):(target:string)=>Promise<void>;
export function nativeWebfetchBinaryDirectory(tmp:string,directory:string):string;
export function canonicalTarget(target:string):Promise<string>;
