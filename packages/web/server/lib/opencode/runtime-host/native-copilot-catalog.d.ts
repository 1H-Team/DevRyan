import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import type { RegistrationOrigin } from './registration-origin.js';

export interface NativeProviderCatalogBinding {readonly directory:string;readonly controllerInstanceID:string;readonly integrationID:'github-copilot';readonly acquisitionID:string;readonly configurationDigest:string;readonly origin:{readonly id:string;readonly manifestDigest:string}}
export interface NativeCatalogController {readonly instanceID:string;readonly call:(input:{readonly action:'provider-catalog-selection-owned'}&NativeProviderCatalogBinding)=>Promise<unknown>}
export function createNativeCopilotCatalog(options:{readonly instanceID:string;readonly snapshot:NativeConfigurationSnapshot;readonly registrationOrigin:RegistrationOrigin;
  readonly controller:()=>NativeCatalogController;readonly isReady:()=>boolean;readonly withMutationQueue:<A>(action:()=>Promise<A>)=>Promise<A>;readonly fetchImpl?:typeof fetch}):{
  readonly handleRpc:(method:string,input:unknown,context?:{readonly signal?:AbortSignal})=>Promise<readonly unknown[]|null>;
  readonly close:()=>Promise<void>;
};
