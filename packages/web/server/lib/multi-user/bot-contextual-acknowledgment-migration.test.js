import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260829130000_bot_contextual_acknowledgments.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot contextual acknowledgment migration', () => {
  it('admits one unresolved assistant response for later phase promotion', () => {
    expect(migration).toContain('p_acknowledgment_id uuid');
    expect(migration).toContain('p_acknowledgment_body_envelope jsonb');
    expect(migration).toContain("'assistant',\n      'pending'");
    expect(migration).toContain('p_finalized_at,\n      null');
    expect(migration).toContain("'acknowledgment', pg_catalog.to_jsonb(acknowledgment)");
  });

  it('accepts an idempotent row after pending has become acknowledgment or result', () => {
    expect(migration).toContain('where id = p_acknowledgment_id');
    expect(migration).toContain("assistant_phase not in ('pending', 'acknowledgment', 'result')");
    expect(migration).toContain("assistant_phase in ('pending', 'acknowledgment', 'result')");
    expect(migration).toContain("errcode = '23505'");
    expect(migration).toContain('Bot response idempotency conflict');
  });

  it('remains service-role-only, security-invoker, and advances the marker', () => {
    expect(migration).toContain('security invoker');
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
    expect(migration).toContain("select '20260829130000'::text");
  });
});
