import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const admissionMigration = fs.readFileSync(path.resolve(
  directory,
  '../../../../../supabase/migrations/20260824030000_bot_message_admission_timestamps.sql',
), 'utf8');
const markerMigration = fs.readFileSync(path.resolve(
  directory,
  '../../../../../supabase/migrations/20260824040000_bot_revision_history.sql',
), 'utf8');

describe('Production Bots message-admission repair migration', () => {
  it('uses the finalized timestamp for both immutable message timestamps', () => {
    expect(admissionMigration).toContain('created_at,\n    finalized_at');
    expect(admissionMigration).toMatch(/p_finalized_at,\s+p_finalized_at\s+\)/);
  });

  it('advances the service-role-only fail-closed schema marker', () => {
    expect(markerMigration).toContain('public.devryan_bot_schema_version()');
    expect(markerMigration).toContain('drop constraint if exists bot_revisions_bot_hash_key');
    expect(markerMigration).toContain("select '20260824040000'::text");
    expect(markerMigration).toContain('grant execute on function public.devryan_bot_schema_version()');
    expect(markerMigration).not.toMatch(
      /grant execute[^;]+devryan_bot_schema_version[^;]+to (?:anon|authenticated)/i,
    );
  });
});
