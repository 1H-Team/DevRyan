import { describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore Plan Ready notification preferences', () => {
  test('defaults Plan Ready to enabled with an empty customizable template', () => {
    const state = useUIStore.getState();

    expect(state.notifyOnPlanReady).toBe(true);
    expect(state.notifyOnPermission).toBe(true);
    expect(state.notifyOnSubtasks).toBe(false);
    expect(state.notificationTemplates.planReady).toEqual({ title: '', message: '' });
    expect(state.notificationTemplates.permission).toEqual({ title: '', message: '' });
  });

  test('migrates legacy preferences without replacing customized templates', () => {
    const migrate = useUIStore.persist.getOptions().migrate;
    expect(typeof migrate).toBe('function');
    const completion = { title: 'Custom completion', message: 'Finished {session_name}' };

    const migrated = migrate?.({
      notifyOnCompletion: false,
      notifyOnSubtasks: true,
      notificationTemplates: {
        completion,
        error: { title: 'Error', message: '{last_message}' },
      },
    }, 11) as Record<string, unknown>;

    expect(migrated.notifyOnPlanReady).toBe(true);
    expect(migrated.notifyOnPermission).toBe(true);
    expect(migrated.notifyOnSubtasks).toBe(true);
    const migratedTemplates = migrated.notificationTemplates as Record<string, unknown>;
    expect(migratedTemplates.completion).toEqual(completion);
    expect(migratedTemplates.planReady).toEqual({ title: '', message: '' });
    expect(migratedTemplates.permission).toEqual({ title: '', message: '' });
  });

  test('includes Plan Ready state in persisted UI preferences', () => {
    const partialize = useUIStore.persist.getOptions().partialize;
    expect(partialize).toBeTruthy();

    const persisted = partialize?.(useUIStore.getState()) as Record<string, unknown>;
    expect(persisted.notifyOnPlanReady).toBe(true);
    expect(persisted.notifyOnPermission).toBe(true);
    const persistedTemplates = persisted.notificationTemplates as Record<string, unknown>;
    expect(persistedTemplates.planReady).toEqual({ title: '', message: '' });
    expect(persistedTemplates.permission).toEqual({ title: '', message: '' });
  });

  test('preserves the legacy combined toggle when adding Permissions Needed', () => {
    const migrate = useUIStore.persist.getOptions().migrate;
    const migrated = migrate?.({
      notifyOnQuestion: false,
      notificationTemplates: {
        question: { title: 'Question', message: '{last_message}' },
      },
    }, 18) as Record<string, unknown>;

    expect(migrated.notifyOnPermission).toBe(false);
    expect((migrated.notificationTemplates as Record<string, unknown>).permission).toEqual({ title: '', message: '' });
  });

  test('updates one template field without replacing untouched template entries', () => {
    const original = useUIStore.getState().notificationTemplates;
    const originalCompletion = original.completion;
    const originalError = original.error;

    try {
      useUIStore.getState().updateNotificationTemplate('error', 'title', 'Custom error');
      const updated = useUIStore.getState().notificationTemplates;

      expect(updated).not.toBe(original);
      expect(updated.completion).toBe(originalCompletion);
      expect(updated.error).not.toBe(originalError);
      expect(updated.error).toEqual({ ...originalError, title: 'Custom error' });

      useUIStore.getState().updateNotificationTemplate('error', 'title', 'Custom error');
      expect(useUIStore.getState().notificationTemplates).toBe(updated);
    } finally {
      useUIStore.getState().setNotificationTemplates(original);
    }
  });
});
