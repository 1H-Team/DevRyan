import { create } from 'zustand';
import { devtools } from './utils/devtoolsGate';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { createProjectIdFromPath } from '@/lib/projectId';
import { getSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import { toast } from '@/components/ui';
import { updateManagedProject, type ManagedProjectMetadataPatch } from '@/lib/managedProjectsApi';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n/store';
import { getExactProjectBasename, resolveProjectDisplayName } from '@/lib/projectDisplayName';

/** Pick a color key that's least used among existing projects */
const pickAutoColor = (projects: ProjectEntry[]): string => {
  const colorKeys = PROJECT_COLORS.map((c) => c.key);
  const usageCounts = new Map<string, number>();
  for (const key of colorKeys) {
    usageCounts.set(key, 0);
  }
  for (const p of projects) {
    if (p.color && usageCounts.has(p.color)) {
      usageCounts.set(p.color, (usageCounts.get(p.color) ?? 0) + 1);
    }
  }
  // Find minimum usage, then pick randomly among those with min usage
  const minUsage = Math.min(...usageCounts.values());
  const candidates = colorKeys.filter((k) => usageCounts.get(k) === minUsage);
  return candidates[Math.floor(Math.random() * candidates.length)];
};

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;

  addProject: (path: string, options?: { label?: string; id?: string }) => ProjectEntry | null;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: { label?: string; icon?: string | null; color?: string | null; iconBackground?: string | null }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeManagedAssignments: (principal: AuthPrincipal) => void;
  synchronizeFromSettings: (settings: DesktopSettings) => void;

  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = safeStorage.getItem('homeDirectory') || useDirectoryStore.getState().homeDirectory || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const INTEGRATE_TMP_PREFIX = 'devryan-integrate-';

export const isIntegrateTempProjectPath = (value: string): boolean => {
  const normalized = normalizeProjectPath(value);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || '';
  return base.startsWith(INTEGRATE_TMP_PREFIX);
};

const legacyGeneratedLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const deriveProjectLabel = (path: string): string => getExactProjectBasename(normalizeProjectPath(path));

export const normalizeGeneratedProjectLabels = (projects: ProjectEntry[]): {
  projects: ProjectEntry[];
  changed: boolean;
} => {
  let changed = false;
  const normalized = projects.map((project) => {
    const exactLabel = deriveProjectLabel(project.path);
    const legacyLabel = legacyGeneratedLabel(project.path);
    if (project.label === legacyLabel && project.label !== exactLabel) {
      changed = true;
      return { ...project, label: exactLabel };
    }
    return project;
  });
  return { projects: changed ? normalized : projects, changed };
};

const projectNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export const sortProjectsAlphabetically = (projects: ProjectEntry[]): ProjectEntry[] => (
  [...projects].sort((left, right) => {
    const leftName = resolveProjectDisplayName(left);
    const rightName = resolveProjectDisplayName(right);
    const nameComparison = projectNameCollator.compare(leftName, rightName);
    return nameComparison || projectNameCollator.compare(left.path, right.path);
  })
);

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const sanitizeProjectBranches = (value: unknown): ProjectEntry['branches'] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const branches: NonNullable<ProjectEntry['branches']> = [];
  const seenBranches = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const directory = typeof candidate.directory === 'string'
      ? normalizeProjectPath(candidate.directory)
      : '';
    const key = `${name}\0${directory}`;
    if (!name || !directory || seenBranches.has(key)) continue;
    seenBranches.add(key);
    branches.push({
      name,
      directory,
      ...(typeof candidate.isDefault === 'boolean' ? { isDefault: candidate.isDefault } : {}),
    });
  }
  return branches.length > 0 ? branches : undefined;
};

const translateNow = (key: I18nKey): string => (
  formatMessage(useI18nStore.getState().dictionary, key)
);

