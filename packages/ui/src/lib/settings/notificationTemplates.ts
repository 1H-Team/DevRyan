export const NOTIFICATION_TEMPLATE_EVENTS = [
  'completion',
  'planReady',
  'error',
  'question',
  'permission',
  'subtask',
] as const;

export type NotificationTemplateEvent = typeof NOTIFICATION_TEMPLATE_EVENTS[number];
export type NotificationTemplate = { title: string; message: string };
export type NotificationTemplates = Record<NotificationTemplateEvent, NotificationTemplate>;

export const EMPTY_NOTIFICATION_TEMPLATES: NotificationTemplates = {
  completion: { title: '', message: '' },
  planReady: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  permission: { title: '', message: '' },
  subtask: { title: '', message: '' },
};

const isNotificationTemplate = (value: unknown): value is NotificationTemplate => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === 'string' && typeof candidate.message === 'string';
};

export const normalizeNotificationTemplates = (
  value: unknown,
  fallback: NotificationTemplates = EMPTY_NOTIFICATION_TEMPLATES,
): NotificationTemplates => {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  let complete = true;
  const normalized = {} as NotificationTemplates;

  for (const event of NOTIFICATION_TEMPLATE_EVENTS) {
    const entry = input[event];
    if (isNotificationTemplate(entry)) {
      normalized[event] = entry;
      continue;
    }
    complete = false;
    normalized[event] = fallback[event];
  }

  return complete ? value as NotificationTemplates : normalized;
};
