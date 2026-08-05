import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260804100000_user_profile_github_account.sql',
  import.meta.url,
), 'utf8');

describe('profile GitHub association migration', () => {
  it('backfills the default association before a deterministic non-default fallback', () => {
    expect(migration).toContain('add column github_account_id text');
    expect(migration.indexOf('and access.is_default')).toBeLessThan(
      migration.lastIndexOf('order by access.created_at, access.project_id'),
    );
  });

  it('keeps the oldest profile as the exclusive owner of a legacy account', () => {
    expect(migration).toContain('partition by github_account_id');
    expect(migration).toContain('order by created_at, id');
    expect(migration).toContain('candidate.owner_rank = 1');
    expect(migration).toContain('create unique index user_profiles_github_account_id_idx');
    expect(migration).toContain('where github_account_id is not null');
  });

  it('keeps every project-access compatibility mirror synchronized', () => {
    expect(migration).toContain('devryan_apply_profile_github_account');
    expect(migration).toContain('devryan_sync_profile_github_account');
    expect(migration).toContain('github_account_id is distinct from new.github_account_id');
  });
});
