import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260825120000_bot_shared_files.sql',
  import.meta.url,
), 'utf8');

describe('Bot Shared files migration', () => {
  it('keeps mappings service-only, conversation-bound, and traversal-safe', () => {
    expect(migration).toContain('create table public.bot_shared_files');
    expect(migration).toContain("copy_state in ('pending', 'copying', 'ready', 'failed')");
    expect(migration).toContain("computer_path = '/workspace/Shared/' || channel_id::text");
    expect(migration).toContain('alter table public.bot_shared_files force row level security');
    expect(migration).toContain('revoke all on table public.bot_shared_files from public, anon, authenticated');
    expect(migration).toContain('constraint bot_shared_files_message_object_key unique (message_id, object_id)');
    expect(migration).toContain('create index bot_shared_files_object_idx');
    expect(migration).toContain('create index bot_shared_files_sender_idx');
  });

  it('inserts mappings with admission and never skips a blocked FIFO head', () => {
    expect(migration).toContain('p_shared_files jsonb');
    expect(migration).toContain('insert into public.bot_shared_files');
    const candidate = migration.indexOf('with candidate as');
    const readiness = migration.indexOf('ready_candidate as');
    expect(candidate).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(candidate);
    expect(migration).toContain("shared_file.copy_state <> 'ready'");
    expect(migration).toContain("select '20260825120000'::text");
  });
});
