import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./NewWorktreeDialog.tsx', import.meta.url)),
  'utf8',
);

describe('NewWorktreeDialog fork repository routing', () => {
  test('retains issue and pull-request source repositories when sending context', () => {
    expect(source).toContain('sourceRepo: args.issue.sourceRepo ?? null');
    expect(source).toContain('sourceRepo: args.pr.sourceRepo ?? null');
    expect((source.match(/sourceRepo: args\.issue\.sourceRepo \?\? null/g) ?? []).length).toBe(2);
  });

  test('forwards the authoritative project when worktree bootstrap completes', () => {
    expect(source).toContain('projectId: projectRef.id');
    expect((source.match(/projectId: projectRef\.id/g) ?? []).length).toBe(2);
  });

  test('does not reset submitted branch fields when the worktree list updates', () => {
    expect(source).toContain('const initializedOpenCycleRef = React.useRef(false)');
    expect(source).toContain('if (initializedOpenCycleRef.current) return');
  });
});
