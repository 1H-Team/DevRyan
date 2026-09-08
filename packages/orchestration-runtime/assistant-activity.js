// Startup evidence is semantic output, never an empty message or a busy status.
export const isManagedAssistantActivityPart = (part) => (
  ((part?.type === 'text' || part?.type === 'reasoning')
    && typeof part.text === 'string' && part.text.trim().length > 0)
  || (part?.type === 'tool' && typeof part.callID === 'string' && part.callID.length > 0)
);

// Retain only identities for actively watched children, never transcript content.
// Parts can precede message metadata; bounded identity buffers bridge that ordering.
export const createManagedAssistantActivityRegistry = ({ now = Date.now } = {}) => {
  const watchers = new Map();
  const boundedSet = (map, key, value) => {
    map.set(key, value);
    if (map.size > 128) map.delete(map.keys().next().value);
  };
  return {
    subscribe(input, onActivity) {
      const entry = { input, onActivity, messages: new Map(), parts: new Map() };
      const entries = watchers.get(input.sessionId) ?? new Set();
      entries.add(entry);
      watchers.set(input.sessionId, entries);
      return () => {
        entries.delete(entry);
        if (entries.size === 0 && watchers.get(input.sessionId) === entries) watchers.delete(input.sessionId);
      };
    },
    observe(payload, directory = null) {
      if (payload?.type !== 'message.updated' && payload?.type !== 'message.part.updated'
        && payload?.type !== 'message.part.delta') return;
      const properties = payload.properties;
      const info = properties?.info;
      const part = properties?.part;
      const sessionId = properties?.sessionID ?? info?.sessionID ?? part?.sessionID;
      const entries = watchers.get(sessionId);
      if (!entries) return;
      const messageId = info?.id ?? part?.messageID ?? properties?.messageID;
      if (typeof messageId !== 'string' || messageId.length > 256) return;
      for (const entry of entries) {
        if (directory && entry.input.directory && directory !== entry.input.directory) continue;
        if (messageId === entry.input.excludedMessageId) continue;
        if (info) {
          if (info.role !== 'assistant' || !Number.isFinite(info.time?.created)
            || info.time.created < entry.input.after) continue;
          boundedSet(entry.messages, messageId, true);
        }
        if (isManagedAssistantActivityPart(part)
          || (payload.type === 'message.part.delta'
            && (properties.field === 'text' || properties.field === 'reasoning')
            && typeof properties.delta === 'string' && properties.delta.trim())) {
          if (!entry.parts.has(messageId)) boundedSet(entry.parts, messageId, now());
        }
        if (entry.messages.has(messageId) && entry.parts.has(messageId)) {
          entry.onActivity({ messageId, observedAt: entry.parts.get(messageId) });
        }
      }
    },
    clear() { watchers.clear(); },
  };
};
