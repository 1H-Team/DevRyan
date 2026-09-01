import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260829120000_bot_acknowledgment_admission.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot acknowledgment admission migration', () => {
  it('admits one finalized semantic acknowledgment in the message transaction', () => {
    expect(migration).toContain('p_acknowledgment_id uuid');
    expect(migration).toContain('p_acknowledgment_body_envelope jsonb');
    expect(migration).toContain("assistant_phase = 'acknowledgment'");
    expect(migration).toContain("'assistant',\n      'acknowledgment'");
    expect(migration).toContain("'acknowledgment', pg_catalog.to_jsonb(acknowledgment)");
    expect(migration).toContain('p_finalized_at,\n      p_finalized_at');
  });

  it('keeps retries idempotent and fails on a mismatched receipt identity', () => {
    expect(migration).toContain('where run_id = admitted_run_id');
    expect(migration).toContain('acknowledgment.id <> p_acknowledgment_id');
    expect(migration).toContain("errcode = '23505'");
    expect(migration).toContain('Bot acknowledgment idempotency conflict');
  });

  it('remains service-role-only, security-invoker, and advances the marker', () => {
    expect(migration).toContain('security invoker');
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
    expect(migration).toContain("select '20260829120000'::text");
  });
});
