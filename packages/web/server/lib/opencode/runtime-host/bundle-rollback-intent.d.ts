import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import type {RuntimeBundleSelection, RuntimeBundleDescriptor, RuntimeBundleCheckpoint} from './runtime-bundle.js';
export interface RollbackSettlement {
 readonly host:{readonly pid:number;readonly startIdentity:string};
 readonly controller:{readonly pid:number;readonly startIdentity:string;readonly instanceID:string;readonly code:0;readonly signal:null;
 readonly receipt:{readonly path:string;readonly terminated:true;readonly confined:true;readonly cancelled:false;readonly exitCode:0};readonly receiptSha256:string};
 readonly registries:readonly {readonly name:string;readonly sha256:string|null}[];
 readonly credentialDrained:true;readonly storesDrained:true;
}
export interface RollbackIntent {
 readonly protocol:'devryan.bundle.rollback-intent/1';readonly state:'pending'|'completed'|'resuming'|'resumed';readonly revision:number;
 readonly candidateBundleID:string;readonly targetBundleID:string;readonly candidateDescriptorSha256:string;readonly candidatePreparedSha256:string;
 readonly candidateManifestSha256:string;readonly targetDescriptorSha256:string;readonly targetPreparedSha256:string;readonly expectedTargetCredentialSha256:string;readonly targetManifestSha256:string;readonly nativeCredentialSha256:string;
 readonly hostOwners:{readonly protocol:'devryan.bundle.credential-owners/2';readonly sha256:string;readonly accountDirectories:Readonly<Record<string,string>>};readonly files:readonly {readonly path:string;readonly sha256:string}[];
 readonly checkpoint:RuntimeBundleCheckpoint;readonly settlement:RollbackSettlement;readonly completion?:Readonly<Record<string,unknown>>;readonly resumeRevision?:number;
}
export function rollbackIntentPath(root:string):string;
export function parseRollbackIntent(value:unknown):RollbackIntent;
export function readRollbackIntentSync(root:string):RollbackIntent|null;
export function rollbackIntentUnresolved(intent:RollbackIntent|null,selection:RuntimeBundleSelection):boolean;
export function saveRollbackIntent(root:string,intent:RollbackIntent,options?:{readonly windowsOwner?:WindowsPrivateFileOwner}):Promise<void>;
export function assertPrivateBundleControlRoot(root:string,uid?:number):Promise<void>;
export function processIdentity(pid:number):{readonly pid:number;readonly startIdentity:string}|null;
export function assertRollbackPhysicalExit(intent:RollbackIntent,candidate:RuntimeBundleDescriptor,readIdentity?:(pid:number)=>{readonly pid:number;readonly startIdentity:string}|null):Promise<void>;

export function captureRollbackFiles(root:string):Promise<readonly {readonly path:string;readonly sha256:string}[]>;

export function captureRollbackRegistries(stateDirectory:string):Promise<readonly {readonly name:string;readonly sha256:string|null}[]>;
