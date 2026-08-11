import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createProjectIdFromPath } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = (initialSettings, { projectIconStore } = {}) => {
  const settingsPath = '/tmp/openchamber/settings.json';
  const writtenFiles = new Map();
  let settings = { ...initialSettings };

  const fsPromises = {
    readFile: vi.fn(async (filePath) => {
      if (filePath === settingsPath) {
        return JSON.stringify(settings);
      }
      const value = writtenFiles.get(filePath);
      if (typeof value === 'string') {
        return value;
      }
      const error = new Error('missing file');
      error.code = 'ENOENT';
      throw error;
    }),
    writeFile: vi.fn(async (filePath, value) => {
      writtenFiles.set(filePath, value);
    }),
    rename: vi.fn(async (from, to) => {
      const value = writtenFiles.get(from);
      writtenFiles.delete(from);
      writtenFiles.set(to, value);
      if (to === settingsPath) {
        settings = JSON.parse(value);
      }
    }),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => {
      const error = new Error('missing directory');
      error.code = 'ENOENT';
      throw error;
    }),
    access: vi.fn(async () => {
      const error = new Error('missing file');
      error.code = 'ENOENT';
      throw error;
    }),
    rm: vi.fn(async () => {}),
    stat: vi.fn(async () => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }),
  };

  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsPath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : undefined,
    sanitizeSettingsUpdate: (changes) => changes && typeof changes === 'object' ? { ...changes } : {},
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (value) => ({ settings: value, changed: false }),
    normalizeStringArray: (value) => Array.isArray(value) ? value : [],
    formatSettingsResponse: (value) => value,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: vi.fn(async () => {}),
    upsertManagedRemoteTunnelToken: vi.fn(async () => {}),
    projectIconStore,
  });

  return { runtime, fsPromises };
};

describe('settings runtime', () => {
  it('restores manifest-backed project icon metadata while reading settings after an update', async () => {
    const projectPath = '/tmp/project';
    const project = { id: createProjectIdFromPath(projectPath), path: projectPath, iconImage: null };
    const restoredIcon = { mime: 'image/png', updatedAt: 1234, source: 'custom' };
    const projectIconStore = {
      reconcileProjects: vi.fn(async (projects) => ({
        projects: projects.map((entry) => ({ ...entry, iconImage: restoredIcon })),
        changed: true,
      })),
    };
    const { runtime } = createRuntime({ projects: [project], activeProjectId: project.id }, { projectIconStore });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(projectIconStore.reconcileProjects).toHaveBeenCalledWith([project]);
    expect(updated.projects[0].iconImage).toEqual(restoredIcon);
  });

  it('migrates legacy Default IDs to dedicated DevRyan theme IDs once', async () => {
    const { runtime } = createRuntime({
      themeId: 'onedarkpro-light',
      themeVariant: 'light',
      lightThemeId: 'onedarkpro-light',
      darkThemeId: 'carbonfox-dark',
    });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated).toMatchObject({
      themeId: 'devryan-default-light',
      lightThemeId: 'devryan-default-light',
      darkThemeId: 'devryan-default-dark',
      themeCatalogVersion: 2,
    });
  });

  it('preserves intentional upstream IDs after the theme catalog migration', async () => {
    const { runtime } = createRuntime({
      themeId: 'onedarkpro-light',
      themeVariant: 'light',
      lightThemeId: 'onedarkpro-light',
      darkThemeId: 'carbonfox-dark',
      themeCatalogVersion: 2,
    });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated).toMatchObject({
      themeId: 'onedarkpro-light',
      lightThemeId: 'onedarkpro-light',
      darkThemeId: 'carbonfox-dark',
      themeCatalogVersion: 2,
    });
  });

  it('uses the dedicated Default IDs when expanding legacy single-theme settings', async () => {
    const { runtime } = createRuntime({ themeVariant: 'dark' });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated.lightThemeId).toBe('devryan-default-light');
    expect(updated.darkThemeId).toBe('devryan-default-dark');
  });

  it('migrates legacy lastDirectory without statting the protected path', async () => {
    const projectPath = '/Users/test/Documents/LegacyProject';
    const projectId = createProjectIdFromPath(projectPath);
    const { runtime, fsPromises } = createRuntime({ lastDirectory: projectPath });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated.projects).toEqual([
      {
        id: projectId,
        path: projectPath,
        addedAt: expect.any(Number),
        lastOpenedAt: expect.any(Number),
      },
    ]);
    expect(updated.activeProjectId).toBe(projectId);
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it('does not stat existing project paths when saving unrelated settings', async () => {
    const projectPath = '/Users/test/Documents/ProtectedProject';
    const projectId = createProjectIdFromPath(projectPath);
    const { runtime, fsPromises } = createRuntime({
      projects: [{ id: projectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
      activeProjectId: projectId,
    });

    const updated = await runtime.persistSettings({ themeId: 'dark-default' });

    expect(updated.projects).toEqual([{ id: projectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }]);
    expect(updated.themeId).toBe('dark-default');
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it('adds Plan Ready notification defaults without replacing customized templates', async () => {
    const completion = { title: 'Custom completion', message: 'Finished {session_name}' };
    const question = { title: 'Custom question', message: '{last_message}' };
    const { runtime } = createRuntime({
      notifyOnCompletion: false,
      notificationTemplates: { completion, question },
    });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated.notifyOnPlanReady).toBe(true);
    expect(updated.notifyOnCompletion).toBe(false);
    expect(updated.notifyOnSubtasks).toBe(false);
    expect(updated.notificationTemplates).toMatchObject({
      completion,
      question,
      planReady: { title: 'Plan ready', message: 'A plan is ready for review' },
    });
  });

  it.each([
    { title: '{agent_name} is ready', message: '{model_name} completed the task' },
    { title: '{agent_name} is ready', message: '{last_message}' },
  ])('migrates the exact legacy completion template $title / $message', async (completion) => {
    const { runtime } = createRuntime({
      notificationTemplates: { completion },
    });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated.notificationTemplates.completion).toEqual({
      title: 'Session complete',
      message: '{session_name} is ready to review',
    });
  });

  it('preserves an existing subagent preference and customized completion template', async () => {
    const completion = { title: 'Build is done.', message: '{session_name} has completed' };
    const { runtime } = createRuntime({
      notifyOnSubtasks: true,
      notificationTemplates: { completion },
    });

    const updated = await runtime.readSettingsFromDiskMigrated();

    expect(updated.notifyOnSubtasks).toBe(true);
    expect(updated.notificationTemplates.completion).toEqual(completion);
  });
});
