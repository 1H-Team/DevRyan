/**
 * DevRyan project-level configuration service.
 * Stores per-project settings in <config folder>/projects/<projectId>.json, where the
 * config folder is ~/.config/devryan (or the pre-rename ~/.config/openchamber).
 * Migrates from legacy <project>/.openchamber/openchamber.json.
 */

import type { FilesAPI, RuntimeAPIs } from './api/types';
import { getDesktopHomeDirectory } from './desktop';
import { createProjectIdFromPath } from './projectId';

type ProjectRef = { id: string; path: string };

const CONFIG_FILENAME = 'openchamber.json';
// LEGACY_PROJECT_CONFIG: legacy per-project config root inside repo.
const LEGACY_CONFIG_DIR = '.openchamber';
// Pre-rename location, used only when the server does not report its config folder.
const LEGACY_USER_CONFIG_DIR_SEGMENTS = ['.config', 'openchamber'];

/**
 * Get the runtime Files API if available (Desktop).
 */
function getRuntimeFilesAPI(): FilesAPI | null {
  if (typeof window === 'undefined') return null;
  const apis = (window as typeof window & { __DEVRYAN_RUNTIME_APIS__?: RuntimeAPIs }).__DEVRYAN_RUNTIME_APIS__;
  if (apis?.files) {
    return apis.files;
  }
  return null;
}

export interface DevRyanConfig {
  projectPath?: string;
  'setup-worktree'?: string[];
  projectNotes?: string;
  projectTodos?: DevRyanProjectTodoItem[];
  projectPlanFiles?: DevRyanProjectPlanFileLink[];
  projectActions?: DevRyanProjectAction[];
  projectActionsPrimaryId?: string;
}

export type DevRyanProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface DevRyanProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: DevRyanProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface DevRyanProjectActionsState {
  actions: DevRyanProjectAction[];
  primaryActionId: string | null;
}

export interface DevRyanProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface DevRyanProjectPlanFileLink {
  id: string;
  path: string;
  createdAt: number;
}

export interface DevRyanProjectNotesTodos {
  notes: string;
  todos: DevRyanProjectTodoItem[];
}

export const DEVRYAN_PROJECT_NOTES_MAX_LENGTH = 1000;
export const DEVRYAN_PROJECT_TODO_TEXT_MAX_LENGTH = 120;
export const DEVRYAN_PROJECT_ACTION_NAME_MAX_LENGTH = 80;
export const DEVRYAN_PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
export const DEVRYAN_PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
export const DEVRYAN_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
export const DEVRYAN_AUTO_DISCOVER_ACTION_ID = '__devryan_auto_discover_preview__';
const LEGACY_AUTO_DISCOVER_ACTION_ID = '__openchamber_auto_discover_preview__';
export const DEVRYAN_PROJECT_PLAN_TITLE_MAX_LENGTH = 160;

const DEVRYAN_ACTION_PLATFORM_SET = new Set<DevRyanProjectActionPlatform>(['macos', 'linux', 'windows']);

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const getLegacyConfigPath = (projectDirectory: string): string => {
  return joinPath(joinPath(projectDirectory, LEGACY_CONFIG_DIR), CONFIG_FILENAME);
};

const getBaseUrl = (): string => {
  const defaultBaseUrl = import.meta.env.VITE_OPENCODE_URL || '/api';
  if (defaultBaseUrl.startsWith('/')) {
    return defaultBaseUrl;
  }
  return defaultBaseUrl;
};

const postJson = async <T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, data: null };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
};

const mkdirp = async (path: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.createDirectory) {
    try {
      const result = await runtimeFiles.createDirectory(path);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/mkdir`, { path });
  return Boolean(res.ok);
};

const readTextFile = async (path: string): Promise<string | null> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(path);
      const content = typeof result?.content === 'string' ? result.content : '';
      return content;
    } catch {
      return null;
    }
  }

  try {
    const response = await fetch(`${getBaseUrl()}/fs/read?path=${encodeURIComponent(path)}`,
      {
        // Avoid conditional requests (304 + empty body).
        cache: 'no-store',
      }
    );
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
};

const writeTextFile = async (path: string, content: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.writeFile) {
    try {
      const result = await runtimeFiles.writeFile(path, content);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/write`, { path, content });
  return Boolean(res.ok);
};

type HomeDirectories = { home: string; configDirectory: string | null };

