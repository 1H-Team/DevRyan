import { describe, expect, it } from 'vitest';

import { getPublicRuntimePort } from './runtime-port-visibility.js';

describe('public runtime port visibility', () => {
  it('preserves the managed runtime port', () => {
    expect(getPublicRuntimePort(4096)).toBe(4096);
  });

  it('hides the port when runtime startup is skipped', () => {
    expect(getPublicRuntimePort(4096, { startupSkipped: true })).toBeNull();
  });

  it('hides the port for an externally managed runtime', () => {
    expect(getPublicRuntimePort(4096, { externallyManaged: true })).toBeNull();
  });
});
