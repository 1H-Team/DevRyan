export function resumeRuntimeBundle(input:{readonly controlRoot:string;readonly input:{readonly expectedRevision:number}}):Promise<{
 readonly state:'restart_required';readonly bundleID:string;readonly previousBundleID:string|null;readonly revision:number;
 readonly reconciliationRequired:false;readonly restartRequired:true}>;
