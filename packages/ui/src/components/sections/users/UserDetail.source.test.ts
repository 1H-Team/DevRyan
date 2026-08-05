import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');

describe('user profile editing source contract', () => {
  test('drafts and explicitly saves display name, role, status, and the profile GitHub association', () => {
    expect(source).toContain('const [profileDraft, setProfileDraft]');
    expect(source).toContain('displayName: user.display_name');
    expect(source).toContain('displayName: normalizedDisplayName');
    expect(source).toContain('Display Name');
    expect(source).toContain('githubAccountId: profileDraft.githubAccountId || null');
    expect(source).toContain('Save Profile');
    expect(source).toContain('disabled={busy || !profileDirty || !normalizedDisplayName}');
    expect(source).toContain("toast.error(error instanceof Error ? error.message : 'Failed to save profile')");
  });

  test('keeps project branch saves independent from GitHub identity selection', () => {
    const branchSave = source.slice(
      source.indexOf('const saveBranchAccess'),
      source.indexOf('const removeProjectAccess'),
    );
    const projectsSection = source.slice(
      source.indexOf('title="Projects & Branches"'),
      source.indexOf('title="Policy Overrides"'),
    );

    expect(branchSave).not.toContain('githubAccountId');
    expect(projectsSection).not.toContain('GitHub Account');
  });
});
