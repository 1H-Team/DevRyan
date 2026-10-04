import type {RuntimeBundleDescriptor} from './runtime-bundle.js';
import type {NativeTextReference} from './native-text-settings.js';
export function captureNativePonytailDefault(input:{readonly launch:RuntimeBundleDescriptor['launch'];readonly environmentDefaultMode?:string}):Promise<{readonly defaultMode:'off'|'lite'|'full'|'ultra';readonly source:'environment'|'configuration'|'default';readonly references:readonly NativeTextReference[]}>;
