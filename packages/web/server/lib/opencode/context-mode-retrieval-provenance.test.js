import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { normalizeNativeServerSource, patchNativeServerSource } from './context-mode-native-hotfix.js';

// Pinned ctx_search formatting anchors. Exercise the transformed function, not
// a second implementation of the origin policy. Real workers cover both sorts.
const source = `function fixture(r) {
        const MAX_TOTAL = 40 * 1024; // 40KB total cap
        let totalSize = 0;
        const sections = [];
        const origin = r.origin || "current-session";
        return { origin, sections };
}
`;

describe('Context Mode retrieval provenance', () => {
  const patched = patchNativeServerSource(source);
  const fixture = vm.runInNewContext(
    `${patched.slice(patched.indexOf('function fixture'), patched.indexOf('// DevRyan worker lifecycle'))}; fixture;`,
  );

  it.each([undefined, 'current-session'])('labels shared content as project-index for origin %s', (origin) => {
    const result = fixture({ origin });
    expect(result.origin).toBe('project-index');
    expect(result.sections.join('\n')).toContain('not the current assignment');
    expect(result.sections.join('\n')).toContain('do not infer it from search results or timeline recency');
  });

  it.each(['prior-session', 'auto-memory'])('preserves distinct %s provenance', (origin) => {
    expect(fixture({ origin }).origin).toBe(origin);
  });

  it('normalizes back to the pinned source so upgrades remain hash-checked and idempotent', () => {
    expect(normalizeNativeServerSource(patched)).toBe(source);
    expect(patchNativeServerSource(normalizeNativeServerSource(patched))).toBe(patched);
  });
});
