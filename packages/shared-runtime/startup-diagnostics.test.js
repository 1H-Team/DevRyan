import { expect, test } from 'bun:test';
import { artifactDiagnostic, parseArtifactDiagnostic, startupDiagnosticSummary, describeArtifactFailure } from './startup-diagnostics.js';

const diagnostic = { stage: 'payload', reason: 'digest_mismatch', artifact: 'DevRyan-native-controller', purpose: 'current' };
test('startup diagnostics retain only bounded labels and packaged basenames', () => {
  expect(parseArtifactDiagnostic({ ...diagnostic, secret: 'private' })).toEqual(diagnostic);
  for (const artifact of ['/private/account', '../DevRyan-token', 'DevRyan-a\nsecret', 'DevRyan-' + 'a'.repeat(129)]) {
    expect(parseArtifactDiagnostic({ ...diagnostic, artifact })).toEqual({ stage: 'payload', reason: 'digest_mismatch', purpose: 'current' });
  }
  for (const field of ['stage', 'reason', 'purpose']) expect(parseArtifactDiagnostic({ ...diagnostic, [field]: 'secret' })).toBeUndefined();
  expect(artifactDiagnostic({ cause: { diagnostic } })).toEqual(diagnostic);
  const summary = startupDiagnosticSummary({ code: 'native_runtime_artifacts_unverified', diagnostic, attempt: 2, message: 'token', stack: '/private' });
  expect(JSON.parse(summary)).toEqual({ code: 'native_runtime_artifacts_unverified', diagnostic, attempt: 2 });
  expect(startupDiagnosticSummary({ code: '/private/token', attempt: -1 })).not.toContain('private');
  expect(describeArtifactFailure(diagnostic)).toContain('does not match');
});
