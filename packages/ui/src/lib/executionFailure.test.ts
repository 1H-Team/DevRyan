import { expect, test } from 'bun:test';
import { describeExecutionFailure } from './executionFailure';
test('explains typed startup failures and preserves uncertainty about cleanup', () => {
  expect(describeExecutionFailure('local_execution_timeout')).toContain('startup deadline');
  expect(describeExecutionFailure('local_execution_timeout; execution did not start; cleanup unconfirmed')).toContain('Wait for recovery');
  expect(describeExecutionFailure('payload_too_large')).toContain('Reduce attached context');
  expect(describeExecutionFailure('provider error')).toBeUndefined();
});
