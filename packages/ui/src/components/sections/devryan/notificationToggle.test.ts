import { describe, expect, test } from 'bun:test';

import { updateWebNotificationPreference } from './notificationToggle';

describe('web notification preference toggle', () => {
  test('requests permission once and persists after it is granted', async () => {
    let permissionRequestCount = 0;
    const persisted: boolean[] = [];
    const requestPermission = async () => {
      permissionRequestCount += 1;
      return 'granted' as NotificationPermission;
    };
    const persist = async (enabled: boolean) => {
      persisted.push(enabled);
      return true;
    };

    const result = await updateWebNotificationPreference({
      checked: true,
      currentEnabled: false,
      secureContext: true,
      notifications: { permission: 'default', requestPermission },
      persist,
    });

    expect(result).toEqual({ enabled: true, permission: 'granted', status: 'saved' });
    expect(permissionRequestCount).toBe(1);
    expect(persisted).toEqual([true]);
  });

  test('does not prompt again when permission is already granted', async () => {
    let permissionRequestCount = 0;
    const persisted: boolean[] = [];
    const requestPermission = async () => {
      permissionRequestCount += 1;
      return 'granted' as NotificationPermission;
    };
    const persist = async (enabled: boolean) => {
      persisted.push(enabled);
      return true;
    };

    const result = await updateWebNotificationPreference({
      checked: true,
      currentEnabled: false,
      secureContext: true,
      notifications: { permission: 'granted', requestPermission },
      persist,
    });

    expect(result.status).toBe('saved');
    expect(permissionRequestCount).toBe(0);
    expect(persisted).toEqual([true]);
  });

  test('does not persist denied or unsupported enablement', async () => {
    const persisted: boolean[] = [];
    const persist = async (enabled: boolean) => {
      persisted.push(enabled);
      return true;
    };
    const denied = await updateWebNotificationPreference({
      checked: true,
      currentEnabled: false,
      secureContext: true,
      notifications: { permission: 'denied', requestPermission: async () => 'denied' },
      persist,
    });
    const unsupported = await updateWebNotificationPreference({
      checked: true,
      currentEnabled: false,
      secureContext: false,
      notifications: null,
      persist,
    });

    expect(denied.status).toBe('denied');
    expect(unsupported.status).toBe('unsupported');
    expect(persisted).toEqual([]);
  });

  test('keeps enablement off on persistence failure and persists disablement', async () => {
    const failed = await updateWebNotificationPreference({
      checked: true,
      currentEnabled: false,
      secureContext: true,
      notifications: { permission: 'granted', requestPermission: async () => 'granted' },
      persist: async () => false,
    });
    const persisted: boolean[] = [];
    const persistDisable = async (enabled: boolean) => {
      persisted.push(enabled);
      return true;
    };
    const disabled = await updateWebNotificationPreference({
      checked: false,
      currentEnabled: true,
      secureContext: true,
      notifications: { permission: 'granted', requestPermission: async () => 'granted' },
      persist: persistDisable,
    });

    expect(failed).toEqual({ enabled: false, permission: 'granted', status: 'save-error' });
    expect(disabled).toEqual({ enabled: false, permission: 'granted', status: 'saved' });
    expect(persisted).toEqual([false]);
  });
});
