import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const detailSource = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');

// Dialog behaviour is covered by ResetPasswordDialog.test.tsx. UserDetail is too
// heavy to mount here, so its wiring stays a source check.
describe('administrator password reset source contract', () => {
  test('opens a reset dialog from user details', () => {
    expect(detailSource).toContain('setResetPasswordOpen(true)');
    expect(detailSource).toContain('<ResetPasswordDialog');
  });
});
