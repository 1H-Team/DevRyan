import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260827230926_branch_preview_access.sql',
  import.meta.url,
), 'utf8');

describe('branch preview migration', () => {
  it('keeps credentials in the host vault and cascades with branch grants', () => {
    expect(migration).toContain('create table public.user_branch_previews');
    expect(migration).toContain('service_token_vault_ref text');
    expect(migration).not.toMatch(/client_secret|client_id/i);
    expect(migration).toContain('references public.user_project_branches(user_id, project_id, branch_name)');
    expect(migration).toContain('on delete cascade');
  });

  it('is service-role-only and forces RLS', () => {
    expect(migration).toContain('alter table public.user_branch_previews enable row level security');
    expect(migration).toContain('alter table public.user_branch_previews force row level security');
    expect(migration).toContain('revoke all on table public.user_branch_previews from public, anon, authenticated');
    expect(migration).toContain('grant all on table public.user_branch_previews to service_role');
  });
});
