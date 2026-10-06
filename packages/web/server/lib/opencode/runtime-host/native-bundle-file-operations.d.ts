import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
export function nativeBundleFileOperations(options?:{readonly windowsOwner?:WindowsPrivateFileOwner}):{
 readonly windows:boolean;readonly windowsOwner:WindowsPrivateFileOwner|undefined;
 ensureDirectory(directory:string):Promise<unknown>;
 writeFresh(file:string,bytes:string|Uint8Array):Promise<unknown>;
 withSqliteOutput<A>(file:string,action:(file:string)=>A|Promise<A>):Promise<A>;
};