const resolveHomeDirectories = async (): Promise<HomeDirectories | null> => {
  // Use server-reported home as the source of truth for user config paths.
  // In some runtimes, window.__DEVRYAN_HOME__ can be workspace/project-root
  // scoped, which would incorrectly route writes into the project directory.
  try {
    const response = await fetch(`${getBaseUrl()}/fs/home`, {
      // Avoid conditional requests (304 + empty body).
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error('Failed to resolve home directory from API');
    }
    const payload = await response.json().catch(() => null) as { home?: unknown; configDirectory?: unknown } | null;
    const home = typeof payload?.home === 'string' ? payload.home.trim() : '';
    const configDirectory = typeof payload?.configDirectory === 'string' ? payload.configDirectory.trim() : '';
    if (home) {
      return { home: normalize(home), configDirectory: configDirectory ? normalize(configDirectory) : null };
    }
  } catch {
    // fall through
  }

  // Fallback for environments where /api/fs/home is unavailable.

    const desktopHome = await getDesktopHomeDirectory().catch(() => null);
    if (desktopHome && desktopHome.trim().length > 0) {
      return { home: normalize(desktopHome), configDirectory: null };
    }

  return null;
};

const getUserProjectsDirectory = async (): Promise<string | null> => {
  const directories = await resolveHomeDirectories();
  if (!directories) {
    return null;
  }
  // An older server reports only home; its data is still in the pre-rename folder,
  // which after migration is a link to ~/.config/devryan.
  const configDirectory = directories.configDirectory
    ?? LEGACY_USER_CONFIG_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), directories.home);
  return joinPath(configDirectory, 'projects');
};

const resolveConfigProjectId = (project: ProjectRef): string | null => {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  const normalizedProject = projectDirectory ? normalize(projectDirectory) : '';
  if (!normalizedProject) return null;
  return createProjectIdFromPath(normalizedProject) || null;
};

const getUserConfigPath = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  if (!base) {
    return null;
  }
  const safeId = resolveConfigProjectId(project);
  if (!safeId) {
    return null;
  }
  return joinPath(base, `${safeId}.json`);
};

const trimToMaxLength = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
};

const sanitizeProjectNotes = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return trimToMaxLength(value, DEVRYAN_PROJECT_NOTES_MAX_LENGTH);
};

const sanitizeProjectTodoItems = (value: unknown): DevRyanProjectTodoItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: DevRyanProjectTodoItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      text?: unknown;
      completed?: unknown;
      createdAt?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const textRaw = typeof record.text === 'string' ? record.text : '';
    const text = trimToMaxLength(textRaw.trim(), DEVRYAN_PROJECT_TODO_TEXT_MAX_LENGTH);
    if (!id || !text) {
      continue;
    }

    const completed = Boolean(record.completed);
    const createdAt =
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : Date.now();

    sanitized.push({
      id,
      text,
      completed,
      createdAt,
    });

  }

  return sanitized;
};

