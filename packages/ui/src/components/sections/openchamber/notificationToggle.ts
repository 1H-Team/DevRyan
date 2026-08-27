export type WebNotificationToggleStatus =
  | 'saved'
  | 'unsupported'
  | 'denied'
  | 'permission-error'
  | 'save-error';

export interface WebNotificationPermissionApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

export interface WebNotificationToggleResult {
  enabled: boolean;
  permission: NotificationPermission;
  status: WebNotificationToggleStatus;
}

export const updateWebNotificationPreference = async ({
  checked,
  currentEnabled,
  secureContext,
  notifications,
  persist,
}: {
  checked: boolean;
  currentEnabled: boolean;
  secureContext: boolean;
  notifications: WebNotificationPermissionApi | null;
  persist: (enabled: boolean) => Promise<boolean>;
}): Promise<WebNotificationToggleResult> => {
  if (!secureContext || !notifications) {
    return { enabled: false, permission: 'default', status: 'unsupported' };
  }

  let permission = notifications.permission;
  if (checked && permission === 'default') {
    try {
      permission = await notifications.requestPermission();
    } catch {
      return { enabled: false, permission, status: 'permission-error' };
    }
  }

  if (checked && permission !== 'granted') {
    return { enabled: false, permission, status: 'denied' };
  }

  try {
    const saved = await persist(checked);
    return saved
      ? { enabled: checked, permission, status: 'saved' }
      : { enabled: currentEnabled, permission, status: 'save-error' };
  } catch {
    return { enabled: currentEnabled, permission, status: 'save-error' };
  }
};
