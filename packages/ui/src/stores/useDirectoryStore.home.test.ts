import { beforeEach, describe, expect, mock, test } from 'bun:test';

const HOME = '/Users/tester';
const directoriesSet: string[] = [];
const settingsUpdates: Array<Record<string, string>> = [];

const actualClientModule = await import('@/lib/opencode/client');
mock.module('@/lib/opencode/client', () => ({
  ...actualClientModule,
  opencodeClient: {
    setDirectory: (directory: string) => { directoriesSet.push(directory); },
    getFilesystemHome: async () => HOME,
    getSystemInfo: async () => ({ homeDirectory: HOME }),
  },
}));
const actualDesktopModule = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...actualDesktopModule,
  getDesktopHomeDirectory: async () => null,
}));
const actualPersistenceModule = await import('@/lib/persistence');
mock.module('@/lib/persistence', () => ({
  ...actualPersistenceModule,
  updateDesktopSettings: async (changes: Record<string, string>) => {
    settingsUpdates.push(changes);
  },
}));
mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: { getState: () => ({ invalidateDirectory: () => undefined }) },
}));

const { getSafeStorage } = await import('./utils/safeStorage');
const { useDirectoryStore } = await import('./useDirectoryStore');
const storage = getSafeStorage();
const lastDirectoryUpdates = () => settingsUpdates.filter((changes) => 'lastDirectory' in changes);

describe('home directory fallback', () => {
  beforeEach(() => {
    storage.removeItem('lastDirectory');
    useDirectoryStore.getState().synchronizeHomeDirectory(HOME);
    settingsUpdates.length = 0;
    directoriesSet.length = 0;
  });

  test('falling back to the home does not store it as the last directory', () => {
    useDirectoryStore.setState({ currentDirectory: '/', directoryHistory: ['/'], historyIndex: 0, homeDirectory: '/' });

    useDirectoryStore.getState().synchronizeHomeDirectory(HOME);

    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: HOME, hasPersistedDirectory: false });
    expect(directoriesSet.at(-1)).toBe(HOME);
    // The server turns a stored last directory into a project when there is
    // none and warms it at every start.
    expect(storage.getItem('lastDirectory')).toBeNull();
    expect(lastDirectoryUpdates()).toEqual([]);
  });

  test('going home after the last project is removed forgets the last directory', async () => {
    useDirectoryStore.getState().setDirectory('/Users/tester/project');
    expect(storage.getItem('lastDirectory')).toBe('/Users/tester/project');
    settingsUpdates.length = 0;

    await useDirectoryStore.getState().goHome();

    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: HOME, hasPersistedDirectory: false });
    expect(directoriesSet.at(-1)).toBe(HOME);
    // Neither the removed project nor the home stays stored.
    expect(storage.getItem('lastDirectory')).toBeNull();
    expect(lastDirectoryUpdates()).toEqual([{ lastDirectory: '' }]);
  });

  test('a directory the user opens is still stored', () => {
    useDirectoryStore.getState().setDirectory('/Users/tester/other');

    expect(storage.getItem('lastDirectory')).toBe('/Users/tester/other');
    expect(lastDirectoryUpdates()).toEqual([{ lastDirectory: '/Users/tester/other' }]);
  });
});