const sanitizeProjectActionPlatforms = (value: unknown): DevRyanProjectActionPlatform[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique: DevRyanProjectActionPlatform[] = [];
  const seen = new Set<DevRyanProjectActionPlatform>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim().toLowerCase() as DevRyanProjectActionPlatform;
    if (!DEVRYAN_ACTION_PLATFORM_SET.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
};

const sanitizeProjectActions = (value: unknown): DevRyanProjectAction[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: DevRyanProjectAction[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      name?: unknown;
      command?: unknown;
      icon?: unknown;
      platforms?: unknown;
      autoOpenUrl?: unknown;
      openUrl?: unknown;
      desktopOpenSshForward?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = trimToMaxLength(typeof record.name === 'string' ? record.name.trim() : '', DEVRYAN_PROJECT_ACTION_NAME_MAX_LENGTH);
    const command = trimToMaxLength(typeof record.command === 'string' ? record.command.trim() : '', DEVRYAN_PROJECT_ACTION_COMMAND_MAX_LENGTH);

    if (!id || !name || !command || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const iconRaw = typeof record.icon === 'string' ? record.icon.trim() : '';
    const platforms = sanitizeProjectActionPlatforms(record.platforms);
    const autoOpenUrl = record.autoOpenUrl === true;
    const openUrlRaw = typeof record.openUrl === 'string' ? record.openUrl.trim() : '';
    const openUrl = trimToMaxLength(openUrlRaw, DEVRYAN_PROJECT_ACTION_OPEN_URL_MAX_LENGTH);
    const desktopOpenSshForwardRaw = typeof record.desktopOpenSshForward === 'string'
      ? record.desktopOpenSshForward.trim()
      : '';
    const desktopOpenSshForward = trimToMaxLength(
      desktopOpenSshForwardRaw,
      DEVRYAN_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH
    );

    sanitized.push({
      id,
      name,
      command,
      icon: iconRaw || null,
      ...(autoOpenUrl ? { autoOpenUrl: true } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(desktopOpenSshForward ? { desktopOpenSshForward } : {}),
      ...(platforms.length > 0 ? { platforms } : {}),
    });
  }

  return sanitized;
};

const sanitizeProjectActionsState = (value: {
  actions?: unknown;
  primaryActionId?: unknown;
} | null | undefined): DevRyanProjectActionsState => {
  const actions = sanitizeProjectActions(value?.actions);
  const primaryRaw = typeof value?.primaryActionId === 'string' ? value.primaryActionId.trim() : '';
  const primaryActionId = primaryRaw === DEVRYAN_AUTO_DISCOVER_ACTION_ID || primaryRaw === LEGACY_AUTO_DISCOVER_ACTION_ID
    ? DEVRYAN_AUTO_DISCOVER_ACTION_ID
    : primaryRaw && actions.some((entry) => entry.id === primaryRaw)
    ? primaryRaw
    : null;

  return {
    actions,
    primaryActionId,
  };
};

const sanitizeProjectNotesAndTodos = (value: {
  notes?: unknown;
  todos?: unknown;
} | null | undefined): DevRyanProjectNotesTodos => {
  return {
    notes: sanitizeProjectNotes(value?.notes),
    todos: sanitizeProjectTodoItems(value?.todos),
  };
};

const sanitizePlanTitle = (value: string): string => {
  return trimToMaxLength(value.trim(), DEVRYAN_PROJECT_PLAN_TITLE_MAX_LENGTH);
};

export const parseProjectPlanMarkdown = (raw: string): { title: string; body: string } => {
  const text = typeof raw === 'string' ? raw : '';
  const normalized = text.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (match) {
    const title = sanitizePlanTitle(match[1]);
    const body = normalized.slice(match[0].length).replace(/^\n+/, '');
    return {
      title: title || 'Plan',
      body,
    };
  }

  const firstNonEmptyLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || 'Plan';
  return {
    title: sanitizePlanTitle(firstNonEmptyLine.replace(/^#+\s*/, '')) || 'Plan',
    body: normalized.trim(),
  };
};

/**
 * Read the config for a project.
 * Returns null if file doesn't exist or is invalid.
 */
export async function readDevRyanConfig(project: ProjectRef): Promise<DevRyanConfig | null> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return null;
  }

  const configPath = await getUserConfigPath(project);

  const readText = async (path: string): Promise<string | null> => {
    // Keep behavior consistent with other helpers.
    const text = await readTextFile(path);
    if (text === null) {
      return null;
    }
    return text;
  };

  const parseConfig = (text: string | null): DevRyanConfig | null => {
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as DevRyanConfig;
    } catch {
      return null;
    }
  };

  // 1) Prefer new per-user config.
  if (configPath) {
    const existing = parseConfig(await readText(configPath));
    if (existing) {
      return existing;
    }
  }

  // 2) Migrate legacy <project>/.openchamber/openchamber.json.
  // LEGACY_PROJECT_CONFIG: migrate project-local openchamber.json -> <config folder>/projects/<projectId>.json
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const legacyConfig = parseConfig(await readText(legacyPath));
  if (!legacyConfig) {
    return null;
  }

  // Best-effort write + delete legacy.
  try {
    const wrote = await writeDevRyanConfig(project, legacyConfig);
    if (wrote) {
      await deleteLegacyDevRyanConfig(projectDirectory);
    }
  } catch {
    // Ignore migration failures; still return legacy content.
  }

  return legacyConfig;
}

/**
 * Write the per-user config for a project.
 *
 * Server owns `version` and `scheduledTasks` keys; client reads them via their
 * dedicated route and never round-trips them through this config write path to
 * avoid a read-then-write race clobbering a concurrent server update.
 */
export async function writeDevRyanConfig(
  project: ProjectRef,
  config: DevRyanConfig
): Promise<boolean> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return false;
  }

  const configDir = await getUserProjectsDirectory();
  const configPath = await getUserConfigPath(project);
  if (!configDir || !configPath) {
    return false;
  }

  try {
    const okDir = await mkdirp(configDir);
    if (!okDir) {
      return false;
    }

    const existingRaw = await readTextFile(configPath);
    let existing: Record<string, unknown> = {};
    if (typeof existingRaw === 'string' && existingRaw.trim()) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }

    const serverOwned: Record<string, unknown> = {};
    if (existing.version !== undefined) serverOwned.version = existing.version;
    if (existing.scheduledTasks !== undefined) serverOwned.scheduledTasks = existing.scheduledTasks;

    const content = JSON.stringify({
      ...existing,
      ...config,
      ...serverOwned,
      projectPath: normalize(projectDirectory),
    }, null, 2);
    return await writeTextFile(configPath, content);
  } catch (error) {
    console.error('Failed to write DevRyan config:', error);
    return false;
  }
}

