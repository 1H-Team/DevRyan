import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../../supabase/migrations/20260824213000_bot_complete_delete.sql',
  import.meta.url,
);

describe('complete Bot deletion migration', () => {
  it('allows only Draft or Retired resource purge and advances the schema marker', async () => {
    const migration = await fs.readFile(migrationUrl, 'utf8');

    expect(migration).toContain("target_bot.lifecycle not in ('draft', 'retired')");
    expect(migration).toContain("select '20260824213000'::text");
    expect(migration).toContain('grant execute on function public.devryan_purge_bot_resource');
    expect(migration).not.toMatch(
      /grant execute[^;]+devryan_purge_bot_resource[^;]+to (?:anon|authenticated)/i,
    );
  });
});
