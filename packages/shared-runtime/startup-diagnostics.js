const stages = new Set(['manifest', 'inventory', 'payload', 'signature', 'reviewed_asset', 'launcher']);
const reasons = new Set(['manifest_missing', 'manifest_invalid', 'unsupported_platform', 'digest_mismatch',
  'payload_missing', 'payload_invalid', 'mode_mismatch', 'signature_failure', 'reviewed_asset_mismatch', 'launcher_rejected']);
const purposes = new Set(['current', 'bundle-source', 'bundle-rollback']);

/** Only finite labels and a packaged basename may cross the startup boundary. */
export function parseArtifactDiagnostic(value) {
  if (!value || typeof value !== 'object' || !stages.has(value.stage) || !reasons.has(value.reason)
    || !purposes.has(value.purpose)) return undefined;
  return { stage: value.stage, reason: value.reason, purpose: value.purpose,
    ...(typeof value.artifact === 'string' && /^(?:native-bundle\.json|DevRyan-[A-Za-z0-9._-]{1,128})$/.test(value.artifact)
      ? { artifact: value.artifact } : {}) };
}

export function artifactDiagnostic(error) {
  return parseArtifactDiagnostic(error?.diagnostic) ?? parseArtifactDiagnostic(error?.cause?.diagnostic);
}

export function startupDiagnosticSummary(error) {
  const code = typeof error?.code === 'string' && /^(?:native|opencode|bundle|runtime)_[a-z0-9_]{1,100}$/.test(error.code)
    ? error.code : 'opencode_startup_failed';
  const diagnostic = artifactDiagnostic(error);
  return JSON.stringify({ code, ...(Number.isSafeInteger(error?.attempt) && error.attempt >= 0 ? { attempt: error.attempt } : {}),
    ...(diagnostic ? { diagnostic } : {}) }, null, 2);
}

const explanations = {
  manifest_missing: 'A required runtime manifest is missing.',
  manifest_invalid: 'The runtime manifest is invalid or incompatible.',
  unsupported_platform: 'The runtime was built for a different platform or architecture.',
  digest_mismatch: 'A runtime file does not match its verified contents.',
  payload_missing: 'A required runtime file is missing.',
  payload_invalid: 'A runtime file has an invalid location or file type.',
  mode_mismatch: 'A runtime file has incorrect permissions.',
  signature_failure: 'A runtime code signature could not be verified.',
  reviewed_asset_mismatch: 'A bundled runtime component does not match its approved version.',
  launcher_rejected: 'The runtime execution launcher could not be verified.',
};

export function describeArtifactFailure(value) {
  const diagnostic = parseArtifactDiagnostic(value);
  return diagnostic ? `${explanations[diagnostic.reason]}${diagnostic.artifact ? ` File: ${diagnostic.artifact}.` : ''} Your existing data has not been reset.`
    : 'The runtime files could not be verified. Your existing data has not been reset.';
}
