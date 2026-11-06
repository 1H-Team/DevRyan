export const NATIVE_MANAGED_SUBAGENT_JOB_CONTRACT = 'devryan.managed-subagent-jobs/1';

/** Only a verified selected artifact may supply this declaration. */
export const hasNativeManagedSubagentJobs = manifest => Array.isArray(manifest?.compiledContracts)
  && manifest.compiledContracts.includes(NATIVE_MANAGED_SUBAGENT_JOB_CONTRACT);
