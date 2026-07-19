import React from 'react';

import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export const LazyGitHubIssuePickerDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/GitHubIssuePickerDialog').then((module) => ({ default: module.GitHubIssuePickerDialog })),
);
export const LazyGitHubPrPickerDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/session/GitHubPrPickerDialog').then((module) => ({ default: module.GitHubPrPickerDialog })),
);
export const LazyStashDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/git/StashDialog').then((module) => ({ default: module.StashDialog })),
);
export const LazyTimelineDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/chat/TimelineDialog').then((module) => ({ default: module.TimelineDialog })),
);
export const LazyAgentHandoffDialog = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/chat/AgentHandoffDialog').then((module) => ({ default: module.AgentHandoffDialog })),
);

export const DeferredChatDialog: React.FC<React.PropsWithChildren<{ active: boolean }>> = ({ active, children }) => {
  const hasActivated = React.useRef(active);
  if (active) {
    hasActivated.current = true;
  }

  if (!hasActivated.current) {
    return null;
  }

  return children;
};
