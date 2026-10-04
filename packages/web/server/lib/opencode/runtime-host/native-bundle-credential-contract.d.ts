import type {NativeGlobalRoots} from './native-process-protocol.js';
import type {NativeBundleCredentialSnapshot,NativeBundleCredentialBinding} from './native-bundle-credentials.js';
export const NATIVE_BUNDLE_CREDENTIAL_CONTRACT:'devryan.bundle.credentials/2';
export type NativeBundleCredentialAction={readonly protocol:typeof NATIVE_BUNDLE_CREDENTIAL_CONTRACT;readonly action:'capture'}
 |{readonly protocol:typeof NATIVE_BUNDLE_CREDENTIAL_CONTRACT;readonly action:'project';readonly source:NativeBundleCredentialSnapshot;readonly binding:NativeBundleCredentialBinding};
export interface NativeBundleCredentialBoot {
 readonly protocol:typeof NATIVE_BUNDLE_CREDENTIAL_CONTRACT;readonly requestID:string;readonly instanceID:string;readonly buildID:string;readonly bundleID:string;
 readonly databasePath:string;readonly webDataDirectory:string;readonly globals:NativeGlobalRoots;readonly action:NativeBundleCredentialAction;
}
export type NativeBundleCredentialResult={readonly protocol:typeof NATIVE_BUNDLE_CREDENTIAL_CONTRACT;readonly status:'captured';readonly snapshot:NativeBundleCredentialSnapshot;readonly sha256:string}
 |({readonly protocol:typeof NATIVE_BUNDLE_CREDENTIAL_CONTRACT;readonly status:'projected';readonly appliedSha256:string}&NativeBundleCredentialBinding);
export function parseNativeBundleCredentialBoot(value:unknown):NativeBundleCredentialBoot;
export const NATIVE_BUNDLE_CREDENTIAL_BYTES:number;
export function nativeBundleCredentialFingerprint(value:unknown):string;
