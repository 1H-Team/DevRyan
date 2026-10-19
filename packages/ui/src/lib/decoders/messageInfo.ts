import { isRecord } from './guards';

// Reads of transcript message `info` fields. The UI decorates info with
// client-only fields (`clientRole` for compaction boundaries), and history from
// older hosts may omit fields, so each read checks its type.

const field = (info: unknown, key: string): unknown => (isRecord(info) ? info[key] : undefined);

const nonBlank = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value : null
);

/** `clientRole` when present (the UI's rendering role), otherwise `role`; null when neither is a string. */
export const readMessageRole = (info: unknown): string | null => {
  const clientRole = field(info, 'clientRole');
  if (typeof clientRole === 'string') return clientRole;
  const role = field(info, 'role');
  return typeof role === 'string' ? role : null;
};

export const readMessageId = (info: unknown): string | null => nonBlank(field(info, 'id'));
export const readMessageParentId = (info: unknown): string | null => nonBlank(field(info, 'parentID'));
export const readMessageSessionId = (info: unknown): string | null => nonBlank(field(info, 'sessionID'));
export const readMessageClientRole = (info: unknown): string | null => {
  const clientRole = field(info, 'clientRole');
  return typeof clientRole === 'string' ? clientRole : null;
};

/** `time.created` when it is a finite number. */
export const readMessageCreatedAt = (info: unknown): number | null => {
  const time = field(info, 'time');
  const created = isRecord(time) ? time.created : undefined;
  return typeof created === 'number' && Number.isFinite(created) ? created : null;
};
