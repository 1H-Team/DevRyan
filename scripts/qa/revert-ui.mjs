// The old binary-driven UI fixture is retired. Current native UI verification
// is owned by native-backend-ui-diagnostic and the v2 matrix journeys.
export async function verifyRevertUi() {
  throw Object.assign(new Error('Legacy binary-driven Revert UI verification is retired; use the native v2 QA matrix'), { code: 'qa_native_diagnostic_unavailable' });
}
