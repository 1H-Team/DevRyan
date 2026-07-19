import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { opencodeClient } from "@/lib/opencode/client";
import { useProjectsStore } from "@/stores/useProjectsStore";
import type { DevRyanDefaultPlugin, DevRyanDefaultPluginId, PluginConfigError, PluginEntry, PluginFile, PluginsListResponse, SlimSetupIssue, SlimSetupStatus } from "@/lib/api/types";

interface PluginsStore {
  defaults: DevRyanDefaultPlugin[];
  entries: PluginEntry[];
  files: PluginFile[];
  errors: PluginConfigError[];
  selectedId: string | null;
  isLoading: boolean;
  lastError: string | null;
  slimStatus: SlimSetupStatus | null;
  slimStatusLoading: boolean;
  slimActionInFlight: "install" | "repair" | null;
  slimLastError: string | null;

  setSelected: (id: string | null) => void;
  loadPlugins: (options?: { refresh?: boolean }) => Promise<boolean>;
  loadSlimStatus: () => Promise<boolean>;
  installSlimRuntime: () => Promise<boolean>;
  repairSlimRuntime: () => Promise<boolean>;
  getById: (id: string) => DevRyanDefaultPlugin | PluginEntry | PluginFile | undefined;
}

const PLUGINS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_PLUGINS_CACHE_KEY = "__default__";
const pluginsLastLoadedAt = new Map<string, number>();
const pluginsLoadInFlight = new Map<string, Promise<boolean>>();

const getPluginsCacheKey = (directory: string | null): string => directory?.trim() || DEFAULT_PLUGINS_CACHE_KEY;

const getRequestDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn("[PluginsStore] Error resolving config directory:", err);
  }

  return null;
};

const buildPluginsQueryString = (directory: string | null): string => {
  const params = new URLSearchParams();
  if (directory) {
    params.set("directory", directory);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

const normalizePluginEntry = (value: unknown): PluginEntry | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const spec = typeof candidate.spec === "string" ? candidate.spec : "";
  const scope = candidate.scope === "project" ? "project" : candidate.scope === "user" ? "user" : null;
  const parsedKind = candidate.parsedKind === "path" ? "path" : candidate.parsedKind === "npm" ? "npm" : null;
  const sourcePath = typeof candidate.sourcePath === "string" ? candidate.sourcePath : "";
  const options = candidate.options && typeof candidate.options === "object" && !Array.isArray(candidate.options)
    ? candidate.options as Record<string, unknown>
    : undefined;
  const defaultPluginId = normalizeDefaultPluginId(candidate.defaultPluginId);

  if (!id || !spec || !scope || !parsedKind || !sourcePath || candidate.kind !== "config") {
    return null;
  }

  return {
    id,
    spec,
    ...(options ? { options } : {}),
    scope,
    kind: "config",
    parsedKind,
    sourcePath,
    ...(defaultPluginId ? { defaultPluginId } : {}),
  };
};

const normalizeDefaultPluginId = (value: unknown): DevRyanDefaultPluginId | null => (
  value === "oh-my-opencode-slim"
    || value === "opencode-with-claude"
    || value === "openai-tool-schema-sanitizer"
    ? value
    : null
);

const normalizeDefaultPlugin = (value: unknown): DevRyanDefaultPlugin | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const pluginId = normalizeDefaultPluginId(candidate.pluginId);
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName : "";
  const shippedSpec = typeof candidate.shippedSpec === "string" ? candidate.shippedSpec : "";
  const effectiveSpec = typeof candidate.effectiveSpec === "string" ? candidate.effectiveSpec : "";
  const version = typeof candidate.version === "string" ? candidate.version : candidate.version === null ? null : undefined;
  const delivery = candidate.delivery === "npm" ? "npm" : candidate.delivery === "bundled-file" ? "bundled-file" : null;
  const sourcePath = typeof candidate.sourcePath === "string" ? candidate.sourcePath : "";
  const configuredSourcePath = typeof candidate.configuredSourcePath === "string" ? candidate.configuredSourcePath : undefined;

  if (!id || !pluginId || !displayName || !shippedSpec || !effectiveSpec || version === undefined || !delivery || !sourcePath || candidate.kind !== "default") {
    return null;
  }

  return {
    id,
    pluginId,
    displayName,
    shippedSpec,
    effectiveSpec,
    version,
    delivery,
    sourcePath,
    ...(configuredSourcePath ? { configuredSourcePath } : {}),
    kind: "default",
  };
};

