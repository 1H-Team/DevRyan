export const createManagedTunnelConfigRuntime = (deps) => {
  const {
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelToken,
    normalizeManagedRemoteOriginPort,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      let token = '';
      try {
        token = normalizeManagedRemoteTunnelToken(entry.token);
      } catch {
        continue;
      }
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
      const originPort = normalizeManagedRemoteOriginPort(entry.originPort);

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, originPort, token, updatedAt });
    }

    return result;
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    const tempPath = `${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fsPromises.chmod?.(tempPath, 0o600);
      await fsPromises.rename(tempPath, CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH);
      await fsPromises.chmod?.(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 0o600);
    } catch (error) {
      await fsPromises.rm?.(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(legacyRaw);
      const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed?.tunnels);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }

      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
      };
      if (parsed.version !== CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION) {
        try {
          await writeManagedRemoteTunnelConfigToDisk(migrated);
        } catch (error) {
          console.warn('Failed to persist managed remote tunnel schema migration:', error);
        }
      }
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(async () => {
      const current = await readManagedRemoteTunnelConfigFromDisk();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

    return persistManagedRemoteTunnelConfigLock;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
          originPort: normalizeManagedRemoteOriginPort(preset.originPort),
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, originPort, token }) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedOriginPort = normalizeManagedRemoteOriginPort(originPort);
    const normalizedToken = normalizeManagedRemoteTunnelToken(token);
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        originPort: normalizedOriginPort,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelPreset = async ({ presetId, hostname }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname;
      }
    }

    return null;
  };

  const resolveManagedRemoteTunnelToken = async (selector) => {
    const preset = await resolveManagedRemoteTunnelPreset(selector);
    return preset?.token || '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelPreset,
    resolveManagedRemoteTunnelToken,
  };
};
