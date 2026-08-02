export type NotificationTemplateField = 'title' | 'message';

export type NotificationTemplateDraft = Record<NotificationTemplateField, string>;

type TimerHandle = ReturnType<typeof setTimeout>;

type NotificationTemplateDraftControllerOptions = {
  initial: NotificationTemplateDraft;
  commit: (field: NotificationTemplateField, value: string) => void;
  onDraftChange: (draft: NotificationTemplateDraft) => void;
  debounceMs?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
};

export type NotificationTemplateDraftController = {
  update: (field: NotificationTemplateField, value: string) => void;
  sync: (template: NotificationTemplateDraft) => void;
  flush: (field: NotificationTemplateField) => void;
  beginComposition: (field: NotificationTemplateField) => void;
  endComposition: (field: NotificationTemplateField, value: string) => void;
  dispose: () => void;
};

const TEMPLATE_FIELDS: NotificationTemplateField[] = ['title', 'message'];

export const createNotificationTemplateDraftController = ({
  initial,
  commit,
  onDraftChange,
  debounceMs = 300,
  scheduleTimeout = setTimeout,
  clearScheduledTimeout = clearTimeout,
}: NotificationTemplateDraftControllerOptions): NotificationTemplateDraftController => {
  let draft = { ...initial };
  const dirtyFields = new Set<NotificationTemplateField>();
  const composingFields = new Set<NotificationTemplateField>();
  const timers = new Map<NotificationTemplateField, TimerHandle>();

  const clearTimer = (field: NotificationTemplateField) => {
    const timer = timers.get(field);
    if (timer !== undefined) {
      clearScheduledTimeout(timer);
      timers.delete(field);
    }
  };

  const flush = (field: NotificationTemplateField) => {
    clearTimer(field);
    if (!dirtyFields.delete(field)) {
      return;
    }
    commit(field, draft[field]);
  };

  const schedule = (field: NotificationTemplateField) => {
    clearTimer(field);
    timers.set(field, scheduleTimeout(() => flush(field), debounceMs));
  };

  const update = (field: NotificationTemplateField, value: string) => {
    if (draft[field] !== value) {
      draft = { ...draft, [field]: value };
      onDraftChange(draft);
    }
    dirtyFields.add(field);
    if (!composingFields.has(field)) {
      schedule(field);
    }
  };

  const sync = (template: NotificationTemplateDraft) => {
    let next = draft;
    for (const field of TEMPLATE_FIELDS) {
      if (!dirtyFields.has(field) && next[field] !== template[field]) {
        next = { ...next, [field]: template[field] };
      }
    }
    if (next !== draft) {
      draft = next;
      onDraftChange(draft);
    }
  };

  return {
    update,
    sync,
    flush,
    beginComposition: (field) => {
      composingFields.add(field);
      clearTimer(field);
    },
    endComposition: (field, value) => {
      composingFields.delete(field);
      update(field, value);
    },
    dispose: () => {
      for (const field of TEMPLATE_FIELDS) {
        flush(field);
      }
    },
  };
};
