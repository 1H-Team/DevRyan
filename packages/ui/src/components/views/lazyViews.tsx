import React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { lazyWithChunkRecovery, retryableLazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { loadPlanView } from './planViewLoader';
import { loadManagedSettingsView, loadSettingsView } from './settingsViewLoader';

const SETTINGS_CHUNK_OPTIONS = { timeoutMs: 10_000 } as const;

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
export const LazySettingsView = /* @__PURE__ */ retryableLazyWithChunkRecovery(loadSettingsView, SETTINGS_CHUNK_OPTIONS);
export const LazyManagedSettingsView = /* @__PURE__ */ retryableLazyWithChunkRecovery(loadManagedSettingsView, SETTINGS_CHUNK_OPTIONS);
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
export const LazyBotOperationsRail = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/bots/operations/BotOperationsRail').then((module) => ({ default: module.BotOperationsRail })),
);
export const LazyBotSidebarSection = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('@/components/bots/sidebar/BotSidebarSection').then((module) => ({ default: module.BotSidebarSection })),
);
export const LazyViewBoundary: React.FC<React.PropsWithChildren<{ fallback?: React.ReactNode }>> = ({ children, fallback = null }) => (
  <ErrorBoundary>
    <React.Suspense fallback={fallback}>{children}</React.Suspense>
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
