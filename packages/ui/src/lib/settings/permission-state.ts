import * as React from 'react';

export interface SettingsPermissionContextValue {
  slug: string;
  canEdit: boolean;
}

export const SettingsPermissionContext = React.createContext<SettingsPermissionContextValue>({
  slug: 'home',
  canEdit: true,
});

export const useSettingsPagePermission = (): SettingsPermissionContextValue => React.useContext(SettingsPermissionContext);
