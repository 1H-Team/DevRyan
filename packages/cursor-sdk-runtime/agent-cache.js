const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

export function createAgentCache(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(0, Math.floor(options.maxEntries))
    : 16;
  const idleTtlMs = Number.isFinite(options.idleTtlMs)
    ? Math.max(0, Math.floor(options.idleTtlMs))
    : 30 * 60 * 1000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};
  const entries = new Map();

  const notifyEviction = (value, metadata) => {
    try {
      onEvict(value, metadata);
    } catch {
      // Cache ownership must still be released when provider cleanup throws.
    }
  };

  const touch = (key, entry, timestamp = now()) => {
    entry.lastAccessAt = timestamp;
    entries.delete(key);
    entries.set(key, entry);
  };

  const evict = (key, reason) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    notifyEviction(entry.value, {
      key,
      sessionID: entry.sessionID,
      reason,
    });
    return true;
  };

  const prune = () => {
    let removed = 0;
    const timestamp = now();

    for (const [key, entry] of [...entries]) {
      if (entry.activeCount > 0) continue;
      if (entry.releaseRequested) {
        removed += evict(key, 'session_release') ? 1 : 0;
        continue;
      }
      if (timestamp - entry.lastAccessAt > idleTtlMs) {
        removed += evict(key, 'idle_ttl') ? 1 : 0;
      }
    }

    if (entries.size <= maxEntries) return removed;
    for (const [key, entry] of [...entries]) {
      if (entries.size <= maxEntries) break;
      if (entry.activeCount > 0) continue;
      removed += evict(key, 'capacity') ? 1 : 0;
    }
    return removed;
  };

  return {
    get(key) {
      prune();
      const entry = entries.get(key);
      if (!entry || entry.releaseRequested) return undefined;
      touch(key, entry);
      return entry.value;
    },
    set(key, value, metadata = {}) {
      const existing = entries.get(key);
      if (existing) {
        if (existing.value !== value) {
          if (existing.activeCount > 0) {
            notifyEviction(value, {
              key,
              sessionID: normalizeString(metadata.sessionID),
              reason: 'duplicate',
            });
            if (metadata.active === true) existing.activeCount += 1;
            touch(key, existing);
            return existing.value;
          }
          evict(key, 'replacement');
        } else {
          existing.sessionID = normalizeString(metadata.sessionID) || existing.sessionID;
          if (metadata.active === true) existing.activeCount += 1;
          existing.releaseRequested = false;
          touch(key, existing);
          prune();
          return value;
        }
      }

      entries.set(key, {
        value,
        sessionID: normalizeString(metadata.sessionID),
        activeCount: metadata.active === true ? 1 : 0,
        releaseRequested: false,
        lastAccessAt: now(),
      });
      prune();
      return value;
    },
    markActive(key) {
      prune();
      const entry = entries.get(key);
      if (!entry || entry.releaseRequested) return false;
      entry.activeCount += 1;
      touch(key, entry);
      return true;
    },
    markInactive(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      if (entry.activeCount > 0) entry.activeCount -= 1;
      if (entry.activeCount === 0) touch(key, entry);
      prune();
      return true;
    },
    releaseSession(sessionID) {
      const normalizedSessionID = normalizeString(sessionID);
      if (!normalizedSessionID) return 0;
      let released = 0;
      for (const [key, entry] of [...entries]) {
        if (entry.sessionID !== normalizedSessionID) continue;
        released += 1;
        if (entry.activeCount > 0) {
          entry.releaseRequested = true;
          continue;
        }
        evict(key, 'session_release');
      }
      return released;
    },
    prune,
    clear() {
      let removed = 0;
      for (const key of [...entries.keys()]) {
        removed += evict(key, 'shutdown') ? 1 : 0;
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
  };
}
