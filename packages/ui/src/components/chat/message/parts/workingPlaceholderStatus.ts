export interface WorkingStatusLabel {
  text: string;
  permission: boolean;
  generic: boolean;
}

// Suppress random generic wording changes, but never preserve a finished tool
// (or permission wait) merely because the next authoritative state is generic.
export const shouldPreserveWorkingStatus = (
  displayed: WorkingStatusLabel,
  incoming: WorkingStatusLabel,
): boolean => (
  (displayed.text === incoming.text && displayed.permission === incoming.permission)
  || (displayed.generic && incoming.generic && !incoming.permission)
);
