import type {RegistrationOrigin} from './registration-origin.js';
import type {MutationPublication} from '../../../../../harness-runtime/lib/session-mutations.js';
export interface NativeContextAssetsScope {directory:string;sessionID:string;messageID:string;messageIDs:readonly string[];permit:unknown}
export interface CapturedContextAssets {
 anchor:{id:string;type:'user'|'synthetic'|'compaction';fingerprint:string};messageIDs:readonly string[];
 contextAssetID:string;recheck:()=>Promise<void>;origin:RegistrationOrigin;
 messages:Record<string,unknown>[];imageRouting:'auto'|'direct';disabledAgents:readonly string[];
}
export interface NativeContextAssetsResult {
 messages:Record<string,unknown>[];imagesSkipped:boolean;contextAssetID:string;publication:MutationPublication;
 receipt:{terminated:boolean;confined:boolean;cancelled:boolean;exitCode:number};
}
export function executeNativeContextAssets(input:NativeContextAssetsScope,options:{signal?:AbortSignal}|undefined,deps:unknown):Promise<NativeContextAssetsResult>;
