export interface ArtifactDiagnostic {
  stage: 'manifest' | 'inventory' | 'payload' | 'signature' | 'reviewed_asset' | 'launcher';
  reason: 'manifest_missing' | 'manifest_invalid' | 'unsupported_platform' | 'digest_mismatch'
    | 'payload_missing' | 'payload_invalid' | 'mode_mismatch' | 'signature_failure' | 'reviewed_asset_mismatch' | 'launcher_rejected';
  purpose: 'current' | 'bundle-source' | 'bundle-rollback';
  artifact?: string;
}
export function parseArtifactDiagnostic(value: unknown): ArtifactDiagnostic | undefined;
export function artifactDiagnostic(error: unknown): ArtifactDiagnostic | undefined;
export function describeArtifactFailure(value: unknown): string;
export function startupDiagnosticSummary(error: unknown): string;
