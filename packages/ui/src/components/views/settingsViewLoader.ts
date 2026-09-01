export const loadSettingsView = () =>
  import('@/components/views/SettingsView').then((module) => ({ default: module.SettingsView }));

export const loadManagedSettingsView = () =>
  import('@/components/views/ManagedSettingsView').then((module) => ({ default: module.ManagedSettingsView }));

let settingsViewPreload: ReturnType<typeof loadSettingsView> | null = null;
let managedSettingsViewPreload: ReturnType<typeof loadManagedSettingsView> | null = null;

export function preloadSettingsView(managed: boolean): Promise<void> {
  if (managed) {
    managedSettingsViewPreload ??= loadManagedSettingsView();
    return managedSettingsViewPreload.then(
      () => undefined,
      (error: unknown) => {
        managedSettingsViewPreload = null;
        throw error;
      },
    );
  }

  settingsViewPreload ??= loadSettingsView();
  return settingsViewPreload.then(
    () => undefined,
    (error: unknown) => {
      settingsViewPreload = null;
      throw error;
    },
  );
}
