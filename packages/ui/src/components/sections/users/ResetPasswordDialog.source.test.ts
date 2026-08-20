import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const dialogSource = readFileSync(new URL('./ResetPasswordDialog.tsx', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');

describe('administrator password reset source contract', () => {
  test('opens a reset dialog from user details', () => {
    expect(detailSource).toContain('setResetPasswordOpen(true)');
    expect(detailSource).toContain('<ResetPasswordDialog');
  });

  test('offers an explicit confirmed password and a generated temporary password', () => {
    expect(dialogSource).toContain('New Password');
    expect(dialogSource).toContain('Confirm Password');
    expect(dialogSource).toContain('password !== confirmation');
    expect(dialogSource).toContain('JSON.stringify({ password })');
    expect(dialogSource).toContain('Generate Temporary Password');
    expect(dialogSource).toContain('Set Password');
  });
});
