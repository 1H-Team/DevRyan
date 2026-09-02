import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260903110000_bot_memory_extraction_inline_claim.sql',
  import.meta.url,
), 'utf8');

describe('Bot memory extraction inline claim migration', () => {
  it('claims one specific queued job without stealing a lease or re-classifying persisted candidates', () => {
    expect(migration).toContain('function public.devryan_claim_bot_memory_extraction_job_by_run');
    expect(migration).toContain('where candidate.run_id = p_run_id');
    expect(migration).toContain("and candidate.state = 'queued'");
    expect(migration).toContain('and candidate.candidate_envelope is null');
    expect(migration).toContain("where active.bot_id = candidate.bot_id and active.state = 'leased'");
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain('attempt_count = attempt_count + 1');
    expect(migration).toContain(
      'grant execute on function public.devryan_claim_bot_memory_extraction_job_by_run(uuid, text, timestamptz)',
    );
  });

  it('bumps the schema marker', () => {
    expect(migration).toContain("select '20260903110000'::text");
    expect(migration).not.toMatch(/drop\s+(table|column|function)/i);
  });
});