/**
 * Update specific keys in the config, preserving other values.
 */
export async function updateDevRyanConfig(
  project: ProjectRef,
  updates: Partial<DevRyanConfig>
): Promise<boolean> {
  const existing = await readDevRyanConfig(project) || {};
  const merged = { ...existing, ...updates };
  return writeDevRyanConfig(project, merged);
}

/**
 * Get worktree setup commands from config.
 */
export async function getWorktreeSetupCommands(project: ProjectRef): Promise<string[]> {
  const config = await readDevRyanConfig(project);
  return config?.['setup-worktree'] ?? [];
}

export async function saveWorktreeSetupCommands(project: ProjectRef, commands: string[]): Promise<boolean> {
  const filtered = commands.filter((cmd) => cmd.trim().length > 0);
  return updateDevRyanConfig(project, { 'setup-worktree': filtered });
}

export async function getProjectNotesAndTodos(project: ProjectRef): Promise<DevRyanProjectNotesTodos> {
  const config = await readDevRyanConfig(project);
  return sanitizeProjectNotesAndTodos({
    notes: config?.projectNotes,
    todos: config?.projectTodos,
  });
}

export async function saveProjectNotesAndTodos(
  project: ProjectRef,
  value: DevRyanProjectNotesTodos
): Promise<boolean> {
  const sanitized = sanitizeProjectNotesAndTodos({
    notes: value.notes,
    todos: value.todos,
  });

  return updateDevRyanConfig(project, {
    projectNotes: sanitized.notes,
    projectTodos: sanitized.todos,
  });
}

export async function getProjectActionsState(project: ProjectRef): Promise<DevRyanProjectActionsState> {
  const config = await readDevRyanConfig(project);
  return sanitizeProjectActionsState({
    actions: config?.projectActions,
    primaryActionId: config?.projectActionsPrimaryId,
  });
}

export async function saveProjectActionsState(
  project: ProjectRef,
  value: DevRyanProjectActionsState
): Promise<boolean> {
  const sanitized = sanitizeProjectActionsState({
    actions: value.actions,
    primaryActionId: value.primaryActionId,
  });

  return updateDevRyanConfig(project, {
    projectActions: sanitized.actions,
    projectActionsPrimaryId: sanitized.primaryActionId ?? undefined,
  });
}

/**
 * Substitute variables in a command string.
 * Supported variables:
 * - $ROOT_PROJECT_PATH: The root project directory path
 * - $ROOT_WORKTREE_PATH: Legacy alias for $ROOT_PROJECT_PATH
 */
export function substituteCommandVariables(
  command: string,
  variables: { rootWorktreePath: string }
): string {
  return command
    // New preferred name
    .replace(/\$ROOT_PROJECT_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, variables.rootWorktreePath)
    // Legacy
    .replace(/\$ROOT_WORKTREE_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, variables.rootWorktreePath);
}

async function deleteLegacyDevRyanConfig(projectDirectory: string): Promise<void> {
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const runtimeFiles = getRuntimeFilesAPI();

  if (runtimeFiles?.delete) {
    try {
      await runtimeFiles.delete(legacyPath);
      return;
    } catch {
      // fall through
    }
  }

  try {
    await postJson(`${getBaseUrl()}/fs/delete`, { path: legacyPath });
  } catch {
    // ignored
  }
}

export type { ProjectRef };
