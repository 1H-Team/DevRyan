import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260819113809_reset_managed_account_model_defaults.sql',
  import.meta.url,
), 'utf8');

describe('managed account model-default cleanup migration', () => {
  it('removes only legacy model keys from non-admin policies', () => {
    expect(migration).toContain("- 'agentModelSelections'");
    expect(migration).toContain("- 'defaultModel'");
    expect(migration).toContain("- 'defaultVariant'");
    expect(migration).toContain("profile.role <> 'admin'");
    expect(migration).not.toMatch(/settings_overrides\s*=\s*'\{\}'/);
    expect(migration).not.toMatch(/delete\s+from\s+public\.user_policies/i);
  });
});
