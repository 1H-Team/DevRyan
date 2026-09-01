export const NOTIFICATION_TEMPLATE_EVENTS = Object.freeze([
  'completion',
  'planReady',
  'error',
  'question',
  'permission',
  'subtask',
]);

export const DEFAULT_NOTIFICATION_TEMPLATES = Object.freeze({
  completion: Object.freeze({ title: 'Session complete', message: '{session_name} is ready to review' }),
  planReady: Object.freeze({ title: 'Plan ready', message: 'A plan is ready for review' }),
  error: Object.freeze({ title: 'Tool error', message: '{last_message}' }),
  question: Object.freeze({ title: 'Input needed', message: '{last_message}' }),
  permission: Object.freeze({ title: 'Permissions needed', message: 'Folder access is required: {last_message}' }),
  subtask: Object.freeze({ title: '{agent_name} is ready', message: '{model_name} completed the task' }),
});

const LEGACY_COMPLETION_NOTIFICATION_TEMPLATES = [
  { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  { title: '{agent_name} is ready', message: '{last_message}' },
];

const isTemplate = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof value.title === 'string'
  && typeof value.message === 'string'
);

export const normalizeNotificationTemplates = (
  value,
  fallback = DEFAULT_NOTIFICATION_TEMPLATES,
) => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackInput = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
    ? fallback
    : DEFAULT_NOTIFICATION_TEMPLATES;
  const templates = {};
  let changed = false;

  for (const event of NOTIFICATION_TEMPLATE_EVENTS) {
    const entry = input[event];
    const inherited = isTemplate(fallbackInput[event])
      ? fallbackInput[event]
      : DEFAULT_NOTIFICATION_TEMPLATES[event];
    const isLegacyCompletion = event === 'completion'
      && LEGACY_COMPLETION_NOTIFICATION_TEMPLATES.some((legacy) => (
        entry?.title === legacy.title && entry?.message === legacy.message
      ));

    if (isTemplate(entry) && !isLegacyCompletion) {
      templates[event] = entry;
      continue;
    }

    templates[event] = inherited;
    changed = true;
  }

  return { templates, changed };
};
