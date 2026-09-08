import { avatarDimensions, encodeAvatarCanvas } from './botAvatarUpload';

/** Private, window-local avatar reuse. Never writes authenticated images to disk. */
export type BotAvatarIdentity = { principalId: string | null; botId: string; source: string };
type LoadedAvatar = { url: string; bytes: number; dispose(): void };
type Entry = {
  identity: BotAvatarIdentity;
  controller: AbortController;
  listeners: Set<() => void>;
  image: LoadedAvatar | null;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  priority: number;
  touched: number;
};
export const botAvatarKey = (identity: BotAvatarIdentity): string => JSON.stringify([
  identity.principalId, identity.botId, identity.source,
]);

const decodeAvatar = async (blob: Blob, signal: AbortSignal) => {
  if (signal.aborted) throw new Error('avatar_aborted');
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    image.src = '';
    URL.revokeObjectURL(url);
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    image.src = url;
    await image.decode();
    if (signal.aborted) throw new Error('avatar_aborted');
    return { image, url, dispose };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    signal.removeEventListener('abort', dispose);
  }
};

const loadAvatar = async (identity: BotAvatarIdentity, signal: AbortSignal): Promise<LoadedAvatar> => {
  const response = await fetch(identity.source, { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('avatar_unavailable');
  let blob = await response.blob();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > 5 * 1024 * 1024) {
    throw new Error('avatar_invalid');
  }
  let decoded = await decodeAvatar(blob, signal);
  try {
    // Older uploaded photos remain supported, but retain only avatar-sized
    // pixels in memory rather than a multi-megapixel decoded photograph.
    if (Math.max(decoded.image.naturalWidth, decoded.image.naturalHeight) > 256) {
      const canvas = document.createElement('canvas');
      const size = avatarDimensions(decoded.image.naturalWidth, decoded.image.naturalHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('avatar_resize_unavailable');
      context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
      blob = await encodeAvatarCanvas(canvas);
      decoded.dispose();
      decoded = await decodeAvatar(blob, signal);
    }
    if (signal.aborted) throw new Error('avatar_aborted');
    return { url: decoded.url,
      bytes: blob.size + decoded.image.naturalWidth * decoded.image.naturalHeight * 4,
      dispose: decoded.dispose };
  } catch (error) {
    decoded.dispose();
    throw error;
  }
};

export const createBotAvatarCache = ({
  maxEntries = 100,
  maxBytes = 20 * 1024 * 1024,
  concurrency = 4,
  load = loadAvatar,
}: {
  maxEntries?: number; maxBytes?: number; concurrency?: number;
  load?: (identity: BotAvatarIdentity, signal: AbortSignal) => Promise<LoadedAvatar>;
} = {}) => {
  const entries = new Map<string, Entry>();
  let active = 0;
  let bytes = 0;
  let clock = 0;
  let scheduled = false;
  const remove = (key: string, entry: Entry) => {
    entries.delete(key);
    entry.controller.abort();
    if (entry.image) { bytes -= entry.image.bytes; entry.image.dispose(); }
    entry.image = null;
    for (const notify of entry.listeners) notify();
  };
  const makeRoom = (extraEntries: number, extraBytes: number, protect?: Entry): boolean => {
    const unused = [...entries.entries()].filter(([, entry]) => entry !== protect && entry.listeners.size === 0)
      .sort(([, a], [, b]) => a.touched - b.touched);
    while (entries.size + extraEntries > maxEntries || bytes + extraBytes > maxBytes) {
      const oldest = unused.shift();
      if (!oldest) return false;
      remove(...oldest);
    }
    return true;
  };
  const pump = () => {
    scheduled = false;
    const queued = [...entries.entries()].filter(([, entry]) => entry.state === 'queued')
      .sort(([, a], [, b]) => b.priority - a.priority || a.touched - b.touched);
    while (active < concurrency && queued.length) {
      const next = queued.shift();
      if (!next) break;
      const [key, entry] = next;
      if (entries.get(key) !== entry) continue;
      entry.state = 'loading';
      active += 1;
      const deadline = setTimeout(() => entry.controller.abort(), 15_000);
      void Promise.resolve().then(() => load(entry.identity, entry.controller.signal)).then((image) => {
        if (entries.get(key) !== entry) { image.dispose(); return; }
        if (entry.controller.signal.aborted) { image.dispose(); throw new Error('avatar_aborted'); }
        if (image.bytes > maxBytes || !makeRoom(0, image.bytes, entry)) {
          image.dispose();
          throw new Error('avatar_capacity');
        }
        entry.image = image;
        bytes += image.bytes;
        entry.state = 'ready';
        for (const notify of entry.listeners) notify();
      }).catch(() => { if (entries.get(key) === entry) entry.state = 'failed'; })
        .finally(() => { clearTimeout(deadline); active -= 1; schedule(); });
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(pump); } };
  const ensure = (identity: BotAvatarIdentity, priority: number): Entry | null => {
    const key = botAvatarKey(identity);
    let entry = entries.get(key);
    if (!entry) {
      if (!makeRoom(1, 0)) return null;
      entry = { identity, controller: new AbortController(), listeners: new Set(), image: null,
        state: 'queued', priority, touched: ++clock };
      entries.set(key, entry);
    } else {
      entry.priority = Math.max(priority, entry.priority);
      entry.touched = ++clock;
      if (entry.state === 'failed') { entry.controller = new AbortController(); entry.state = 'queued'; }
    }
    schedule();
    return entry;
  };
  return {
    peek(identity: BotAvatarIdentity): string | null { return entries.get(botAvatarKey(identity))?.image?.url ?? null; },
    subscribe(identity: BotAvatarIdentity, notify: () => void, priority = 0): () => void {
      const entry = ensure(identity, priority);
      entry?.listeners.add(notify);
      return () => { entry?.listeners.delete(notify); };
    },
    prefetch(identity: BotAvatarIdentity, priority = 1) { ensure(identity, priority); },
    invalidateBot(botId: string) {
      for (const [key, entry] of entries) if (entry.identity.botId === botId) remove(key, entry);
    },
    clear() { for (const [key, entry] of entries) remove(key, entry); },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
};
export const botAvatarCache = createBotAvatarCache();
