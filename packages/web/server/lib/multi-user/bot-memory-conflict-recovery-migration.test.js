import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260901130000_bot_memory_extraction_conflict_recovery.sql',
  import.meta.url,
), 'utf8');

describe('Bot memory extraction conflict recovery migration', () => {
  it('requeues only the exact terminal classification conflict and resets its budget', () => {
    expect(migration).toContain("job.state = 'terminal'");
    expect(migration).toContain("job.last_phase = 'classification'");
    expect(migration).toContain("job.last_error_code = 'bot_revision_conflict'");
    expect(migration).toContain("run.state = 'completed'");
    expect(migration).toContain("success.result = 'success'");
    expect(migration).toContain("state = 'queued'");
    expect(migration).toContain('attempt_count = 0');
    expect(migration).toContain('completed_at = null');
    expect(migration).toContain("select '20260901130000'::text");
    expect(migration).not.toMatch(/delete\s+from\s+public\.bot_audit_events/i);
  });
});
