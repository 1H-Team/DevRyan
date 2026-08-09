import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./UserDetail.tsx', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
const rolesSource = readFileSync(new URL('./RolePoliciesSection.tsx', import.meta.url), 'utf8');

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

  test('exposes Browser as both a role capability and a per-user tri-state override', () => {
    expect(typesSource).toContain("['browser', 'Browser']");
    expect(rolesSource).toContain("['can_use_browser', 'Browser']");
    expect(rolesSource).toContain('browser: draft.can_use_browser');
    expect(source).toContain('capabilityLabels.map(([key, label]) =>');
    expect(source).toContain('<option value="inherit">{inheritedLabel}</option>');
    expect(source).toContain('<option value="off">Off</option>');
  });

  test('exposes branch creation as a per-user tri-state capability override', () => {
    expect(typesSource).toContain("['createBranches', 'Create branches']");
    expect(typesSource).toContain("['createWorktrees', 'Create worktrees']");
    expect(source).toContain('capabilityLabels.map(([key, label]) =>');
    expect(source).toContain('value={policyDraft.capabilities[key]}');
  });
});
