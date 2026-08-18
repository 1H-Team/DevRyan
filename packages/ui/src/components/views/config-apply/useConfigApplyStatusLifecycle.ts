import * as React from 'react';

import {
  shouldPollConfigApplyStatus,
  useConfigApplyStore,
} from '@/stores/useConfigApplyStore';

export const useConfigApplyStatusLifecycle = (settingsVisible: boolean): void => {
  const status = useConfigApplyStore((state) => state.status);
  const refresh = useConfigApplyStore((state) => state.refresh);
  const isTransient = shouldPollConfigApplyStatus(status);
  const isActive = settingsVisible || isTransient;

  React.useEffect(() => {
    if (!isActive) return;

    void refresh();
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isActive, refresh]);

  React.useEffect(() => {
    if (!isTransient) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [isTransient, refresh]);
};
