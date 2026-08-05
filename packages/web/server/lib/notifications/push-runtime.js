import crypto from 'node:crypto';

const PUSH_SUBSCRIPTIONS_VERSION = 2;
const SESSION_KEY_PATTERN = /^[a-f0-9]{64}$/;
const sessionStorageKey = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

const isLoopbackHttpOrigin = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps) => {
  const {
    fsPromises,
    path,
    webPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
  } = deps;

  let persistPushSubscriptionsLock = Promise.resolve();
  let pushInitialized = false;
  let sessionVisibilityFilter = null;

  const uiVisibilityByToken = new Map();
  let globalVisibilityState = false;

  const readPushSubscriptionsFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      if (typeof parsed.version !== 'number' || ![1, PUSH_SUBSCRIPTIONS_VERSION].includes(parsed.version)) {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }

      const subscriptionsBySession =
        parsed.subscriptionsBySession && typeof parsed.subscriptionsBySession === 'object'
          ? parsed.subscriptionsBySession
          : {};

      const migrated = {};
      let needsMigration = parsed.version !== PUSH_SUBSCRIPTIONS_VERSION;
      for (const [key, entries] of Object.entries(subscriptionsBySession)) {
        const safeKey = SESSION_KEY_PATTERN.test(key) ? key : sessionStorageKey(key);
        if (safeKey !== key) needsMigration = true;
        migrated[safeKey] = [
          ...(Array.isArray(migrated[safeKey]) ? migrated[safeKey] : []),
          ...(Array.isArray(entries) ? entries : []),
        ];
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: migrated, needsMigration };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      console.warn('Failed to read push subscriptions file:', error);
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
  };

  const writePushSubscriptionsToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true, mode: 0o700 });
    const temporaryPath = `${PUSH_SUBSCRIPTIONS_FILE_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(temporaryPath, PUSH_SUBSCRIPTIONS_FILE_PATH);
    await fsPromises.chmod(PUSH_SUBSCRIPTIONS_FILE_PATH, 0o600);
  };

  const persistPushSubscriptionUpdate = async (mutate) => {
    persistPushSubscriptionsLock = persistPushSubscriptionsLock.then(async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk();
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: current.subscriptionsBySession || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    });

    return persistPushSubscriptionsLock;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const generated = webPush.generateVAPIDKeys();
    const next = {
      ...settings,
      vapidKeys: {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      },
    };

    await writeSettingsToDisk(next);
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  };

  const normalizePushSubscriptions = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
        };
      })
      .filter(Boolean);
  };

  const addOrUpdatePushSubscription = async (uiSessionToken, subscription, userAgent) => {
    if (!uiSessionToken) {
      return;
    }

    await ensurePushInitialized();

    const now = Date.now();

    const storageKey = sessionStorageKey(uiSessionToken);
    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[storageKey]) ? subsBySession[storageKey] : [];

      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
      });

      subsBySession[storageKey] = filtered.slice(0, 10);

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscription = async (uiSessionToken, endpoint) => {
    if (!uiSessionToken || !endpoint) return;

    await ensurePushInitialized();

    const storageKey = sessionStorageKey(uiSessionToken);
    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[storageKey]) ? subsBySession[storageKey] : [];
      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[storageKey];
      } else {
        subsBySession[storageKey] = filtered;
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint) => {
    if (!endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const sendPushToSubscription = async (sub, payload) => {
    await ensurePushInitialized();
    const body = JSON.stringify(payload);

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async (payload, options = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const sessions = store.subscriptionsBySession || {};
    const subscriptionsByEndpoint = new Map();

    const sessionId = typeof payload?.data?.sessionId === 'string'
      ? payload.data.sessionId
      : typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    for (const [storageKey, record] of Object.entries(sessions)) {
      if (sessionId && typeof sessionVisibilityFilter === 'function') {
        const allowed = await sessionVisibilityFilter(storageKey, sessionId).catch(() => false);
        if (!allowed) continue;
      }
      if (requireNoSse && isUiVisible(storageKey, { alreadyHashed: true })) continue;
      const subscriptions = normalizePushSubscriptions(record);
      if (subscriptions.length === 0) continue;

      for (const sub of subscriptions) {
        if (!subscriptionsByEndpoint.has(sub.endpoint)) {
          subscriptionsByEndpoint.set(sub.endpoint, sub);
        }
      }
    }

    await Promise.all(Array.from(subscriptionsByEndpoint.values()).map(async (sub) => {
      await sendPushToSubscription(sub, payload);
    }));
  };

  const updateUiVisibility = (token, visible) => {
    if (!token) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    uiVisibilityByToken.set(sessionStorageKey(token), { visible: nextVisible, updatedAt: now });
    globalVisibilityState = nextVisible;
  };

  const isAnyUiVisible = () => globalVisibilityState === true
    || [...uiVisibilityByToken.values()].some((entry) => entry.visible === true);

  const isUiVisible = (token, { alreadyHashed = false } = {}) => (
    uiVisibilityByToken.get(alreadyHashed ? token : sessionStorageKey(token))?.visible === true
  );

  const setSessionVisibilityFilter = (filter) => {
    sessionVisibilityFilter = typeof filter === 'function' ? filter : null;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (typeof stored === 'string' && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
    }

    return 'mailto:openchamber@localhost';
  };

  const ensurePushInitialized = async () => {
    if (pushInitialized) return;
    const subscriptions = await readPushSubscriptionsFromDisk();
    if (subscriptions.needsMigration) {
      await persistPushSubscriptionUpdate((current) => ({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: current.subscriptionsBySession || {},
      }));
    }
    const keys = await getOrCreateVapidKeys();
    const subject = await resolveVapidSubject();

    if (subject === 'mailto:openchamber@localhost') {
      console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
    }

    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isUiVisible,
    setSessionVisibilityFilter,
    ensurePushInitialized,
    setPushInitialized,
  };
};
