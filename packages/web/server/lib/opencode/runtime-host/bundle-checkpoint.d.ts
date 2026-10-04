import type {RuntimeBundleSource,RuntimeBundleCheckpoint,RuntimeBundleCheckpointScope} from './runtime-bundle.js';
interface CheckpointController {
 readonly pid?:number;
 readonly hasExited:()=>boolean;
 readonly call:(input:{readonly action:'quiesce'})=>Promise<unknown>;
 readonly close:()=>Promise<unknown>;
}
export function createRuntimeBundleCheckpoint(options:{
 readonly ownerID:string;readonly generation:1|2;
 readonly launch:{readonly opencodeDatabasePath:string;readonly webDataDirectory:string;readonly webConfigDirectory:string;readonly opencodeConfigDirectory:string;readonly global?:{readonly state:string}};
 readonly closeAdmission:()=>Promise<unknown>;readonly getController:()=>CheckpointController|null|undefined;
 readonly stopProducers:()=>Promise<unknown>;readonly drainStores:()=>Promise<unknown>;
 readonly executionHost:{readonly drain:()=>Promise<unknown>};readonly afterExit?:()=>Promise<unknown>;
 readonly readProcessIdentity?:(pid:number)=>{readonly pid:number;readonly startIdentity:string}|null;
 readonly beforeControllerStop?:()=>Promise<unknown>;readonly assertAdmissionClosed?:()=>Promise<unknown>;readonly neverStarted?:boolean;
}):<A>(source:RuntimeBundleSource,action:(proof:RuntimeBundleCheckpoint,scope:RuntimeBundleCheckpointScope)=>Promise<A>)=>Promise<A>;
