export const resolveNotificationTemplatesFromSettingsSnapshot = <T>({
  baseline,
  current,
  incoming,
}: {
  baseline?: T;
  current: T;
  incoming: T;
}): T => {
  if (baseline !== undefined && current !== baseline) {
    return current;
  }
  return incoming;
};
