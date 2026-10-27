/**
 * DevRyan names its host event types `devryan:*`. The UI opts in to them on
 * every stream; an older host, or a payload sent before the opt-in, still uses
 * the accepted `openchamber:*` alias, so incoming types are canonicalised here.
 */
export const DEVRYAN_EVENT_TYPE_PREFIX = 'devryan:';
export const LEGACY_EVENT_TYPE_PREFIX = 'openchamber:';
/** Query value that asks a stream for `devryan:*` event names. */
export const DEVRYAN_EVENT_DIALECT = 'devryan';

export const canonicalEventType = (type: string): string => (
  type.startsWith(LEGACY_EVENT_TYPE_PREFIX) ? `${DEVRYAN_EVENT_TYPE_PREFIX}${type.slice(LEGACY_EVENT_TYPE_PREFIX.length)}` : type
);
