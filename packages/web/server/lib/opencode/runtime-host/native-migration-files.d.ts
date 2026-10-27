import type {MigrationRequest} from './native-process-protocol.js';
export function parseNativeImportChildProof(value:unknown,identity:{nonce:string;pid:number}):{protocol:'devryan.windows-native-import-child/1';nonce:string;pid:number;startIdentity:string;inJob:true;jobOwned:true;admission:false};
export function createNativeMigrationFiles(request:MigrationRequest,nonce:string|undefined):Promise<{read(file:string):Promise<unknown>;save(file:string,value:unknown):Promise<string>}>;
export function verifyNativeImportChild(nonce:string|undefined,scope:{operation:'migrate'|'relocate-bundle-harness';root:string;rootExclusions:'none'|'runtime-bundle';mutating:boolean}):Promise<unknown>;
