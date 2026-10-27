/** Reports only the verified, selected native controller. It never probes PATH or offers an installer. */
export const createOpenCodeResolutionRuntime = ({getNativeBundle,getDetectedOpenCodeVersion=()=>null}) => ({
  getOpenCodeResolutionSnapshot() {
    const bundle=getNativeBundle();
    if(bundle?.descriptor.generation!==2)throw Object.assign(new Error('native_runtime_bundle_required'),{code:'native_runtime_bundle_required',status:503});
    return {targetVersion:bundle.artifacts.manifest.opencodeVersion,detectedVersion:getDetectedOpenCodeVersion(),resolved:bundle.artifacts.controller,
      source:'verified-native-bundle',launchBinary:bundle.artifacts.controller,launchArgs:[],viaWsl:false};
  },
});
