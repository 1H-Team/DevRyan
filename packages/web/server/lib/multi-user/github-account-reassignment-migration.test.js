import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260804120000_github_account_reassignment.sql',
  import.meta.url,
), 'utf8');

describe('GitHub account reassignment migration', () => {
  it('performs the transfer under ordered profile row locks', () => {
    expect(migration).toContain('devryan_reassign_github_account');
    expect(migration).toContain('order by profile.id');
    expect(migration).toContain('for update');
    expect(migration).toContain('set github_account_id = null');
    expect(migration).toContain('set github_account_id = normalized_account_id');
  });

  it('rejects destination displacement and preserves server-only execution', () => {
    expect(migration).toContain('GITHUB_ASSIGNMENT_TARGET_CONFLICT');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('set search_path = \'\'');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
  });
});
