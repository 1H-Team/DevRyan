const BLOCKER_TYPE = 'prevent-display-sleep';

export const createKeepAwakeController = ({ powerSaveBlocker }) => {
  let blockerId = null;

  const hasActiveBlocker = () => (
    Number.isInteger(blockerId)
    && (typeof powerSaveBlocker.isStarted !== 'function' || powerSaveBlocker.isStarted(blockerId))
  );

  const release = () => {
    if (!Number.isInteger(blockerId)) {
      return;
    }
    const id = blockerId;
    blockerId = null;
    if (typeof powerSaveBlocker.isStarted === 'function' && !powerSaveBlocker.isStarted(id)) {
      return;
    }
    powerSaveBlocker.stop(id);
  };

  return {
    apply(enabled) {
      if (enabled) {
        if (!hasActiveBlocker()) {
          blockerId = powerSaveBlocker.start(BLOCKER_TYPE);
        }
        return { enabled: true, active: hasActiveBlocker() };
      }

      release();
      return { enabled: false, active: false };
    },

    stop() {
      release();
    },
  };
};
