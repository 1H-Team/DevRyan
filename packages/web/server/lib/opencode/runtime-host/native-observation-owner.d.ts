import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import type {NativeAdmissionOwner} from './native-admission-owner.js';
import type {NativeObservation} from './native-observation-contract.js';
export interface NativeObservationOwnerOptions {
 readonly instanceID:string;readonly snapshot:Pick<NativeConfigurationSnapshot,'digest'> & {readonly locations:ReadonlyArray<Pick<NativeConfigurationSnapshot['locations'][number],'directory'>>};
 readonly controller:()=>{readonly instanceID:string}|undefined;readonly isReady:()=>boolean;
 readonly admissionOwner:Pick<NativeAdmissionOwner,'withProviderAttempt'>;
 readonly openCodeClient:{readonly sessions:{readonly message:(sessionID:string,messageID:string,options:{readonly directory:string})=>Promise<{
   readonly info:{readonly id:string;readonly sessionID:string;readonly role:string;readonly parentID?:string;readonly agent?:string;readonly providerID?:string;readonly modelID?:string;readonly variant?:string|null};
   readonly turnOwnership?:{readonly source:string;readonly userMessageID?:string}}|undefined>}};
 readonly recordDiagnostic:(entry:{readonly type:'lifecycle';readonly event:'native_observation';readonly sessionID:string;readonly directory:string;readonly payload:NativeObservation}
  |{readonly type:'gap';readonly event:'native_observation_gap';readonly sessionID?:string;readonly payload:{readonly stage?:string;readonly code:'native_observation_gap'}})=>unknown;
}
export function createNativeObservationOwner(options:NativeObservationOwnerOptions):{
 readonly observeAcceptedUser:(input:Omit<Extract<NativeObservation,{stage:'accepted-user'}>,'schema'|'stage'|'controllerInstanceID'|'configurationDigest'>)=>null;
 readonly handleRpc:(method:string,input:unknown)=>Promise<null>;
};
