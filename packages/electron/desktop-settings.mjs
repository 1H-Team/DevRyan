import path from 'node:path';
import { persistWindowState } from './window-state-persistence.mjs';

export function createDesktopSettings({ fs, fsp, os, process, log, getMainWindow, minWidth, minHeight, LOCAL_HOST_ID, setTimeout = globalThis.setTimeout }) {
  const windowGeometryRevisions = new Map();
  const settingsFilePath = () => {
    if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()) {
      return path.join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json');
    }
    return path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
  };

  const readJsonFile = (filePath) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      // Parse errors can happen if a concurrent writer just truncated the file
      // and hasn't finished writing yet. Log loudly so we notice, then return
      // {} as before. Writes are atomic (tmp + rename) so this race is rare.
      log.warn?.('[electron] failed to read JSON file', filePath, error);
      return {};
    }
  };

  const writeJsonFile = async (filePath, data) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Atomic: write to a temp file then rename. Readers never see a partial
    // JSON file that could parse-error and get coerced to {}.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, filePath);
  };

  const readSettingsRoot = () => {
    const root = readJsonFile(settingsFilePath());
    return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
  };

  // Serializes read-modify-write of the settings file within this process.
  // Multiple call sites (spawnLocalServer, writeDesktopHostsConfig, theme
  // preference saves, ssh manager imports, etc.) would otherwise have their
  // RMW pairs interleave across awaits, letting one writer's stale copy
  // overwrite another writer's just-persisted changes.
  let settingsMutationChain = Promise.resolve();
  const mutateSettingsRoot = (mutator) => {
    const next = settingsMutationChain.then(async () => {
      const current = readSettingsRoot();
      const result = await mutator(current);
      const nextRoot = result ?? current;
      await writeJsonFile(settingsFilePath(), nextRoot);
    });
    // Keep the chain alive even if one mutator throws.
    settingsMutationChain = next.catch(() => {});
    return next;
  };

  const normalizeHostUrl = (raw) => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const sanitizeHostUrlForStorage = (raw) => normalizeHostUrl(raw);

  const readDesktopHostsConfig = () => {
    const root = readSettingsRoot();
    const hostsRaw = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
    const hosts = hostsRaw
      .map((entry) => {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        const url = sanitizeHostUrlForStorage(entry?.url);
        if (!id || id === LOCAL_HOST_ID || !url) return null;
        const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url;
        return { id, label, url };
      })
      .filter(Boolean);

    return {
      hosts,
      defaultHostId: typeof root.desktopDefaultHostId === 'string' && root.desktopDefaultHostId.trim()
        ? root.desktopDefaultHostId.trim()
        : null,
      initialHostChoiceCompleted: root.desktopInitialHostChoiceCompleted === true,
    };
  };

  const writeDesktopHostsConfig = async (config) => {
    await mutateSettingsRoot((root) => {
      root.desktopHosts = Array.isArray(config?.hosts)
        ? config.hosts
            .map((entry) => {
              const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
              const url = sanitizeHostUrlForStorage(entry?.url);
              if (!id || id === LOCAL_HOST_ID || !url) return null;
              return {
                id,
                label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url,
                url,
              };
            })
            .filter(Boolean)
        : [];
      root.desktopDefaultHostId = typeof config?.defaultHostId === 'string' && config.defaultHostId.trim()
        ? config.defaultHostId.trim()
        : null;
      if (typeof config?.initialHostChoiceCompleted === 'boolean') {
        root.desktopInitialHostChoiceCompleted = config.initialHostChoiceCompleted;
      }
    });
  };

  const readWindowState = () => {
    const stateValue = readSettingsRoot().desktopWindowState;
    return stateValue && typeof stateValue === 'object' ? stateValue : null;
  };

  const writeWindowState = async (browserWindow) => {
    await persistWindowState({
      browserWindow,
      mainWindowID: getMainWindow()?.id ?? null,
      minWidth: minWidth,
      minHeight: minHeight,
      mutateSettingsRoot,
    });
  };

  const debounceWindowStatePersist = (browserWindow, immediate = false) => {
    if (!browserWindow || browserWindow.isDestroyed()) return;
    const key = String(browserWindow.id);
    const revision = (windowGeometryRevisions.get(key) || 0) + 1;
    windowGeometryRevisions.set(key, revision);

    const persist = async () => {
      if (windowGeometryRevisions.get(key) !== revision) return;
      await writeWindowState(browserWindow);
    };
    const reportFailure = (error) => {
      log.warn('[electron] failed to persist window state:', error);
    };

    if (immediate) {
      void persist().catch(reportFailure);
      return;
    }

    setTimeout(() => {
      void persist().catch(reportFailure);
    }, 300);
  };

    return { settingsFilePath, readSettingsRoot, mutateSettingsRoot, normalizeHostUrl, readDesktopHostsConfig, writeDesktopHostsConfig, readWindowState, writeWindowState, debounceWindowStatePersist };
}
