import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260826140000_bot_environment_secrets.sql',
  import.meta.url,
), 'utf8');

describe('Bot environment secrets and generated-image idempotency migration', () => {
  it('stores metadata only behind forced service-role RLS', () => {
    expect(migration).toContain('create table public.bot_environment_secrets');
    expect(migration).not.toMatch(/\bvalue\s+text\b/i);
    expect(migration).toContain('alter table public.bot_environment_secrets enable row level security');
    expect(migration).toContain('alter table public.bot_environment_secrets force row level security');
    expect(migration).toContain('revoke all on table public.bot_environment_secrets from public, anon, authenticated');
    expect(migration).toContain('grant all on table public.bot_environment_secrets to service_role');
    expect(migration).toContain('references public.bots(id) on delete cascade');
    expect(migration).toContain("select '20260826140000'::text");
  });

  it('adds a partial unique source key for idempotent generated-image publication', () => {
    expect(migration).toContain('add column source_key text');
    expect(migration).toContain('on public.bot_shared_files (bot_id, source_key)');
    expect(migration).toContain('where source_key is not null');
  });
});
