import type {RuntimeBundleDescriptor} from './runtime-bundle.js';
import type {NativeBundleCredentialAction,NativeBundleCredentialResult} from './native-bundle-credential-contract.js';
export {NATIVE_BUNDLE_CREDENTIAL_CONTRACT,parseNativeBundleCredentialBoot} from './native-bundle-credential-contract.js';
export type {NativeBundleCredentialAction,NativeBundleCredentialBoot,NativeBundleCredentialResult} from './native-bundle-credential-contract.js';
export function runNativeBundleCredentialProcess(options:{readonly descriptor:RuntimeBundleDescriptor;readonly action:NativeBundleCredentialAction;readonly assertHeld:()=>Promise<void>;readonly captureArtifacts?:{readonly manifestPath:string;readonly manifestSha256:string};readonly timeoutMs?:number;readonly verifyArtifacts?:typeof import('./native-artifacts.js').verifyNativeRuntimeArtifacts}):Promise<NativeBundleCredentialResult>;
