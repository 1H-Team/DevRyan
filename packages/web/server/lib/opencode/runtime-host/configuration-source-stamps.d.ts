import type {RuntimeBundleDescriptor} from './runtime-bundle.js';
export function captureConfigurationSourceStamp(input:{readonly launch:RuntimeBundleDescriptor['launch'];readonly directories:readonly string[];readonly skillSources?:readonly {readonly directory:string}[];readonly additionalPaths?:readonly string[]}):Promise<string>;