const canEditManagedProjectMetadata = (): boolean => {
  const principal = getAuthPrincipal();
  return principal.scope !== 'managed' || principal.role === 'admin';
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;
    if (isIntegrateTempProjectPath(normalizedPath)) continue;

    const providedId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const id = providedId || createProjectIdFromPath(normalizedPath);
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    const branches = sanitizeProjectBranches(candidate.branches);
    if (branches) project.branches = branches;

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

export interface ManagedProjectProjection {
  projects: ProjectEntry[];
  activeProjectId: string | null;
}

/**
 * Managed assignments are the project registry for non-admin users. Global
 * desktop settings may still contain host projects from an administrator;
 * never hydrate those paths into a managed developer's client store.
 */
export const projectManagedAssignments = (
  principal: Pick<AuthPrincipal, 'assignments'>,
  existingProjects: ProjectEntry[] = [],
): ManagedProjectProjection => {
  const grouped = new Map<string, Array<AuthPrincipal['assignments'][number] & { publicDirectory: string }>>();
  const orderedIds: string[] = [];

  for (const assignment of principal.assignments) {
    const publicDirectory = normalizeProjectPath(assignment.publicDirectory);
    if (!publicDirectory) continue;
    const projectId = assignment.projectId.trim() || createProjectIdFromPath(publicDirectory);
    if (!grouped.has(projectId)) {
      grouped.set(projectId, []);
      orderedIds.push(projectId);
    }
    grouped.get(projectId)?.push({ ...assignment, projectId, publicDirectory });
  }

  const projects = sortProjectsAlphabetically(orderedIds.flatMap((projectId) => {
    const assignments = grouped.get(projectId) ?? [];
    const primary = assignments.find((assignment) => assignment.isDefault) ?? assignments[0];
    if (!primary) return [];

    const existing = existingProjects.find((project) => (
      project.id === projectId || project.path === primary.publicDirectory
    ));
    const presentation: Partial<ProjectEntry> = existing ? {
      ...(existing.addedAt !== undefined ? { addedAt: existing.addedAt } : {}),
      ...(existing.lastOpenedAt !== undefined ? { lastOpenedAt: existing.lastOpenedAt } : {}),
      ...(existing.sidebarCollapsed !== undefined ? { sidebarCollapsed: existing.sidebarCollapsed } : {}),
    } : {};
    const sharedPresentation: Partial<ProjectEntry> = {};
    if (primary.icon !== undefined) sharedPresentation.icon = primary.icon ?? undefined;
    else if (existing?.icon !== undefined) sharedPresentation.icon = existing.icon;
    if (primary.iconImage !== undefined) sharedPresentation.iconImage = primary.iconImage;
    else if (existing?.iconImage !== undefined) sharedPresentation.iconImage = existing.iconImage;
    if (primary.iconBackground !== undefined) sharedPresentation.iconBackground = primary.iconBackground ?? undefined;
    else if (existing?.iconBackground !== undefined) sharedPresentation.iconBackground = existing.iconBackground;
    if (primary.color !== undefined) sharedPresentation.color = primary.color ?? undefined;
    else if (existing?.color !== undefined) sharedPresentation.color = existing.color;
    const branches = assignments
      .filter((assignment) => assignment.branchName.trim().length > 0)
      .map((assignment) => ({
        name: assignment.branchName.trim(),
        directory: assignment.publicDirectory,
        isDefault: assignment.isDefault,
      }));

    return [{
      ...presentation,
      ...sharedPresentation,
      id: projectId,
      path: primary.publicDirectory,
      label: primary.label.trim() || existing?.label || deriveProjectLabel(primary.publicDirectory),
      ...(branches.length > 0 ? { branches } : {}),
    }];
  }));

  const defaultAssignment = principal.assignments.find((assignment) => assignment.isDefault)
    ?? principal.assignments[0];
  const defaultProjectId = defaultAssignment
    ? (defaultAssignment.projectId.trim() || createProjectIdFromPath(normalizeProjectPath(defaultAssignment.publicDirectory)))
    : null;
  const activeProjectId = projects.some((project) => project.id === defaultProjectId)
    ? defaultProjectId
    : projects[0]?.id ?? null;

  return { projects, activeProjectId };
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = safeStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = safeStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignored
  }

  try {
    if (activeProjectId) {
      safeStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId);
    } else {
      safeStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignored
  }
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  cacheProjects(projects, activeProjectId);
  const principal = getAuthPrincipal();
  if (principal.scope === 'managed' && principal.role !== 'admin') {
    return;
  }
  void updateDesktopSettings({ projects, activeProjectId: activeProjectId ?? undefined });
};

const initialProjects = sortProjectsAlphabetically(readPersistedProjects());
let shouldSortNextSettingsSync = true;

