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

test('a refusal names its ledger and leases by identifier only', () => {
  const detail = { ledger: '8a7eca4fb393', secret: 'private', leases: [{ token: 'ac1af5a2-b846-40d3-80fb-a50fbbbadd2d', state: 'ready', kind: 'process', cleanupPending: false, scope: { text: 'private' } },
    { token: '/private/path', state: 'ready', kind: 'process' }] };
  const summary = startupDiagnosticSummary({ code: 'bundle_execution_unsettled', cause: { detail } });
  expect(JSON.parse(summary)).toEqual({ code: 'bundle_execution_unsettled',
    detail: { ledger: '8a7eca4fb393', leases: [{ token: 'ac1af5a2-b846-40d3-80fb-a50fbbbadd2d', state: 'ready', kind: 'process', cleanupPending: false }] } });
  expect(summary).not.toContain('private');
  expect(JSON.parse(startupDiagnosticSummary({ code: 'bundle_execution_unsettled', detail: { ledger: '../x', leases: [] } }))).toEqual({ code: 'bundle_execution_unsettled' });
});
