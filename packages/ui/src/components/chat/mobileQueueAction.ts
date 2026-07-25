type PreventableEvent = {
  preventDefault: () => void;
};

type QueueActionLock = {
  current: boolean;
};

export const preserveComposerFocus = (event: PreventableEvent): void => {
  event.preventDefault();
};

export const runQueueActionOnce = async <T>(
  lock: QueueActionLock,
  action: () => Promise<T>,
): Promise<T | undefined> => {
  if (lock.current) {
    return undefined;
  }

  lock.current = true;
  try {
    return await action();
  } finally {
    lock.current = false;
  }
};