const normalizePluginFile = (value: unknown): PluginFile | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const fileName = typeof candidate.fileName === "string" ? candidate.fileName : "";
  const scope = candidate.scope === "project" ? "project" : candidate.scope === "user" ? "user" : null;
  const absolutePath = typeof candidate.absolutePath === "string" ? candidate.absolutePath : "";
  const defaultPluginId = normalizeDefaultPluginId(candidate.defaultPluginId);

  if (!id || !fileName || !scope || !absolutePath || candidate.kind !== "file") {
    return null;
  }

  return {
    id,
    fileName,
    scope,
    kind: "file",
    absolutePath,
    ...(defaultPluginId ? { defaultPluginId } : {}),
  };
};

const normalizePluginError = (value: unknown): PluginConfigError | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope === "project" ? "project" : candidate.scope === "user" ? "user" : null;
  const sourcePath = typeof candidate.sourcePath === "string" ? candidate.sourcePath : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const index = typeof candidate.index === "number" && Number.isFinite(candidate.index)
    ? Math.round(candidate.index)
    : null;

  if (!scope || !sourcePath || !message) {
    return null;
  }

  return { scope, sourcePath, index, message };
};

const normalizePluginsResponse = (payload: unknown): PluginsListResponse => {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return {
    defaults: Array.isArray(candidate.defaults) ? candidate.defaults.map(normalizeDefaultPlugin).filter((plugin): plugin is DevRyanDefaultPlugin => plugin !== null) : [],
    entries: Array.isArray(candidate.entries) ? candidate.entries.map(normalizePluginEntry).filter((entry): entry is PluginEntry => entry !== null) : [],
    files: Array.isArray(candidate.files) ? candidate.files.map(normalizePluginFile).filter((file): file is PluginFile => file !== null) : [],
    errors: Array.isArray(candidate.errors) ? candidate.errors.map(normalizePluginError).filter((error): error is PluginConfigError => error !== null) : [],
  };
};

const normalizeSlimIssue = (value: unknown): SlimSetupIssue | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return code && message ? { code, message } : null;
};

const normalizeStringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
);

const normalizeSlimStatus = (payload: unknown): SlimSetupStatus => {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const wrapperStatus = candidate.wrapperStatus && typeof candidate.wrapperStatus === "object" && !Array.isArray(candidate.wrapperStatus)
    ? candidate.wrapperStatus as Record<string, unknown>
    : null;
  return {
    ok: typeof candidate.ok === "boolean" ? candidate.ok : undefined,
    installedVersion: typeof candidate.installedVersion === "string" ? candidate.installedVersion : null,
    configDirectory: typeof candidate.configDirectory === "string" ? candidate.configDirectory : undefined,
    configPath: typeof candidate.configPath === "string" ? candidate.configPath : undefined,
    slimConfigPath: typeof candidate.slimConfigPath === "string" ? candidate.slimConfigPath : undefined,
    wrapperPath: typeof candidate.wrapperPath === "string" ? candidate.wrapperPath : undefined,
    packageJsonPath: typeof candidate.packageJsonPath === "string" ? candidate.packageJsonPath : undefined,
    runtimeEnabled: candidate.runtimeEnabled === true,
    wrapperConfigured: candidate.wrapperConfigured === true,
    wrapperStatus: wrapperStatus ? {
      configured: wrapperStatus.configured === true,
      wrapperRegistered: wrapperStatus.wrapperRegistered === true,
      wrapperFileExists: wrapperStatus.wrapperFileExists === true,
      rawRegistered: wrapperStatus.rawRegistered === true,
      path: typeof wrapperStatus.path === "string" ? wrapperStatus.path : "",
      spec: typeof wrapperStatus.spec === "string" ? wrapperStatus.spec : "",
    } : undefined,
    packageDependencyInstalled: candidate.packageDependencyInstalled === true,
    slimConfigExists: typeof candidate.slimConfigExists === "boolean" ? candidate.slimConfigExists : undefined,
    backgroundSubagentsEnv: typeof candidate.backgroundSubagentsEnv === "string" ? candidate.backgroundSubagentsEnv : undefined,
    changedFiles: normalizeStringArray(candidate.changedFiles),
    backupPaths: normalizeStringArray(candidate.backupPaths),
    issues: Array.isArray(candidate.issues) ? candidate.issues.map(normalizeSlimIssue).filter((issue): issue is SlimSetupIssue => issue !== null) : [],
    repair: candidate.repair === true,
    reload: candidate.reload,
  };
};

const buildPluginsSignature = (data: PluginsListResponse): string => {
  return JSON.stringify({
    defaults: data.defaults,
    entries: data.entries.map((entry) => ({
      id: entry.id,
      spec: entry.spec,
      options: entry.options ?? null,
      scope: entry.scope,
      parsedKind: entry.parsedKind,
      sourcePath: entry.sourcePath,
      defaultPluginId: entry.defaultPluginId ?? null,
    })),
    files: data.files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      scope: file.scope,
      absolutePath: file.absolutePath,
      defaultPluginId: file.defaultPluginId ?? null,
    })),
    errors: data.errors,
  });
};

