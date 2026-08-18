import { describe, expect, it } from 'vitest';

import { createPromptAdmissionController } from './prompt-admission.js';

describe('prompt admission controller', () => {
  it('supports named, reference-counted holds without reopening a drain', () => {
    const admission = createPromptAdmissionController();
    expect(admission.getBlock()).toMatchObject({ code: 'HARNESS_INITIALIZING' });

    admission.markReady();
    const releaseFirst = admission.acquireHold('context_mode_recovery', {
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      error: 'Context-mode recovery is pending',
    });
    const releaseSecond = admission.acquireHold('context_mode_recovery', {
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      error: 'Context-mode recovery is pending',
    });

    expect(admission.isAccepting()).toBe(false);
    expect(admission.getBlock()).toMatchObject({
      name: 'context_mode_recovery',
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      retryAfterSeconds: 1,
    });
    expect(releaseFirst()).toBe(true);
    expect(admission.isAccepting()).toBe(false);
    expect(releaseFirst()).toBe(false);
    expect(releaseSecond()).toBe(true);
    expect(admission.isAccepting()).toBe(true);

    admission.beginDrain();
    expect(admission.getBlock()).toMatchObject({ code: 'HARNESS_DRAINING' });
    expect(admission.isAccepting()).toBe(false);
  });
});