const effectiveInitialProjects = initialProjects;
const persistedInitialActiveProjectId = readPersistedActiveProjectId();
const initialActiveProjectId = effectiveInitialProjects.some((project) => project.id === persistedInitialActiveProjectId)
  ? persistedInitialActiveProjectId
  : effectiveInitialProjects[0]?.id ?? null;

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: effectiveInitialProjects,
    activeProjectId: initialActiveProjectId,

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: (path: string, options?: { label?: string; id?: string }) => {

      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;
      if (isIntegrateTempProjectPath(normalizedPath)) {
        return null;
      }
      const existing = get().projects.find((project) => project.path === normalizedPath);
      if (existing) {
        get().setActiveProject(existing.id);
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      const id = createProjectIdFromPath(normalizedPath);
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        label,
        color: pickAutoColor(get().projects),
        addedAt: now,
        lastOpenedAt: now,
      };

      const nextProjects = [...get().projects, entry];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      get().setActiveProject(entry.id);
      void get().discoverProjectIcon(entry.id);
      return entry;
    },

    removeProject: (id: string) => {

      const current = get();
      const project = current.projects.find((p) => p.id === id);
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      set({ projects: nextProjects, activeProjectId: nextActiveId });
      persistProjects(nextProjects, nextActiveId);

      // Clean up worktree entries for the removed project
      if (project) {
        const normalizedPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        useSessionUIStore.setState((s) => {
          const next = new Map(s.availableWorktreesByProject);
          next.delete(normalizedPath);
          return { availableWorktreesByProject: next };
        });
      }

      if (nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive) {
          opencodeClient.setDirectory(nextActive.path);
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: (id: string) => {

      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      persistProjects(nextProjects, id);

      opencodeClient.setDirectory(target.path);
      useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
    },

    setActiveProjectIdOnly: (id: string) => {

      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      persistProjects(nextProjects, id);
    },

    renameProject: (id: string, label: string) => {

      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      get().updateProjectMeta(id, { label: trimmed });
    },

    updateProjectMeta: (id: string, meta: { label?: string; icon?: string | null; color?: string | null; iconBackground?: string | null }) => {

      const principal = getAuthPrincipal();
      if (principal.scope === 'managed' && principal.role !== 'admin') {
        toast.error(translateNow('projectEditDialog.toast.adminOnly'));
        return;
      }
      const { projects, activeProjectId } = get();
      const previousProject = projects.find((project) => project.id === id);
      if (!previousProject) return;
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        return updated;
      });
      set({ projects: nextProjects });
      if (principal.scope !== 'managed') {
        persistProjects(nextProjects, activeProjectId);
        return;
      }

      cacheProjects(nextProjects, activeProjectId);
      const patch: ManagedProjectMetadataPatch = { ...meta };
      void updateManagedProject(id, patch).catch((error) => {
        const current = get();
        const rolledBack = current.projects.map((project) => {
          if (project.id !== id) return project;
          const restored = { ...project };
          if (meta.label !== undefined) restored.label = previousProject.label;
          if (meta.icon !== undefined) restored.icon = previousProject.icon;
          if (meta.color !== undefined) restored.color = previousProject.color;
          if (meta.iconBackground !== undefined) restored.iconBackground = previousProject.iconBackground;
          return restored;
        });
        set({ projects: rolledBack });
        cacheProjects(rolledBack, current.activeProjectId);
        toast.error(translateNow('projectEditDialog.toast.failedToSave'), {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },

    uploadProjectIcon: async (id: string, file: File) => {

      if (!canEditManagedProjectMetadata()) {
        return { ok: false, error: translateNow('projectEditDialog.toast.adminOnly') };
      }

      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-DevRyan-CSRF': '1',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings; project?: ProjectEntry } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        } else if (payload?.project) {
          const current = get();
          const nextProjects = current.projects.map((project) => (
            project.id === id ? { ...project, iconImage: payload.project?.iconImage ?? null } : project
          ));
          set({ projects: nextProjects });
          cacheProjects(nextProjects, current.activeProjectId);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {

      if (!canEditManagedProjectMetadata()) {
        return { ok: false, error: translateNow('projectEditDialog.toast.adminOnly') };
      }

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            'X-DevRyan-CSRF': '1',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings; project?: ProjectEntry } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        } else if (payload?.project) {
          const current = get();
          const nextProjects = current.projects.map((project) => (
            project.id === id ? { ...project, iconImage: payload.project?.iconImage ?? null } : project
          ));
          set({ projects: nextProjects });
          cacheProjects(nextProjects, current.activeProjectId);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {

      if (!canEditManagedProjectMetadata()) {
        return { ok: false, error: translateNow('projectEditDialog.toast.adminOnly') };
      }

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-DevRyan-CSRF': '1',
          },
          body: JSON.stringify({ force: options?.force === true }),
        });

        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          skipped?: boolean;
          reason?: string;
          settings?: DesktopSettings;
          project?: ProjectEntry;
        } | null;

        if (!response.ok) {
          return { ok: false, error: payload?.error || 'Failed to discover project icon' };
        }

        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        } else if (payload?.project) {
          const current = get();
          const nextProjects = current.projects.map((project) => (
            project.id === id ? { ...project, iconImage: payload.project?.iconImage ?? null } : project
          ));
          set({ projects: nextProjects });
          cacheProjects(nextProjects, current.activeProjectId);
        }

        return {
          ok: true,
          skipped: payload?.skipped === true,
          reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to discover project icon' };
      }
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {

      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId);
    },

    synchronizeManagedAssignments: (principal: AuthPrincipal) => {
      if (principal.scope !== 'managed' || principal.role === 'admin') {
        return;
      }
      const current = get();
      const projection = projectManagedAssignments(principal, current.projects);
      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(projection.projects);
      const activeChanged = current.activeProjectId !== projection.activeProjectId;
      if (!projectsChanged && !activeChanged) {
        return;
      }
      set({ projects: projection.projects, activeProjectId: projection.activeProjectId });
      cacheProjects(projection.projects, projection.activeProjectId);
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {

      const settingsProjects = sanitizeProjects(settings.projects ?? []);
      const settingsActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const current = get();
      const principal = getAuthPrincipal();
      const managedProjection = principal.scope === 'managed' && principal.role !== 'admin'
        ? projectManagedAssignments(principal, [...settingsProjects, ...current.projects])
        : null;
      const normalization = principal.scope === 'managed' && principal.role !== 'admin'
        ? { projects: settingsProjects, changed: false }
        : normalizeGeneratedProjectLabels(settingsProjects);
      const normalizedSettingsProjects = normalization.projects;
      const generatedLabelNormalizationChanged = normalization.changed;
      const projectedProjects = managedProjection?.projects ?? normalizedSettingsProjects;
      const incomingProjects = shouldSortNextSettingsSync
        ? sortProjectsAlphabetically(projectedProjects)
        : projectedProjects;
      shouldSortNextSettingsSync = false;
      const incomingActive = managedProjection?.activeProjectId ?? settingsActive;

      // Race guard: settings load can return empty projects during app
      // rebuild/reinstall or an incomplete settings read. Don't clobber
      // a populated cache with empty — the sidebar would go blank and
      // localStorage would be overwritten, losing the list entirely.
      if (principal.scope !== 'managed' && incomingProjects.length === 0 && current.projects.length > 0) {
        if (incomingActive !== current.activeProjectId) {
          // Active project may still be valid within the cached list.
          const activeExists = incomingActive
            ? current.projects.some((project) => project.id === incomingActive)
            : true;
          if (activeExists) {
            set({ activeProjectId: incomingActive });
            cacheProjects(current.projects, incomingActive);
          }
        }
        return;
      }

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;

      if (!projectsChanged && !activeChanged && !generatedLabelNormalizationChanged) {
        return;
      }

      if (projectsChanged || activeChanged) {
        set({ projects: incomingProjects, activeProjectId: incomingActive });
      }
      if (generatedLabelNormalizationChanged) {
        persistProjects(incomingProjects, incomingActive);
      } else {
        cacheProjects(incomingProjects, incomingActive);
      }

      if (incomingActive) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }

      if (principal.scope === 'managed') {
        const currentDraftId = useSessionUIStore.getState().currentDraftId;
        if (currentDraftId) {
          queueMicrotask(() => {
            useSessionUIStore.getState().selectNewSessionDraft(currentDraftId);
          });
        }
      }
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

if (typeof window !== 'undefined') {
  window.addEventListener('openchamber:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });
}
