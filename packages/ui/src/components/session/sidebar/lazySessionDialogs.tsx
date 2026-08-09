import React from 'react';

import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export const LazyProjectEditDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/layout/ProjectEditDialog').then((module) => ({ default: module.ProjectEditDialog })),
);
export const LazyNewWorktreeDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/NewWorktreeDialog').then((module) => ({ default: module.NewWorktreeDialog })),
);
export const LazyScheduledTasksDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/ScheduledTasksDialog').then((module) => ({ default: module.ScheduledTasksDialog })),
);
export const LazySessionSearchDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/sidebar/SessionSearchDialog').then((module) => ({ default: module.SessionSearchDialog })),
);
export const LazySessionDeleteConfirmDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/sidebar/ConfirmDialogs').then((module) => ({ default: module.SessionDeleteConfirmDialog })),
);
export const LazyFolderDeleteConfirmDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/sidebar/ConfirmDialogs').then((module) => ({ default: module.FolderDeleteConfirmDialog })),
);
export const LazyBulkSessionDeleteConfirmDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/sidebar/ConfirmDialogs').then((module) => ({ default: module.BulkSessionDeleteConfirmDialog })),
);
export const LazyBranchSessionArchiveConfirmDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/sidebar/ConfirmDialogs').then((module) => ({ default: module.BranchSessionArchiveConfirmDialog })),
);

export const DeferredSessionDialog: React.FC<React.PropsWithChildren<{ active: boolean }>> = ({ active, children }) => {
  const hasActivated = React.useRef(active);
  if (active) {
    hasActivated.current = true;
  }

  if (!hasActivated.current) {
    return null;
  }

  return children;
};
