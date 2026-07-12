import { describe, expect, it } from 'vitest';

import { isManagedOrchestrationWindowEventType } from './managedOrchestrationWindowEvents';

describe('managed orchestration webview events', () => {
  it('forwards task, compaction, and recovery-warning events only', () => {
    expect(isManagedOrchestrationWindowEventType('openchamber:managed-task')).toBe(true);
    expect(isManagedOrchestrationWindowEventType('openchamber:managed-task-removed')).toBe(true);
    expect(isManagedOrchestrationWindowEventType('openchamber:managed-orchestration-warning')).toBe(true);
    expect(isManagedOrchestrationWindowEventType('openchamber:provider-native-task')).toBe(false);
    expect(isManagedOrchestrationWindowEventType(null)).toBe(false);
  });
});
