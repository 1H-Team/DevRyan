import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const benchmarkPath = fileURLToPath(new URL('./event-pipeline.bench.js', import.meta.url));

describe('event-pipeline benchmark', () => {
  it('waits for replay completion and exits with exact delta-byte integrity', () => {
    const result = spawnSync(process.execPath, [benchmarkPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_PIPELINE_BENCH_SCENARIO: 'small',
      },
      timeout: 15_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('bytes ✓');
    expect(result.stdout).not.toMatch(/bytes \d+→\d+/);
  });
});