export const usePluginsStore = create<PluginsStore>()(
  devtools(
    (set, get) => ({
      defaults: [],
      entries: [],
      files: [],
      errors: [],
      selectedId: null,
      isLoading: false,
      lastError: null,
      slimStatus: null,
      slimStatusLoading: false,
      slimActionInFlight: null,
      slimLastError: null,

      setSelected: (id) => set({ selectedId: id }),

      loadPlugins: async (options) => {
        const directory = getRequestDirectory();
        const cacheKey = getPluginsCacheKey(directory);
        const now = Date.now();
        const loadedAt = pluginsLastLoadedAt.get(cacheKey) ?? 0;
        const hasCachedPlugins = get().defaults.length > 0 || get().entries.length > 0 || get().files.length > 0 || get().errors.length > 0;

        if (!options?.refresh && hasCachedPlugins && now - loadedAt < PLUGINS_LOAD_CACHE_TTL_MS) {
          return true;
        }

        const inFlight = pluginsLoadInFlight.get(cacheKey);
        if (!options?.refresh && inFlight) {
          return inFlight;
        }

        const request = (async () => {
          set({ isLoading: true, lastError: null });
          try {
            const response = await fetch(`/api/config/plugins${buildPluginsQueryString(directory)}`, {
              headers: { Accept: "application/json" },
            });
            if (!response.ok) {
              throw new Error("Failed to load plugins");
            }
            const next = normalizePluginsResponse(await response.json().catch(() => ({})));
            const current = get();
            const currentSignature = buildPluginsSignature({
              defaults: current.defaults,
              entries: current.entries,
              files: current.files,
              errors: current.errors,
            });
            const nextSignature = buildPluginsSignature(next);

            if (currentSignature === nextSignature) {
              set({ isLoading: false, lastError: null });
            } else {
              const nextIds = new Set([...next.entries, ...next.files].map((item) => item.id));
              set({
                ...next,
                selectedId: current.selectedId && nextIds.has(current.selectedId) ? current.selectedId : null,
                isLoading: false,
                lastError: null,
              });
            }
            pluginsLastLoadedAt.set(cacheKey, Date.now());
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[PluginsStore] Failed to load plugins:", error);
            set({ isLoading: false, lastError: message });
            return false;
          }
        })();

        pluginsLoadInFlight.set(cacheKey, request);
        try {
          return await request;
        } finally {
          pluginsLoadInFlight.delete(cacheKey);
        }
      },

      loadSlimStatus: async () => {
        set({ slimStatusLoading: true, slimLastError: null });
        try {
          const response = await fetch("/api/config/slim/status", {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) {
            throw new Error("Failed to load Slim runtime status");
          }
          const status = normalizeSlimStatus(await response.json().catch(() => ({})));
          set({ slimStatus: status, slimStatusLoading: false, slimLastError: null });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[PluginsStore] Failed to load Slim status:", error);
          set({ slimStatusLoading: false, slimLastError: message });
          return false;
        }
      },

      installSlimRuntime: async () => {
        set({ slimActionInFlight: "install", slimLastError: null });
        try {
          const response = await fetch("/api/config/slim/install", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok) {
            throw new Error("Failed to install Slim runtime");
          }
          const status = normalizeSlimStatus(await response.json().catch(() => ({})));
          set({ slimStatus: status, slimActionInFlight: null, slimLastError: null });
          await get().loadPlugins({ refresh: true });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[PluginsStore] Failed to install Slim runtime:", error);
          set({ slimActionInFlight: null, slimLastError: message });
          return false;
        }
      },

      repairSlimRuntime: async () => {
        set({ slimActionInFlight: "repair", slimLastError: null });
        try {
          const response = await fetch("/api/config/slim/repair", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok) {
            throw new Error("Failed to repair Slim runtime");
          }
          const status = normalizeSlimStatus(await response.json().catch(() => ({})));
          set({ slimStatus: status, slimActionInFlight: null, slimLastError: null });
          await get().loadPlugins({ refresh: true });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[PluginsStore] Failed to repair Slim runtime:", error);
          set({ slimActionInFlight: null, slimLastError: message });
          return false;
        }
      },

      getById: (id) => {
        return get().defaults.find((plugin) => plugin.id === id)
          || get().entries.find((entry) => entry.id === id)
          || get().files.find((file) => file.id === id);
      },
    }),
    { name: "plugins-store" },
  ),
);
