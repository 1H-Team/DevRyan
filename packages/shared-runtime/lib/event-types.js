/** Canonical event identity for live events and pre-rename journal records. */
export const canonicalDevRyanEventType = type => typeof type === 'string' && type.startsWith('openchamber:')
  ? `devryan:${type.slice('openchamber:'.length)}` : type;
