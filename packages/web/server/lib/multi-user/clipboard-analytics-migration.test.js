import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../../../supabase/migrations/20260810120000_clipboard_analytics_text.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('clipboard analytics migration', () => {
  it('adds bounded nullable clipboard columns without indexing copied content', () => {
    expect(migration).toContain('add column if not exists clipboard_text text');
    expect(migration).toContain('add column if not exists clipboard_text_preview text');
    expect(migration).toContain('add column if not exists clipboard_text_original_length integer');
    expect(migration).toContain('add column if not exists clipboard_text_truncated boolean');
    expect(migration).toContain('add column if not exists clipboard_text_redacted boolean');
    expect(migration).toContain('octet_length(clipboard_text) <= 65536');
    expect(migration).toContain('char_length(clipboard_text_preview) <= 512');
    expect(migration).not.toMatch(/create\s+index[\s\S]*clipboard_text/i);
  });
});
