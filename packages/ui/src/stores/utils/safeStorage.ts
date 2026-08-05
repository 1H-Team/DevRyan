let safeStorageInstance: Storage | null = null;
let safeSessionStorageInstance: Storage | null = null;
let deviceStorageInstance: Storage | null = null;

export const STORAGE_PRINCIPAL_KEY = 'devryan.auth.principalId';
let storagePrincipal = (() => {
    if (typeof window === 'undefined') return 'anonymous';
    try {
        return window.localStorage.getItem(STORAGE_PRINCIPAL_KEY) || 'anonymous';
    } catch {
        return 'anonymous';
    }
})();

const normalizePrincipal = (value: string | null | undefined): string => {
    const normalized = String(value || '').trim();
    return normalized && normalized.length <= 160 ? normalized : 'anonymous';
};

const principalPrefix = (): string => `devryan.user.${encodeURIComponent(storagePrincipal)}:`;

export const getPrincipalStorageKey = (key: string): string => `${principalPrefix()}${key}`;

const createInMemoryStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
};

const getWindowStorage = (name: 'localStorage' | 'sessionStorage'): Storage | null => {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return window[name] ?? null;
    } catch {
        return null;
    }
};

export const isPrincipalStorageEvent = (event: StorageEvent, key: string): boolean => (
    event.storageArea === getWindowStorage('localStorage')
    && event.key === getPrincipalStorageKey(key)
);

const createSafeStorage = (): Storage => {
    const baseStorage = getWindowStorage('localStorage');
    if (!baseStorage) {
        return createInMemoryStorage();
    }

    const fallback = createInMemoryStorage();
    let storageAvailable = true;

    const disableStorage = () => {
        storageAvailable = false;
    };

    const safeGet = (key: string): string | null => {
        if (storageAvailable) {
            try {
                const value = baseStorage.getItem(key);
                if (value !== null) {
                    return value;
                }
            } catch {
                disableStorage();
            }
        }
        return fallback.getItem(key);
    };

    const safeSet = (key: string, value: string) => {
        if (storageAvailable) {
            try {
                baseStorage.setItem(key, value);
                fallback.removeItem(key);
                return;
            } catch {
                disableStorage();
                // Prevent stale previous value from surviving when writes fail (e.g. quota).
                try {
                    baseStorage.removeItem(key);
                } catch {
                    // noop
                }
            }
        }
        fallback.setItem(key, value);
    };

    const safeRemove = (key: string) => {
        try {
            baseStorage.removeItem(key);
        } catch {
            disableStorage();
        }
        fallback.removeItem(key);
    };

    const safeClear = () => {
        try {
            baseStorage.clear();
        } catch {
            disableStorage();
        }
        fallback.clear();
    };

    const safeKey = (index: number): string | null => {
        if (storageAvailable) {
            try {
                return baseStorage.key(index);
            } catch {
                disableStorage();
            }
        }
        return fallback.key(index);
    };

    return {
        getItem: safeGet,
        setItem: safeSet,
        removeItem: safeRemove,
        clear: safeClear,
        key: safeKey,
        get length() {
            if (storageAvailable) {
                try {
                    return baseStorage.length + fallback.length;
                } catch {
                    disableStorage();
                }
            }
            return fallback.length;
        },
    } as Storage;
};

const createNamespacedStorage = (baseStorage: Storage): Storage => {
    const physicalKey = (key: string): string => `${principalPrefix()}${key}`;
    const listKeys = (): string[] => {
        const prefix = principalPrefix();
        const keys: string[] = [];
        for (let index = 0; index < baseStorage.length; index += 1) {
            const candidate = baseStorage.key(index);
            if (candidate?.startsWith(prefix)) keys.push(candidate.slice(prefix.length));
        }
        return keys;
    };

    return {
        getItem: (key: string) => baseStorage.getItem(physicalKey(key)),
        setItem: (key: string, value: string) => baseStorage.setItem(physicalKey(key), value),
        removeItem: (key: string) => baseStorage.removeItem(physicalKey(key)),
        clear: () => {
            for (const key of listKeys()) baseStorage.removeItem(physicalKey(key));
        },
        key: (index: number) => listKeys()[index] ?? null,
        get length() {
            return listKeys().length;
        },
    } as Storage;
};

export const getStoragePrincipal = (): string => storagePrincipal;

export const setStoragePrincipal = (principalId: string): boolean => {
    const next = normalizePrincipal(principalId);
    const changed = next !== storagePrincipal;
    storagePrincipal = next;
    if (typeof window !== 'undefined') {
        try {
            window.localStorage.setItem(STORAGE_PRINCIPAL_KEY, next);
            window.localStorage.removeItem('openaiApiKey');
        } catch {
            // In-memory storage remains isolated even when persistent storage is blocked.
        }
    }
    return changed;
};

export const getSafeStorage = (): Storage => {
    if (!safeStorageInstance) {
        safeStorageInstance = createNamespacedStorage(createSafeStorage());
    }
    return safeStorageInstance;
};

/** Device-scoped storage for pre-authentication preferences only. */
export const getDeviceStorage = (): Storage => {
    if (!deviceStorageInstance) {
        deviceStorageInstance = createSafeStorage();
    }
    return deviceStorageInstance;
};

const createSafeSessionStorage = (): Storage => {
    const baseStorage = getWindowStorage('sessionStorage');
    if (!baseStorage) {
        return createInMemoryStorage();
    }

    const fallback = createInMemoryStorage();
    let storageAvailable = true;

    const disableStorage = () => {
        storageAvailable = false;
    };

    const safeGet = (key: string): string | null => {
        if (storageAvailable) {
            try {
                const value = baseStorage.getItem(key);
                if (value !== null) {
                    return value;
                }
            } catch {
                disableStorage();
            }
        }
        return fallback.getItem(key);
    };

    const safeSet = (key: string, value: string) => {
        if (storageAvailable) {
            try {
                baseStorage.setItem(key, value);
                fallback.removeItem(key);
                return;
            } catch {
                disableStorage();
                // Prevent stale previous value from surviving when writes fail (e.g. quota).
                try {
                    baseStorage.removeItem(key);
                } catch {
                    // noop
                }
            }
        }
        fallback.setItem(key, value);
    };

    const safeRemove = (key: string) => {
        try {
            baseStorage.removeItem(key);
        } catch {
            disableStorage();
        }
        fallback.removeItem(key);
    };

    const safeClear = () => {
        try {
            baseStorage.clear();
        } catch {
            disableStorage();
        }
        fallback.clear();
    };

    const safeKey = (index: number): string | null => {
        if (storageAvailable) {
            try {
                return baseStorage.key(index);
            } catch {
                disableStorage();
            }
        }
        return fallback.key(index);
    };

    return {
        getItem: safeGet,
        setItem: safeSet,
        removeItem: safeRemove,
        clear: safeClear,
        key: safeKey,
        get length() {
            if (storageAvailable) {
                try {
                    return baseStorage.length + fallback.length;
                } catch {
                    disableStorage();
                }
            }
            return fallback.length;
        },
    } as Storage;
};

export const getSafeSessionStorage = (): Storage => {
    if (!safeSessionStorageInstance) {
        safeSessionStorageInstance = createNamespacedStorage(createSafeSessionStorage());
    }
    return safeSessionStorageInstance;
};
