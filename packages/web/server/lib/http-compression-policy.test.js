import { describe, it, expect } from 'vitest';
import { createCompressionPolicy } from './http-compression-policy.js';

describe('HTTP compression boundary', () => {
  it('preserves SSE exclusions and dynamically reads API compression policy', () => {
    let disabled = false;
    const { shouldSkipCompression } = createCompressionPolicy({ shouldSkipApiCompression: () => disabled });
    const response = { getHeader: () => undefined };
    for (const route of ['/api/event', '/api/global/event', '/api/terminal/a/stream', '/api/browser/agent-leases/a/stream']) {
      expect(shouldSkipCompression({ headers: {}, path: route }, response)).toBe(true);
    }
    expect(shouldSkipCompression({ headers: {}, path: '/api/status' }, response)).toBe(false);
    disabled = true;
    expect(shouldSkipCompression({ headers: {}, path: '/api/status' }, response)).toBe(true);
    expect(shouldSkipCompression({ headers: { accept: ['text/event-stream'] }, path: '/' }, response)).toBe(true);
    expect(shouldSkipCompression({ headers: {}, path: '/' }, { getHeader: () => 'text/event-stream' })).toBe(true);
  });
});
