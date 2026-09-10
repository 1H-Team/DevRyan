import { useEffect, useState } from 'react';

const WARNING_GRACE_MS = 3_000;

// The outage clock belongs to the connection store so navigating away and back
// cannot restart the grace period. Only the sidebar's presentation is delayed.
export const useBotConnectionWarning = (failureStartedAt: number | null): boolean => {
  const [visibleFor, setVisibleFor] = useState<number | null>(null);

  useEffect(() => {
    if (failureStartedAt === null) return;
    const remaining = Math.max(0, failureStartedAt + WARNING_GRACE_MS - Date.now());
    const timer = setTimeout(() => setVisibleFor(failureStartedAt), remaining);
    return () => clearTimeout(timer);
  }, [failureStartedAt]);

  return failureStartedAt !== null && (
    visibleFor === failureStartedAt || Date.now() - failureStartedAt >= WARNING_GRACE_MS
  );
};
