import type {RuntimeBundleDescriptor} from './runtime-bundle.js';
import type {LoadedNativeSettings} from './native-configuration-snapshot.js';
export interface NativeTextReference{readonly path:string;readonly content:string;readonly size:number;readonly sha256:string}
export function captureNativeTextSettings(input:{readonly loaded:LoadedNativeSettings;readonly directory:string;readonly launch:RuntimeBundleDescriptor['launch'];readonly captureSlimPrompts?:boolean}):Promise<{readonly agents:Record<string,unknown>;readonly commands:Record<string,unknown>;readonly instructions:readonly NativeTextReference[];readonly textReferences:readonly NativeTextReference[];readonly slimPrompts:Record<string,{readonly prompt?:string;readonly appendPrompt?:string}>}>;
export function verifyNativeTextSettings(references:readonly NativeTextReference[]):Promise<void>;
