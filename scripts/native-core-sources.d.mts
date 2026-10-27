export const NATIVE_CORE_SOURCE_SIGNATURES:Readonly<Record<'pty'|'compaction'|'finalization',string>>;
export const NATIVE_PHOTON_WORKER_SOURCE:string;
export function isNativePhotonWorkerSource(file:string):boolean;
export function findNativeCoreSources(coreRoot:string):Promise<Readonly<Record<'pty'|'compaction'|'finalization',string>>>;
export function nativeCoreSourceFilter(...files:string[]):RegExp;
