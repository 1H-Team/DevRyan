import React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { loadPlanView } from './planViewLoader';

export const LazyGitView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/GitView').then((module) => ({ default: module.GitView })),
);
export const LazyDiffView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/DiffView').then((module) => ({ default: module.DiffView })),
);
export const LazyFilesView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/FilesView').then((module) => ({ default: module.FilesView })),
);
export const LazyPlanView = /* @__PURE__ */ lazyWithChunkRecovery(loadPlanView);
export const LazySettingsView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/SettingsView').then((module) => ({ default: module.SettingsView })),
);
export const LazyManagedSettingsView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/ManagedSettingsView').then((module) => ({ default: module.ManagedSettingsView })),
);
export const LazyTerminalView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/TerminalView').then((module) => ({ default: module.TerminalView })),
);
export const LazyMultiRunWindow = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/MultiRunWindow').then((module) => ({ default: module.MultiRunWindow })),
);
export const LazyAgentManagerView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/agent-manager/AgentManagerView').then((module) => ({ default: module.AgentManagerView })),
);
export const LazyBotView = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/views/BotView').then((module) => ({ default: module.BotView })),
);
export const LazyBotsPage = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/sections/bots/BotsPage').then((module) => ({ default: module.BotsPage })),
);

export const LazyViewBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
  <ErrorBoundary>
    <React.Suspense fallback={null}>{children}</React.Suspense>
  </ErrorBoundary>
);

export const DeferredLazyView: React.FC<React.PropsWithChildren<{ active: boolean }>> = ({ active, children }) => {
  const hasActivated = React.useRef(active);
  if (active) {
    hasActivated.current = true;
  }

  if (!hasActivated.current) {
    return null;
  }

  return children;
};
