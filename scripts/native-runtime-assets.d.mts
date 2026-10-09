import type {BunPlugin} from 'bun';
export const NATIVE_ASSET_SOURCE_SHA:Readonly<Record<'pty'|'photon',string>>;
export function rewriteNativeAsset(kind:'pty'|'photon',source:Uint8Array,options?:{assetPath?:string;assetSha256?:string}):string;
export function rewriteSealedNodeRequire(source:string):string;
export const NATIVE_AGENT_DEFAULTS_SOURCE_SHA256:string;
export function rewriteNativeAgentDefaults(source:Uint8Array):string;
export function rewriteUnavailableNativePty(source:Uint8Array):string;
export const REVIEWED_PONYTAIL_MODULE:'devryan:reviewed-ponytail-instructions';
export const REVIEWED_AST_FILENAME:'DevRyan-ast-grep-darwin-arm64';
export interface ReviewedNativeInputs {
 readonly inputFiles:ReadonlyMap<string,string>;
 readonly resolutions:ReadonlyMap<string,string>;
 readonly rewrites:ReadonlyMap<string,string>;
 readonly virtualModules:ReadonlyMap<string,string>;
 readonly transforms:readonly Readonly<Record<string,unknown>>[];
 readonly provenance:readonly {readonly id:string;readonly version:string;readonly sourceKind:string;readonly sourceLocation:string;readonly license:unknown}[];
 readonly ast:{readonly source:string;readonly path:string;readonly sha256:string};
 readonly claudeAssets:Readonly<Record<'claude'|'libsql',{readonly source:string;readonly path:string;readonly sha256:string;readonly version:string;readonly mode:number}>>;
}
export function prepareReviewedNativeInputs(repository:string,options?:{target?:'darwin-arm64'|'win32-x64'|'win32-arm64'}):Promise<ReviewedNativeInputs>;
export function reviewedNativeInputPlugin(input:Pick<ReviewedNativeInputs,'rewrites'|'virtualModules'|'inputFiles'|'resolutions'>):BunPlugin;
