import { getSafeStorage } from '@/stores/utils/safeStorage';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import type { GitIdentityProfile, CommitFileEntry, GitStatus, GitWorktreeBootstrapStatus } from '@/lib/api/types';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import { recordFileOpened } from '@/lib/interactionAnalytics';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useGitIdentity,
  useIsGitRepo,
  useGitLoadingStatus,
  useGitLoadingLog,
  useGitHistorySectionOpen,
} from '@/stores/useGitStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import {
  RiGitBranchLine,
  RiGitMergeLine,
  RiGitCommitLine,
  RiGitPullRequestLine,
  RiLoader4Line,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
// (dropdown menu used inside IntegrateCommitsSection)
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getSessionWorktreeRepairActions, getMutationBlockingReasons } from '@/sync/session-worktree-contract';
import {
  checkoutBranchWithOptionalStash,
  type BranchCheckoutResult,
  finishCurrentBranchIntoMainWithOptionalStash,
  formatMutationBlockingReason,
} from '@/lib/git/branchCheckout';
import { IntegrateCommitsSection } from './git/IntegrateCommitsSection';

import { GitHeader } from './git/GitHeader';
import { ChangesSection } from './git/ChangesSection';
import { CommitSection } from './git/CommitSection';
import { GitEmptyState } from './git/GitEmptyState';
import { HistorySection } from './git/HistorySection';
import { SyncActions } from './git/SyncActions';
import { PullRequestSection } from './git/PullRequestSection';
import { ConflictDialog } from './git/ConflictDialog';
import { StashDialog } from './git/StashDialog';
import { InProgressOperationBanner } from './git/InProgressOperationBanner';
import { BranchIntegrationSection, type OperationLogEntry } from './git/BranchIntegrationSection';
import type { GitPushSyncResult, GitRemote } from '@/lib/gitApi';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { cn } from '@/lib/utils';
import { assertGitSyncReady, generateCommitMessageDraft, syncGitBranchForPush } from '@/lib/gitApi';
import {
  getWorktreeBootstrapState,
  subscribeWorktreeBootstrap,
  waitForWorktreeBootstrap,
} from '@/lib/worktrees/worktreeBootstrap';
import { validateCommitMessage } from '@/lib/commitTemplate';
import { shouldAutoSelectGitChange } from '@/lib/git/commitWorkflowSafety';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';
import { isSourceUpdateTabHidden, useAuthPrincipal } from '@/lib/authSession';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { resolveIntegrateBranchChoices, splitVisibleGitBranches } from './git/gitBranchVisibility';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAmend' | 'commitAndPush' | 'commitAndSync' | null;
type BranchOperation = 'merge' | 'rebase' | null;
type ActionTab = 'commit' | 'branch' | 'pr';
type CommitScope = {
  kind: 'staged' | 'all';
  files: string[];
  stagedOnly: boolean;
};
type HistoryBranchDivider = {
  insertBeforeIndex: number;
  branchName: string;
  direction: 'up' | 'down';
} | null;

const GIT_ACTION_TAB_STORAGE_KEY = 'oc.git.actionTab';
const GIT_COMMIT_SPLIT_DEFAULT_RATIO = 0.5;
const GIT_COMMIT_SPLIT_MIN_RATIO = 0.2;
const GIT_COMMIT_SPLIT_MAX_RATIO = 0.8;
const GIT_COMMIT_SPLIT_KEYBOARD_STEP = 0.05;
const GIT_REMOTE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const GIT_REMOTE_REFRESH_STALE_MS = 5 * 60 * 1000;

const isActionTab = (value: unknown): value is ActionTab =>
  value === 'commit' || value === 'branch' || value === 'pr';

const clampGitCommitSplitRatio = (ratio: number) =>
  Math.min(GIT_COMMIT_SPLIT_MAX_RATIO, Math.max(GIT_COMMIT_SPLIT_MIN_RATIO, ratio));


type GitViewSnapshot = {
  directory?: string;
  selectedPaths: string[];
  commitMessage: string;
};

type GitmojiEntry = {
  emoji: string;
  code: string;
  description: string;
};

type GitmojiCachePayload = {
  gitmojis: GitmojiEntry[];
  fetchedAt: number;
  version: string;
};

const GITMOJI_CACHE_KEY = 'gitmojiCache';
const GITMOJI_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GITMOJI_CACHE_VERSION = '1';
const GIT_DIFF_PRIORITY_PREFETCH_LIMIT = 40;
const GIT_DIFF_PRIORITY_BASELINE_LIMIT = 20;
const GITMOJI_SOURCE_URL =
  'https://raw.githubusercontent.com/carloscuesta/gitmoji/master/packages/gitmojis/src/gitmojis.json';

const isGitmojiEntry = (value: unknown): value is GitmojiEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.emoji === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.description === 'string'
  );
};

const readGitmojiCache = (): GitmojiCachePayload | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = getSafeStorage().getItem(GITMOJI_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GitmojiCachePayload>;
    if (!parsed || parsed.version !== GITMOJI_CACHE_VERSION || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    if (!Array.isArray(parsed.gitmojis)) return null;
    const gitmojis = parsed.gitmojis.filter(isGitmojiEntry);
    return { gitmojis, fetchedAt: parsed.fetchedAt, version: parsed.version };
  } catch {
    return null;
  }
};

const writeGitmojiCache = (gitmojis: GitmojiEntry[]) => {
  if (typeof window === 'undefined') return;
  try {
    const payload: GitmojiCachePayload = {
      gitmojis,
      fetchedAt: Date.now(),
      version: GITMOJI_CACHE_VERSION,
    };
    getSafeStorage().setItem(GITMOJI_CACHE_KEY, JSON.stringify(payload));
  } catch {
    return;
  }
};

const isGitmojiCacheFresh = (payload: GitmojiCachePayload) =>
  Date.now() - payload.fetchedAt < GITMOJI_CACHE_TTL_MS;

const gitViewSnapshots = new Map<string, GitViewSnapshot>();

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

const resolveTrackingRemote = (tracking: string | null | undefined, remotes: GitRemote[]): GitRemote | null => {
  const trackingRemoteName = tracking?.split('/')[0];
  return remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0] ?? null;
};

const hasStagedGitChange = (file: { index?: string }) => {
  const index = file.index?.trim();
  return Boolean(index && index !== '?');
};

const hasUnstagedGitChange = (file: { index?: string; working_dir?: string }) => {
  const working = file.working_dir?.trim();
  const index = file.index?.trim();
  return Boolean((working && working !== ' ') || index === '?');
};

export const GitView: React.FC = () => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const principal = useAuthPrincipal();
  const canUseHostGitIdentity = principal.scope !== 'managed' || principal.role === 'admin';
  const canRenameBranch = principal.scope !== 'managed' || principal.role === 'admin';
  const canCreateBranches = principal.scope !== 'managed' || principal.policy.createBranches;
  const hideUpdateTab = isSourceUpdateTabHidden(principal);
  const currentDirectory = useEffectiveDirectory();
  const [worktreeBootstrapStatus, setWorktreeBootstrapStatus] = React.useState<GitWorktreeBootstrapStatus['status'] | null>(null);
  const [isWaitingForGitRefreshAfterBootstrap, setIsWaitingForGitRefreshAfterBootstrap] = React.useState(false);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
  const setDraftPreserveDirectoryOverride = useSessionUIStore((s) => s.setDraftPreserveDirectoryOverride);
  const setDraftBootstrapPendingDirectory = useSessionUIStore((s) => s.setDraftBootstrapPendingDirectory);
  const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
  const availableWorktrees = useSessionUIStore((s) => s.availableWorktrees);
  const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
  const projects = useProjectsStore((s) => s.projects);
  const setActiveProjectIdOnly = useProjectsStore((s) => s.setActiveProjectIdOnly);
  const normalizedCurrentDirectory = normalizePath(currentDirectory);
  const currentProject = React.useMemo(
    () => resolveProjectForSessionDirectory(projects, availableWorktreesByProject, currentDirectory ?? null),
    [availableWorktreesByProject, currentDirectory, projects],
  );
  const restrictToGrantedBranches = principal.scope === 'managed' && principal.role !== 'admin';
  const inferredWorktreeMetadata = React.useMemo(() => {
    if (!normalizedCurrentDirectory) {
      return undefined;
    }

    const fromAvailable = availableWorktrees.find(
      (metadata) => normalizePath(metadata.path) === normalizedCurrentDirectory
    );
    if (fromAvailable) {
      return fromAvailable;
    }

    for (const metadata of worktreeMap.values()) {
      if (normalizePath(metadata.path) === normalizedCurrentDirectory) {
        return metadata;
      }
    }

    return undefined;
  }, [availableWorktrees, normalizedCurrentDirectory, worktreeMap]);
  const storeWorktreeMetadata = React.useMemo(() => {
    if (currentSessionId) {
      return worktreeMap.get(currentSessionId) ?? inferredWorktreeMetadata;
    }

    if (newSessionDraft?.open) {
      return inferredWorktreeMetadata;
    }

    return undefined;
  }, [currentSessionId, inferredWorktreeMetadata, newSessionDraft?.open, worktreeMap]);

  const { profiles, globalIdentity, defaultGitIdentityId, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId } =
    useGitIdentitiesStore(useShallow((s) => ({
      profiles: s.profiles,
      globalIdentity: s.globalIdentity,
      defaultGitIdentityId: s.defaultGitIdentityId,
      loadProfiles: s.loadProfiles,
      loadGlobalIdentity: s.loadGlobalIdentity,
      loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    })));

  const isGitRepo = useIsGitRepo(currentDirectory ?? null);
  const status = useGitStatus(currentDirectory ?? null);

  // Authoritative session↔worktree attachment for repair action display
  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const repairActions = worktreeAttachment ? getSessionWorktreeRepairActions(worktreeAttachment) : [];

  // When an authoritative attachment exists, derive worktree-related fields from it
  // rather than from the live detected worktree metadata.
  const authoritativeProjectRoot = worktreeAttachment && !worktreeAttachment.degraded && !worktreeAttachment.legacy
    ? worktreeAttachment.worktreeRoot ?? undefined
    : undefined;

  const worktreeMetadata = useDetectedWorktreeMetadata(
    currentDirectory,
    storeWorktreeMetadata,
    status?.current ?? undefined,
    canUseHostGitIdentity,
  );
  const branches = useGitBranches(currentDirectory ?? null);
  const worktreeBranches = React.useMemo(() => {
    if (!currentProject) {
      return new Set<string>();
    }
    const projectPath = normalizePath(currentProject.path);
    const worktrees = availableWorktreesByProject.get(projectPath)
      ?? availableWorktreesByProject.get(currentProject.path)
      ?? [];
    return new Set(worktrees
      .filter((worktree) => normalizePath(worktree.path) !== normalizedCurrentDirectory)
      .map((worktree) => worktree.branch.trim().replace(/^refs\/heads\//, ''))
      .filter(Boolean));
  }, [availableWorktreesByProject, currentProject, normalizedCurrentDirectory]);
  const log = useGitLog(currentDirectory ?? null);
  const currentIdentity = useGitIdentity(currentDirectory ?? null);
  const isLoading = useGitLoadingStatus(currentDirectory ?? null);
  const isLogLoading = useGitLoadingLog(currentDirectory ?? null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const fetchAll = useGitStore((state) => state.fetchAll);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const fetchLog = useGitStore((state) => state.fetchLog);
  const fetchIdentity = useGitStore((state) => state.fetchIdentity);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const setLogMaxCount = useGitStore((state) => state.setLogMaxCount);
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextDiff = useUIStore((state) => state.openContextDiff);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);
  const setRightSidebarOpen = useUIStore((state) => state.setRightSidebarOpen);
  const previousBootstrapStatusRef = React.useRef<GitWorktreeBootstrapStatus['status'] | null>(null);
  const remoteRefreshTimestampsRef = React.useRef<Map<string, number>>(new Map());
  const isWorktreeBootstrapReady = worktreeBootstrapStatus === 'ready'
    || worktreeBootstrapStatus === 'ready_with_warnings'
    || worktreeBootstrapStatus === 'not_applicable';

  React.useEffect(() => {
    if (!currentDirectory) {
      setWorktreeBootstrapStatus(null);
      setIsWaitingForGitRefreshAfterBootstrap(false);
      return;
    }

    const update = () => {
      setWorktreeBootstrapStatus(getWorktreeBootstrapState(currentDirectory)?.status ?? null);
    };
    update();
    const unsubscribe = subscribeWorktreeBootstrap(currentDirectory, update);
    void waitForWorktreeBootstrap(currentDirectory).catch(update);
    return unsubscribe;
  }, [currentDirectory]);

  React.useEffect(() => {
    const previous = previousBootstrapStatusRef.current;
    previousBootstrapStatusRef.current = worktreeBootstrapStatus;

    if (!currentDirectory || !git) {
      return;
    }

    const wasPending = previous === 'queued' || previous === 'running';
    if (wasPending && isWorktreeBootstrapReady) {
      setIsWaitingForGitRefreshAfterBootstrap(true);
      void fetchAll(currentDirectory, git, { includeIdentity: canUseHostGitIdentity }).finally(() => {
        window.setTimeout(() => {
          setIsWaitingForGitRefreshAfterBootstrap(false);
        }, 1200);
      });
    }

    if (worktreeBootstrapStatus === 'failed' || worktreeBootstrapStatus === 'needs_attention') {
      setDraftBootstrapPendingDirectory(null);
      setIsWaitingForGitRefreshAfterBootstrap(false);
    }
  }, [canUseHostGitIdentity, currentDirectory, fetchAll, git, isWorktreeBootstrapReady, setDraftBootstrapPendingDirectory, worktreeBootstrapStatus]);

  const normalizedDraftBootstrapPendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
  const isDraftBootstrapPendingForCurrentDirectory = Boolean(
    currentDirectory && normalizedDraftBootstrapPendingDirectory && normalizedDraftBootstrapPendingDirectory === normalizePath(currentDirectory)
  );
  const isPendingWorktreeSetup = Boolean(
    currentDirectory && (
      worktreeBootstrapStatus === null
      || worktreeBootstrapStatus === 'queued'
      || worktreeBootstrapStatus === 'running'
      || isDraftBootstrapPendingForCurrentDirectory
    )
  );
  const shouldHideNotGitState = isPendingWorktreeSetup || isWaitingForGitRefreshAfterBootstrap;

  const initialSnapshot = React.useMemo(() => {
    if (!currentDirectory) return null;
    return gitViewSnapshots.get(currentDirectory) ?? null;
  }, [currentDirectory]);

  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);

  React.useEffect(() => {
    const projectRoot = authoritativeProjectRoot || worktreeMetadata?.projectDirectory;
    if (!projectRoot) {
      setRootBranchHint(null);
      return;
    }

    let cancelled = false;
    void getRootBranch(projectRoot)
      .then((branch) => {
        if (cancelled) return;
        const normalized = branch.trim();
        setRootBranchHint(normalized && normalized !== 'HEAD' ? normalized : null);
      })
      .catch(() => {
        if (!cancelled) {
          setRootBranchHint(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authoritativeProjectRoot, worktreeMetadata?.projectDirectory]);

  const [commitMessage, setCommitMessage] = React.useState(
    initialSnapshot?.commitMessage ?? ''
  );
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [isGitmojiPickerOpen, setIsGitmojiPickerOpen] = React.useState(false);
  const actionPanelScrollRef = React.useRef<HTMLElement | null>(null);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [isGeneratingCommitMessage, setIsGeneratingCommitMessage] = React.useState(false);
  const [isRefreshingHistoryControls, setIsRefreshingHistoryControls] = React.useState(false);
  const [logMaxCountLocal, setLogMaxCountLocal] = React.useState<number>(25);
  const [isSettingIdentity, setIsSettingIdentity] = React.useState(false);
  const { triggerFireworks } = useFireworksCelebration();

  const autoAppliedDefaultRef = React.useRef<Map<string, string>>(new Map());
  const commitGenerationRequestRef = React.useRef(0);
  const identityApplyCountRef = React.useRef(0);

  const beginIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current += 1;
    setIsSettingIdentity(true);
  }, []);

  const endIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current = Math.max(0, identityApplyCountRef.current - 1);
    if (identityApplyCountRef.current === 0) {
      setIsSettingIdentity(false);
    }
  }, []);

  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(
    () => new Set(initialSnapshot?.selectedPaths ?? [])
  );
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [stagingPaths, setStagingPaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [integrateRefreshKey, setIntegrateRefreshKey] = React.useState(0);
  const scrollActionPanelToBottom = React.useCallback(() => {
    const scrollTarget = actionPanelScrollRef.current;
    if (!scrollTarget) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
      });
    });
  }, []);

  const repoRootForIntegrate = authoritativeProjectRoot || worktreeMetadata?.projectDirectory || null;
  const sourceBranchForIntegrate = status?.current || null;
  const shouldShowIntegrateCommits = React.useMemo(() => {
    // For PR worktrees from forks we set upstream to a non-origin remote (e.g. pr-<owner>-<repo>).
    // Re-integrate commits is intended for local scratch branches -> base branch, not fork PR branches.
    const tracking = status?.tracking;
    if (!tracking) return true;
    return tracking.startsWith('origin/');
  }, [status?.tracking]);
  const defaultTargetBranch = React.useMemo(() => {
    const fromMeta = worktreeMetadata?.createdFromBranch;
    const normalizedFromMeta = typeof fromMeta === 'string' ? fromMeta.trim() : '';
    const current = typeof status?.current === 'string' ? status.current.trim() : '';
    const normalizedRoot = typeof rootBranchHint === 'string' ? rootBranchHint.trim() : '';

    if (normalizedFromMeta) {
      const looksLikeCorruptedSelfTarget =
        normalizedFromMeta === current &&
        normalizedFromMeta.startsWith('opencode/') &&
        normalizedRoot.length > 0 &&
        normalizedRoot !== normalizedFromMeta;

      if (looksLikeCorruptedSelfTarget) {
        return normalizedRoot;
      }

      return normalizedFromMeta;
    }
    if (normalizedRoot) {
      return normalizedRoot;
    }
    if (current) {
      return current;
    }
    return 'HEAD';
  }, [worktreeMetadata?.createdFromBranch, status, rootBranchHint]);
  const [expandedCommitHashes, setExpandedCommitHashes] = React.useState<Set<string>>(new Set());
  const [commitFilesMap, setCommitFilesMap] = React.useState<Map<string, CommitFileEntry[]>>(new Map());
  const [loadingCommitHashes, setLoadingCommitHashes] = React.useState<Set<string>>(new Set());
  const [historyBranchDivider, setHistoryBranchDivider] = React.useState<HistoryBranchDivider>(null);
  const [isStagedChangesSectionOpen, setIsStagedChangesSectionOpen] = React.useState(true);
  const [isChangesSectionOpen, setIsChangesSectionOpen] = React.useState(true);
  // Kept local by design: the plan calls for a simple per-mount preference, not persisted per directory.
  const [gitCommitSplitRatio, setGitCommitSplitRatio] = React.useState(GIT_COMMIT_SPLIT_DEFAULT_RATIO);
  const gitCommitSplitContainerRef = React.useRef<HTMLDivElement | null>(null);
  const gitCommitSplitDragRef = React.useRef<{ containerTop: number; containerHeight: number } | null>(null);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [gitmojiEmojis, setGitmojiEmojis] = React.useState<GitmojiEntry[]>([]);
  const [gitmojiSearch, setGitmojiSearch] = React.useState('');

  const actionTabItems = React.useMemo(() => [
    { id: 'commit', label: t('gitView.tabs.commit'), icon: <RiGitCommitLine className="h-3 w-3" /> },
    ...(!hideUpdateTab ? [{ id: 'branch', label: t('gitView.tabs.update'), icon: <RiGitMergeLine className="h-3 w-3" /> }] : []),
    { id: 'pr', label: t('gitView.tabs.pr'), icon: <RiGitPullRequestLine className="h-3 w-3" /> },
  ], [hideUpdateTab, t]);
  const [actionTab, setActionTab] = React.useState<ActionTab>(() => {
    if (typeof window === 'undefined') {
      return 'commit';
    }
    const stored = getSafeStorage().getItem(GIT_ACTION_TAB_STORAGE_KEY);
    if (!hideUpdateTab && stored === 'worktree') {
      return 'branch';
    }
    if (hideUpdateTab && stored === 'branch') return 'commit';
    return isActionTab(stored) ? stored : 'commit';
  });
  const visibleActionTab = hideUpdateTab && actionTab === 'branch' ? 'commit' : actionTab;
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const setHistorySectionOpen = useGitStore((state) => state.setHistorySectionOpen);
  const isHistorySectionOpen = useGitHistorySectionOpen(currentDirectory ?? null);
  const canResizeGitCommitSections = isChangesSectionOpen && isHistorySectionOpen;
  const updateGitCommitSplitRatio = React.useCallback((nextRatio: number) => {
    setGitCommitSplitRatio(clampGitCommitSplitRatio(nextRatio));
  }, []);
  const handleGitCommitSplitPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!canResizeGitCommitSections) {
      return;
    }

    const container = gitCommitSplitContainerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) {
      return;
    }

    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture?.(pointerId);
    gitCommitSplitDragRef.current = {
      containerTop: rect.top,
      containerHeight: rect.height,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = gitCommitSplitDragRef.current;
      if (!drag) {
        return;
      }
      updateGitCommitSplitRatio((moveEvent.clientY - drag.containerTop) / drag.containerHeight);
    };

    const stopDragging = () => {
      gitCommitSplitDragRef.current = null;
      target.releasePointerCapture?.(pointerId);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', stopDragging);
      document.removeEventListener('pointercancel', stopDragging);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
  }, [canResizeGitCommitSections, updateGitCommitSplitRatio]);
  const handleGitCommitSplitKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canResizeGitCommitSections) {
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateGitCommitSplitRatio(gitCommitSplitRatio - GIT_COMMIT_SPLIT_KEYBOARD_STEP);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateGitCommitSplitRatio(gitCommitSplitRatio + GIT_COMMIT_SPLIT_KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      updateGitCommitSplitRatio(GIT_COMMIT_SPLIT_MIN_RATIO);
    } else if (event.key === 'End') {
      event.preventDefault();
      updateGitCommitSplitRatio(GIT_COMMIT_SPLIT_MAX_RATIO);
    }
  }, [canResizeGitCommitSections, gitCommitSplitRatio, updateGitCommitSplitRatio]);
  const [branchOperation, setBranchOperation] = React.useState<BranchOperation>(null);
  const [operationLogs, setOperationLogs] = React.useState<OperationLogEntry[]>([]);
  const [conflictDialogOpen, setConflictDialogOpen] = React.useState(false);
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([]);
  const [conflictOperation, setConflictOperation] = React.useState<'merge' | 'rebase'>('merge');

  // Conflict state persistence key
  const conflictStorageKey = React.useMemo(() => {
    if (!currentSessionId) return null;
    return `openchamber.conflict:${currentSessionId}`;
  }, [currentSessionId]);

  // Save conflict state to localStorage
  const persistConflictState = React.useCallback((
    directory: string,
    files: string[],
    operation: 'merge' | 'rebase'
  ) => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    const payload = { directory, conflictFiles: files, operation };
    getSafeStorage().setItem(conflictStorageKey, JSON.stringify(payload));
  }, [conflictStorageKey]);

  // Clear conflict state from localStorage
  const clearConflictState = React.useCallback(() => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    getSafeStorage().removeItem(conflictStorageKey);
  }, [conflictStorageKey]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    getSafeStorage().setItem(GIT_ACTION_TAB_STORAGE_KEY, actionTab);
  }, [actionTab]);

  // Restore conflict state from localStorage on mount
  React.useEffect(() => {
    if (!conflictStorageKey || typeof window === 'undefined' || !currentDirectory) return;

    const raw = getSafeStorage().getItem(conflictStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        directory: string;
        conflictFiles: string[];
        operation: 'merge' | 'rebase';
      };

      // Validate the stored state matches current directory
      if (parsed.directory !== currentDirectory) {
        getSafeStorage().removeItem(conflictStorageKey);
        return;
      }

      // Restore conflict state
      setConflictFiles(parsed.conflictFiles ?? []);
      setConflictOperation(parsed.operation ?? 'merge');
      setConflictDialogOpen(true);
    } catch {
      getSafeStorage().removeItem(conflictStorageKey);
    }
  }, [conflictStorageKey, currentDirectory]);
  const [stashDialogOpen, setStashDialogOpen] = React.useState(false);
  const [stashDialogOperation, setStashDialogOperation] = React.useState<'merge' | 'rebase' | 'checkout'>('merge');
  const [stashDialogBranch, setStashDialogBranch] = React.useState('');

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success(t('gitView.toast.commitHashCopied'));
        return;
      }
      toast.error(t('gitView.toast.copyFailed'));
    });
  }, [t]);

  const handleToggleCommit = React.useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!currentDirectory || !git) return;

    // Find hashes that are expanded but not yet loaded or loading
    const hashesToLoad = Array.from(expandedCommitHashes).filter(
      (hash) => !commitFilesMap.has(hash) && !loadingCommitHashes.has(hash)
    );

    if (hashesToLoad.length === 0) return;

    setLoadingCommitHashes((prev) => {
      const next = new Set(prev);
      for (const hash of hashesToLoad) {
        next.add(hash);
      }
      return next;
    });

    for (const hash of hashesToLoad) {
      git
        .getCommitFiles(currentDirectory, hash)
        .then((response) => {
          setCommitFilesMap((prev) => new Map(prev).set(hash, response.files));
        })
        .catch((error) => {
          console.error('Failed to fetch commit files:', error);
          setCommitFilesMap((prev) => new Map(prev).set(hash, []));
        })
        .finally(() => {
          setLoadingCommitHashes((prev) => {
            const next = new Set(prev);
            next.delete(hash);
            return next;
          });
        });
    }
  }, [expandedCommitHashes, currentDirectory, git, commitFilesMap, loadingCommitHashes]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    gitViewSnapshots.set(currentDirectory, {
      directory: currentDirectory,
      selectedPaths: Array.from(selectedPaths),
      commitMessage,
    });
  }, [commitMessage, currentDirectory, selectedPaths]);

  React.useEffect(() => {
    if (!canUseHostGitIdentity) return;
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [canUseHostGitIdentity, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  React.useEffect(() => {
    if (!currentDirectory || !git?.getRemoteUrl) {
      setRemoteUrl(null);
      return;
    }
    git.getRemoteUrl(currentDirectory).then(setRemoteUrl).catch(() => setRemoteUrl(null));
  }, [currentDirectory, git]);

  const refreshRemotes = React.useCallback(async () => {
    if (!currentDirectory || !git?.getRemotes) {
      setRemotes([]);
      return;
    }
    try {
      const remoteList = await git.getRemotes(currentDirectory);
      setRemotes(remoteList);
    } catch {
      setRemotes([]);
    }
  }, [currentDirectory, git]);

  React.useEffect(() => {
    void refreshRemotes();
  }, [refreshRemotes]);

  React.useEffect(() => {
    if (!settingsGitmojiEnabled) {
      setGitmojiEmojis([]);
      return;
    }

    let cancelled = false;

    const cached = readGitmojiCache();
    if (cached) {
      setGitmojiEmojis(cached.gitmojis);
      if (isGitmojiCacheFresh(cached)) {
        return () => {
          cancelled = true;
        };
      }
    }

    const loadGitmojis = async () => {
      try {
        const response = await fetch(GITMOJI_SOURCE_URL);
        if (!response.ok) {
          throw new Error(`Failed to load gitmojis: ${response.statusText}`);
        }
        const payload = (await response.json()) as { gitmojis?: GitmojiEntry[] };
        const gitmojis = Array.isArray(payload.gitmojis) ? payload.gitmojis.filter(isGitmojiEntry) : [];
        if (!cancelled) {
          setGitmojiEmojis(gitmojis);
          writeGitmojiCache(gitmojis);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load gitmoji list:', error);
        }
      }
    };

    void loadGitmojis();

    return () => {
      cancelled = true;
    };
  }, [settingsGitmojiEnabled]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    setActiveDirectory(currentDirectory);
    if (!isWorktreeBootstrapReady) return;
    void ensureAll(currentDirectory, git, { includeIdentity: canUseHostGitIdentity });
  }, [canUseHostGitIdentity, currentDirectory, setActiveDirectory, ensureAll, git, isWorktreeBootstrapReady]);

  React.useEffect(() => {
    if (!currentDirectory || !isWorktreeBootstrapReady) {
      return;
    }

    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) {
        return;
      }
      void fetchStatus(currentDirectory, git);
    });
  }, [currentDirectory, fetchStatus, git, isWorktreeBootstrapReady]);

  const refreshStatusAndBranches = React.useCallback(
    async (showErrors = true) => {
      if (!currentDirectory) return;

      try {
        await Promise.all([
          fetchStatus(currentDirectory, git, { force: true }),
          fetchBranches(currentDirectory, git),
        ]);
      } catch (err) {
        if (showErrors) {
          const message =
            err instanceof Error ? err.message : t('gitView.toast.refreshRepositoryFailed');
          toast.error(message);
        }
      }
    },
    [currentDirectory, git, fetchStatus, fetchBranches, t]
  );

  const refreshLog = React.useCallback(async () => {
    if (!currentDirectory) return;
    await fetchLog(currentDirectory, git, logMaxCountLocal);
  }, [currentDirectory, git, fetchLog, logMaxCountLocal]);

  const refreshAfterRemoteMutation = React.useCallback(async () => {
    if (!currentDirectory) return;

    await Promise.all([
      fetchStatus(currentDirectory, git, { force: true }),
      fetchBranches(currentDirectory, git),
      fetchLog(currentDirectory, git, logMaxCountLocal),
      refreshRemotes(),
    ]);
  }, [currentDirectory, fetchBranches, fetchLog, fetchStatus, git, logMaxCountLocal, refreshRemotes]);

  const refreshIdentity = React.useCallback(async () => {
    if (!canUseHostGitIdentity || !currentDirectory) return;
    await fetchIdentity(currentDirectory, git);
  }, [canUseHostGitIdentity, currentDirectory, git, fetchIdentity]);

  React.useEffect(() => {
    if (!canUseHostGitIdentity) return;
    if (!currentDirectory) return;
    if (!git?.hasLocalIdentity) return;
    if (isGitRepo !== true) return;

    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (!defaultId || defaultId === 'global') return;

    const previousAttempt = autoAppliedDefaultRef.current.get(currentDirectory);
    if (previousAttempt === defaultId) return;

    let cancelled = false;

    const run = async () => {
      try {
        const hasLocal = await git.hasLocalIdentity?.(currentDirectory);
        if (cancelled) return;
        if (hasLocal === true) return;

        beginIdentityApply();
        await git.setGitIdentity(currentDirectory, defaultId);
        autoAppliedDefaultRef.current.set(currentDirectory, defaultId);
        await refreshIdentity();
      } catch (error) {
        console.warn('Failed to auto-apply default git identity:', error);
      } finally {
        if (!cancelled) {
          endIdentityApply();
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [beginIdentityApply, canUseHostGitIdentity, currentDirectory, defaultGitIdentityId, endIdentityApply, git, isGitRepo, refreshIdentity]);

  const changeEntries = React.useMemo(() => {
    if (!status) return [];
    const files = status.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();

    for (const file of files) {
      unique.set(file.path, file);
    }

    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  const stagedEntries = React.useMemo(
    () => changeEntries.filter(hasStagedGitChange),
    [changeEntries]
  );
  const unstagedEntries = React.useMemo(
    () => changeEntries.filter(hasUnstagedGitChange),
    [changeEntries]
  );
  const commitScope = React.useMemo<CommitScope>(() => {
    if (stagedEntries.length > 0) {
      return {
        kind: 'staged',
        files: stagedEntries.map((entry) => entry.path),
        stagedOnly: true,
      };
    }

    return {
      kind: 'all',
      files: changeEntries.map((entry) => entry.path),
      stagedOnly: false,
    };
  }, [changeEntries, stagedEntries]);
  const commitGenerationScopeKey = React.useMemo(
    () => [
      currentDirectory ?? '',
      commitScope.stagedOnly ? 'staged' : 'all',
      ...commitScope.files,
    ].join('\0'),
    [commitScope.files, commitScope.stagedOnly, currentDirectory]
  );
  const latestCommitGenerationScopeKeyRef = React.useRef(commitGenerationScopeKey);
  latestCommitGenerationScopeKeyRef.current = commitGenerationScopeKey;

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) {
      return;
    }

    const orderedPaths: string[] = [];
    const seen = new Set<string>();

    const pushPath = (path: string) => {
      if (!path || seen.has(path)) {
        return;
      }
      seen.add(path);
      orderedPaths.push(path);
    };

    Array.from(selectedPaths).forEach(pushPath);
    visibleChangePaths.forEach(pushPath);
    unstagedEntries.slice(0, GIT_DIFF_PRIORITY_BASELINE_LIMIT).forEach((entry) => pushPath(entry.path));
    stagedEntries.slice(0, GIT_DIFF_PRIORITY_BASELINE_LIMIT).forEach((entry) => pushPath(entry.path));

    if (orderedPaths.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: GIT_DIFF_PRIORITY_PREFETCH_LIMIT });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [changeEntries.length, currentDirectory, git, prefetchDiffs, selectedPaths, stagedEntries, unstagedEntries, visibleChangePaths]);


  React.useEffect(() => {
    if (!status || stagedEntries.length === 0) {
      setSelectedPaths(new Set());
      return;
    }

    setSelectedPaths(() => {
      const next = new Set<string>();

      for (const file of stagedEntries) {
        if (shouldAutoSelectGitChange(file)) {
          next.add(file.path);
        }
      }

      return next;
    });
  }, [status, stagedEntries]);

  const showPushSyncToast = React.useCallback((result: GitPushSyncResult) => {
    if (result.pulledFileCount > 0 && result.pushedChanges) {
      toast.success(
        result.pulledFileCount === 1
          ? t('gitView.toast.syncedPulledSingleAndPushed', { count: result.pulledFileCount, name: result.remote })
          : t('gitView.toast.syncedPulledPluralAndPushed', { count: result.pulledFileCount, name: result.remote })
      );
    } else if (result.pulledFileCount > 0) {
      toast.success(
        result.pulledFileCount === 1
          ? t('gitView.toast.pulledFilesSingle', { count: result.pulledFileCount, name: result.remote })
          : t('gitView.toast.pulledFilesPlural', { count: result.pulledFileCount, name: result.remote })
      );
    } else if (result.pushedChanges) {
      toast.success(t('gitView.toast.pushedToUpstream'));
    } else {
      toast.success(t('gitView.toast.alreadyUpToDate'));
    }
  }, [t]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    setSyncAction(action);

    try {
      const getPullOptions = (pullRemote: GitRemote, pullStatus: GitStatus | null | undefined = status) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = pullStatus?.tracking?.startsWith(trackingPrefix)
          ? pullStatus.tracking.slice(trackingPrefix.length)
          : undefined;
        const currentBranchName = pullStatus?.current && pullStatus.current !== 'HEAD'
          ? pullStatus.current
          : undefined;
        const shouldRebasePull = (pullStatus?.ahead ?? 0) > 0;
        return {
          remote: pullRemote.name,
          branch: trackedBranch || currentBranchName,
          rebase: shouldRebasePull || undefined,
        };
      };

      if (action === 'fetch') {
        if (!remote) {
          throw new Error('No remote available for fetch');
        }
        await git.gitFetch(currentDirectory, { remote: remote.name });
        toast.success(t('gitView.toast.fetchedFromRemote', { name: remote.name }));
      } else if (action === 'pull') {
        if (!remote) {
          throw new Error('No remote available for pull');
        }
        const result = await git.gitPull(currentDirectory, getPullOptions(remote));
        if (result.conflict) {
          const files = result.conflictFiles ?? [];
          setConflictFiles(files);
          setConflictOperation(getPullOptions(remote).rebase ? 'rebase' : 'merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, files, getPullOptions(remote).rebase ? 'rebase' : 'merge');
          await refreshStatusAndBranches(false);
          await refreshLog();
          return;
        }
        toast.success(
          result.files.length === 1
            ? t('gitView.toast.pulledFilesSingle', { count: result.files.length, name: remote.name })
            : t('gitView.toast.pulledFilesPlural', { count: result.files.length, name: remote.name })
        );
      } else if (action === 'push') {
        const result = await syncGitBranchForPush(currentDirectory);
        showPushSyncToast(result);
      } else if (action === 'sync') {
        if (!remote) {
          throw new Error('No remote available for sync');
        }
        const result = await syncGitBranchForPush(currentDirectory, {
          remote: remote.name,
          rebase: getPullOptions(remote).rebase,
        });
        showPushSyncToast(result);
      }

      if (action === 'push' || action === 'sync') {
        await refreshAfterRemoteMutation();
        setIntegrateRefreshKey((value) => value + 1);
      } else {
        await refreshStatusAndBranches(false);
        await refreshLog();
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('gitView.toast.syncActionFailed', { action: action === 'sync' ? t('gitView.sync.syncChanges') : action === 'pull' ? t('gitView.sync.pull') : action });
      toast.error(message);
    } finally {
      await refreshStatusAndBranches(false);
      setSyncAction(null);
    }
  };

  const handleGenerateCommitMessage = React.useCallback(async () => {
    if (!currentDirectory || isGeneratingCommitMessage || commitAction !== null) {
      return;
    }
    if (commitScope.files.length === 0) {
      toast.error(t('gitView.toast.selectFileToCommit'));
      return;
    }

    const requestId = commitGenerationRequestRef.current + 1;
    commitGenerationRequestRef.current = requestId;
    const scopeKey = commitGenerationScopeKey;
    const commitMessageGuidance = commitMessage.trim();
    const isCurrentRequest = () =>
      commitGenerationRequestRef.current === requestId &&
      latestCommitGenerationScopeKeyRef.current === scopeKey;

    setIsGeneratingCommitMessage(true);
    try {
      const result = await generateCommitMessageDraft(currentDirectory, commitScope.files, {
        stagedOnly: commitScope.stagedOnly,
        commitMessageGuidance,
      });

      if (!isCurrentRequest()) {
        return;
      }

      if (result.status === 'blocked') {
        toast.error(t('gitView.toast.generateCommitWorkflowBlocked'), { description: result.message });
        return;
      }

      const generatedSubject = result.commits[0]?.subject.trim() ?? '';
      if (!generatedSubject) {
        toast.error(
          t('gitView.toast.generateCommitMessageFailed'),
          result.message ? { description: result.message } : undefined,
        );
        return;
      }

      const generatedDetails = (result.commits[0]?.highlights ?? [])
        .map((detail) => detail.trim())
        .filter(Boolean)
        .slice(0, 4);
      setCommitMessage([
        generatedSubject,
        ...(generatedDetails.length > 0
          ? ['', ...generatedDetails.map((detail) => `- ${detail}`)]
          : []),
      ].join('\n'));
      const warning = result.warnings?.find((value) => typeof value === 'string' && value.trim());
      if (warning) {
        toast.warning(t('gitView.toast.generateCommitMessageFallback'), { description: warning });
      }
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      const description = error instanceof Error ? error.message : undefined;
      toast.error(
        t('gitView.toast.generateCommitMessageFailed'),
        description ? { description } : undefined,
      );
    } finally {
      if (commitGenerationRequestRef.current === requestId) {
        setIsGeneratingCommitMessage(false);
      }
    }
  }, [
    commitAction,
    commitGenerationScopeKey,
    commitMessage,
    commitScope.files,
    commitScope.stagedOnly,
    currentDirectory,
    isGeneratingCommitMessage,
    t,
  ]);

  const handleRefreshHistoryControls = async () => {
    setIsRefreshingHistoryControls(true);
    try {
      if (currentDirectory) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const trackingRemote = effectiveRemotes.find((remote) => remote.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (trackingRemote) {
          await git.gitFetch(currentDirectory, { remote: trackingRemote.name });
        }
      }
      await refreshStatusAndBranches(false);
      await refreshLog();
      await refreshRemotes();
    } finally {
      setIsRefreshingHistoryControls(false);
    }
  };

  const handleCommit = async (options: { amend?: boolean; pushAfter?: boolean; syncAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (commitScope.files.length === 0) {
      toast.error(t('gitView.toast.selectFileToCommit'));
      return;
    }

    if (options.pushAfter || options.syncAfter) {
      try {
        assertGitSyncReady(await git.getGitStatus(currentDirectory));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Git operation needs attention');
        await refreshStatusAndBranches();
        return;
      }
    }

    // Strip template comments first; then preflight against the same rules
    // the commit-msg hook enforces. Catches mistakes inline so the user
    // doesn't see a generic "git commit failed" toast from a hook rejection.
    const validation = validateCommitMessage(commitMessage);
    const message = validation.cleaned;
    if (!validation.valid) {
      toast.error(validation.errors.join(' • '));
      return;
    }
    if (!message) {
      toast.error(t('gitView.toast.selectFileToCommit'));
      return;
    }

    const action: CommitAction = options.amend
      ? 'commitAmend'
      : options.syncAfter
        ? 'commitAndSync'
        : options.pushAfter
          ? 'commitAndPush'
          : 'commit';
    setCommitAction(action);

    try {
      await git.createGitCommit(currentDirectory, message, {
        files: commitScope.files,
        amend: options.amend,
        stagedOnly: commitScope.stagedOnly,
      });
      toast.success(t('gitView.toast.commitCreated'));
      setCommitMessage('');
      setSelectedPaths(new Set());

      await refreshStatusAndBranches();

      if (options.pushAfter) {
        setSyncAction('push');
        const result = await syncGitBranchForPush(currentDirectory);
        showPushSyncToast(result);
        triggerFireworks();
        await refreshAfterRemoteMutation();
      } else if (options.syncAfter) {
        setSyncAction('sync');
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const syncRemote = effectiveRemotes.find((remote) => remote.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!syncRemote) {
          throw new Error('No remote available for sync');
        }
        const result = await syncGitBranchForPush(currentDirectory, {
          remote: syncRemote.name,
          rebase: true,
        });
        showPushSyncToast(result);

        triggerFireworks();
        await refreshAfterRemoteMutation();
      } else {
        await refreshStatusAndBranches(false);
        await refreshLog();
      }

      setIntegrateRefreshKey((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.createCommitFailed');
      toast.error(message);
    } finally {
      setCommitAction(null);
      if (options.pushAfter || options.syncAfter) {
        setSyncAction(null);
      }
    }
  };

  const handleCreateBranch = async (branchName: string, remote?: GitRemote) => {
    if (!currentDirectory || !status) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment, status ?? undefined);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotCreateBranch', { reason: formatMutationBlockingReason(blockingReasons[0]) }));
      return;
    }

    const checkoutBase = status.current ?? null;
    const remoteName = remote?.name ?? 'origin';

    try {
      await git.createBranch(currentDirectory, branchName, checkoutBase ?? 'HEAD');
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));

      // Checkout the new branch and stay on it
      await git.checkoutBranch(currentDirectory, branchName);

      let pushSucceeded = false;
      try {
        await git.gitPush(currentDirectory, {
          remote: remoteName,
          branch: branchName,
          options: ['--set-upstream'],
        });
        pushSucceeded = true;
      } catch (pushError) {
        const message =
          pushError instanceof Error
            ? pushError.message
            : `Unable to push new branch to ${remoteName}.`;
        toast.warning(t('gitView.toast.branchCreatedLocally'), {
          description: (
            <span className="text-foreground/80 dark:text-foreground/70">
              Upstream setup failed: {message}
            </span>
          ),
        });
      }

      await refreshStatusAndBranches();
      await refreshLog();

      if (pushSucceeded) {
        toast.success(t('gitView.toast.upstreamSet', { branch: branchName, remote: remoteName }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.createBranchFailed');
      toast.error(message);
      throw err;
    }
  };

  const handleRenameBranch = async (oldName: string, newName: string) => {
    if (!currentDirectory) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment, status ?? undefined);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotRenameBranch', { reason: formatMutationBlockingReason(blockingReasons[0]) }));
      return;
    }

    try {
      await git.renameBranch(currentDirectory, oldName, newName);
      toast.success(t('gitView.toast.renamedBranch', { oldName, newName }));
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('gitView.toast.renameBranchFailed', { oldName, newName });
      toast.error(message);
    }
  };

  const activateWorktreeTarget = React.useCallback(async (
    result: Extract<BranchCheckoutResult, { type: 'worktree-target' }>,
  ) => {
    if (!currentProject) {
      toast.error(t('gitView.toast.cannotCheckout', { reason: 'project is unavailable' }));
      return;
    }

    setActiveProjectIdOnly(currentProject.id);
    if (newSessionDraft?.open) {
      setNewSessionDraftTarget({
        projectId: currentProject.id,
        directoryOverride: result.directory,
      }, { force: true });
      setDraftPreserveDirectoryOverride(true);
    } else {
      openNewSessionDraft({
        selectedProjectId: currentProject.id,
        directoryOverride: result.directory,
        preserveDirectoryOverride: true,
      });
    }

    toast.success(t('gitView.toast.switchedToWorktree', { name: result.branch }));
    await fetchAll(result.directory, git, { includeIdentity: canUseHostGitIdentity }).catch((error) => {
      console.debug('Git view worktree target refresh failed:', error);
    });
  }, [canUseHostGitIdentity, currentProject, fetchAll, git, newSessionDraft?.open, openNewSessionDraft, setActiveProjectIdOnly, setDraftPreserveDirectoryOverride, setNewSessionDraftTarget, t]);

  const handleCheckoutBranch = async (branch: string) => {
    if (!currentDirectory) return;

    try {
      const result = await checkoutBranchWithOptionalStash({
        git,
        directory: currentDirectory,
        branch,
        status,
        attachment: worktreeAttachment,
      });

      if (result.type === 'already-current') {
        return;
      }

      if (result.type === 'blocked') {
        toast.error(t('gitView.toast.cannotCheckout', { reason: result.reason }));
        return;
      }

      if (result.type === 'worktree-target') {
        await activateWorktreeTarget(result);
        return;
      }

      if (result.type === 'needs-stash') {
        setStashDialogOperation('checkout');
        setStashDialogBranch(result.branch);
        setStashDialogOpen(true);
        return;
      }

      if (result.type === 'restore-failed') {
        const message = result.error instanceof Error ? result.error.message : t('gitView.toast.restoreStashFailed');
        toast.error(message);
        await refreshStatusAndBranches();
        await refreshLog();
        return;
      }

      toast.success(t('gitView.toast.checkedOut', { name: result.branch }));
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('gitView.toast.checkoutFailed', { name: branch });
      toast.error(message);
    }
  };

  const handleApplyIdentity = async (profile: GitIdentityProfile) => {
    if (!canUseHostGitIdentity || !currentDirectory) return;
    beginIdentityApply();

    try {
      await git.setGitIdentity(currentDirectory, profile.id);
      toast.success(t('gitView.toast.appliedIdentity', { name: profile.name }));
      await refreshIdentity();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.applyIdentityFailed');
      toast.error(message);
    } finally {
      endIdentityApply();
    }
  };

  const { localBranches, remoteBranches } = React.useMemo(
    () => splitVisibleGitBranches({
      allBranches: branches?.all ?? [],
      project: currentProject,
      restrictToGrantedBranches,
    }),
    [branches?.all, currentProject, restrictToGrantedBranches],
  );
  const integrateBranchChoices = React.useMemo(
    () => resolveIntegrateBranchChoices({
      localBranches,
      sourceBranch: sourceBranchForIntegrate,
      defaultTargetBranch,
      restrictToGrantedBranches,
    }),
    [defaultTargetBranch, localBranches, restrictToGrantedBranches, sourceBranchForIntegrate],
  );

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) {
      return remotes;
    }

    const inferredNames = new Set<string>();
    const tracking = status?.tracking?.trim();
    if (tracking && tracking.includes('/')) {
      inferredNames.add(tracking.split('/')[0]);
    }

    for (const branchName of remoteBranches) {
      const slashIndex = branchName.indexOf('/');
      if (slashIndex > 0) {
        inferredNames.add(branchName.slice(0, slashIndex));
      }
    }

    if (inferredNames.size === 0 && remoteUrl) {
      inferredNames.add('origin');
    }

    return Array.from(inferredNames).map((name) => ({
      name,
      fetchUrl: remoteUrl ?? '',
      pushUrl: remoteUrl ?? '',
    }));
  }, [remotes, remoteBranches, remoteUrl, status?.tracking]);

  React.useEffect(() => {
    if (!currentDirectory || !git || isGitRepo !== true) {
      return;
    }

    const trackingRemote = resolveTrackingRemote(status?.tracking, effectiveRemotes);
    if (!trackingRemote) {
      return;
    }

    const refreshKey = `${normalizePath(currentDirectory)}::${trackingRemote.name}`;
    const now = Date.now();
    const lastRefreshAt = remoteRefreshTimestampsRef.current.get(refreshKey) ?? 0;
    if (now - lastRefreshAt < GIT_REMOTE_REFRESH_STALE_MS) {
      return;
    }

    let cancelled = false;
    remoteRefreshTimestampsRef.current.set(refreshKey, now);

    const refreshFromRemote = async () => {
      try {
        await git.gitFetch(currentDirectory, { remote: trackingRemote.name });
        if (cancelled) {
          return;
        }
        await Promise.all([
          fetchStatus(currentDirectory, git, { silent: true }),
          fetchBranches(currentDirectory, git),
          fetchLog(currentDirectory, git, logMaxCountLocal),
        ]);
      } catch (error) {
        console.debug('Git view remote refresh failed:', error);
      }
    };

    void refreshFromRemote();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, effectiveRemotes, fetchBranches, fetchLog, fetchStatus, git, isGitRepo, logMaxCountLocal, status?.tracking]);

  React.useEffect(() => {
    if (!currentDirectory || !git || isGitRepo !== true) {
      return;
    }

    let cancelled = false;
    let isRefreshing = false;

    const refreshFromRemote = async () => {
      if (cancelled || isRefreshing) {
        return;
      }
      isRefreshing = true;
      try {
        const trackingRemote = resolveTrackingRemote(status?.tracking, effectiveRemotes);
        if (trackingRemote) {
          await git.gitFetch(currentDirectory, { remote: trackingRemote.name });
        }
        if (cancelled) {
          return;
        }
        await Promise.all([
          fetchStatus(currentDirectory, git, { silent: true }),
          fetchBranches(currentDirectory, git),
          fetchLog(currentDirectory, git, logMaxCountLocal),
        ]);
      } catch (error) {
        // Background refresh should keep history accurate when possible, but
        // transient network/auth failures should not interrupt active work.
        console.debug('Hourly git history refresh failed:', error);
      } finally {
        isRefreshing = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void refreshFromRemote();
    }, GIT_REMOTE_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [currentDirectory, effectiveRemotes, fetchBranches, fetchLog, fetchStatus, git, isGitRepo, logMaxCountLocal, status?.tracking]);

  const baseBranch = React.useMemo(() => {
    const remoteNames = new Set(effectiveRemotes.map((remote) => remote.name));
    const normalizeBaseCandidate = (value: string): string => {
      if (!value) {
        return '';
      }

      let normalized = value.trim();
      if (!normalized || normalized === 'HEAD') {
        return '';
      }

      if (localBranches.includes(normalized)) {
        return normalized;
      }

      if (normalized.startsWith('refs/heads/')) {
        normalized = normalized.slice('refs/heads/'.length);
      }
      if (normalized.startsWith('heads/')) {
        normalized = normalized.slice('heads/'.length);
      }
      if (normalized.startsWith('remotes/')) {
        normalized = normalized.slice('remotes/'.length);
      }

      const slashIndex = normalized.indexOf('/');
      if (slashIndex > 0) {
        const maybeRemote = normalized.slice(0, slashIndex);
        if (remoteNames.has(maybeRemote)) {
          const withoutRemote = normalized.slice(slashIndex + 1).trim();
          if (withoutRemote) {
            normalized = withoutRemote;
          }
        }
      }

      return normalized;
    };

    const fromMeta = normalizeBaseCandidate(
      typeof worktreeMetadata?.createdFromBranch === 'string' ? worktreeMetadata.createdFromBranch : ''
    );
    if (fromMeta) return fromMeta;

    const fromHint = normalizeBaseCandidate(typeof rootBranchHint === 'string' ? rootBranchHint : '');
    if (fromHint) return fromHint;

    if (localBranches.includes('main')) return 'main';
    if (localBranches.includes('master')) return 'master';
    if (localBranches.includes('develop')) return 'develop';
    return 'main';
  }, [effectiveRemotes, localBranches, rootBranchHint, worktreeMetadata?.createdFromBranch]);

  const updateTargetBranch = React.useMemo(() => {
    const remoteNames = effectiveRemotes.map((remote) => remote.name);
    const remoteCandidates = remoteNames.map((remote) => `${remote}/${baseBranch}`);
    return remoteCandidates.find((candidate) => remoteBranches.includes(candidate)) ?? baseBranch;
  }, [baseBranch, effectiveRemotes, remoteBranches]);

  const availableIdentities = React.useMemo(() => {
    const unique = new Map<string, GitIdentityProfile>();
    if (globalIdentity) {
      unique.set(globalIdentity.id, globalIdentity);
    }

    let repoHostPath: string | null = null;
    if (remoteUrl) {
      try {
        let normalized = remoteUrl.trim();
        if (normalized.startsWith('git@')) {
          normalized = `https://${normalized.slice(4).replace(':', '/')}`;
        }
        if (normalized.endsWith('.git')) {
          normalized = normalized.slice(0, -4);
        }
        const url = new URL(normalized);
        repoHostPath = url.hostname + url.pathname;
      } catch { /* ignore */ }
    }

    for (const profile of profiles) {
      if (profile.authType !== 'token') {
        unique.set(profile.id, profile);
        continue;
      }

      const profileHost = profile.host;
      if (!profileHost) {
        unique.set(profile.id, profile);
        continue;
      }

      if (!profileHost.includes('/')) {
        unique.set(profile.id, profile);
        continue;
      }

      if (repoHostPath && repoHostPath === profileHost) {
        unique.set(profile.id, profile);
      }
    }
    return Array.from(unique.values());
  }, [profiles, globalIdentity, remoteUrl]);

  const activeIdentityProfile = React.useMemo((): GitIdentityProfile | null => {
    if (currentIdentity?.userName && currentIdentity?.userEmail) {
      const match = profiles.find(
        (profile) =>
          profile.userName === currentIdentity.userName &&
          profile.userEmail === currentIdentity.userEmail
      );

      if (match) {
        return match;
      }

      if (
        globalIdentity &&
        globalIdentity.userName === currentIdentity.userName &&
        globalIdentity.userEmail === currentIdentity.userEmail
      ) {
        return globalIdentity;
      }

      return {
        id: 'local-config',
        name: currentIdentity.userName,
        userName: currentIdentity.userName,
        userEmail: currentIdentity.userEmail,
        sshKey: currentIdentity.sshCommand?.replace('ssh -i ', '') ?? null,
        color: 'info',
        icon: 'user',
      };
    }

    return globalIdentity ?? null;
  }, [currentIdentity, profiles, globalIdentity]);

  const selectedCount = commitScope.files.length;
  const isBusy = isLoading || syncAction !== null || commitAction !== null;
  const canGenerateCommitMessage = Boolean(
    currentDirectory &&
    commitScope.files.length > 0 &&
    commitAction === null &&
    !isGeneratingCommitMessage
  );
  const currentBranch = status?.current ?? null;
  const canShowIntegrateCommitsSection = Boolean(
    worktreeMetadata
    && repoRootForIntegrate
    && sourceBranchForIntegrate
    && shouldShowIntegrateCommits
    && integrateBranchChoices.targetBranches.length > 0
  );
  const canShowPullRequestSection = Boolean(
    currentDirectory && currentBranch
  );
  const canShowBranchWorkflows = Boolean(currentBranch);
  const integrateCommitsProps =
    canShowIntegrateCommitsSection && repoRootForIntegrate && sourceBranchForIntegrate && worktreeMetadata
      ? {
          repoRoot: repoRootForIntegrate,
          sourceBranch: sourceBranchForIntegrate,
          worktreeMetadata,
        }
      : null;
  const pullRequestProps = React.useMemo(() => {
    if (!canShowPullRequestSection || !currentDirectory || !currentBranch) {
      return null;
    }
    return {
      directory: currentDirectory,
      branch: currentBranch,
    };
  }, [canShowPullRequestSection, currentBranch, currentDirectory]);

  React.useEffect(() => {
    if (!currentDirectory || !git || !log?.all?.length || !currentBranch || !baseBranch || currentBranch === baseBranch) {
      setHistoryBranchDivider(null);
      return;
    }

    let cancelled = false;

    const resolveBranchDivider = async () => {
      try {
        const branchOnlyLog = await git.getGitLog(currentDirectory, {
          from: baseBranch,
          to: 'HEAD',
          maxCount: logMaxCountLocal,
        });

        if (cancelled) {
          return;
        }

        const branchHashes = new Set(
          (branchOnlyLog?.all ?? [])
            .map((entry) => entry.hash)
            .filter((hash) => typeof hash === 'string' && hash.length > 0)
        );

        if (branchHashes.size === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        const insertBeforeIndex = log.all.findIndex((entry) => !branchHashes.has(entry.hash));
        if (insertBeforeIndex === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        if (insertBeforeIndex === -1) {
          setHistoryBranchDivider({
            insertBeforeIndex: log.all.length,
            branchName: currentBranch,
            direction: 'up',
          });
          return;
        }

        setHistoryBranchDivider({
          insertBeforeIndex,
          branchName: currentBranch,
          direction: 'up',
        });
      } catch {
        if (!cancelled) {
          setHistoryBranchDivider(null);
        }
      }
    };

    void resolveBranchDivider();

    return () => {
      cancelled = true;
    };
  }, [baseBranch, currentBranch, currentDirectory, git, log, logMaxCountLocal]);
  // Keep these sections stable in layout; individual cards render placeholders when unavailable.

  const handleRevertFile = React.useCallback(
    async (filePath: string) => {
      if (!currentDirectory) return;

      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.revertGitFile(currentDirectory, filePath);
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('gitView.toast.revertFailed');
        toast.error(message);
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [currentDirectory, refreshStatusAndBranches, git, t]
  );

  const handleStageFile = React.useCallback(
    async (filePath: string) => {
      if (!currentDirectory) return;

      setStagingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.stageGitFile(currentDirectory, filePath);
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('gitView.toast.stageFailed');
        toast.error(message);
      } finally {
        setStagingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [currentDirectory, git, refreshStatusAndBranches, t]
  );

  const handleUnstageFile = React.useCallback(
    async (filePath: string) => {
      if (!currentDirectory) return;

      setStagingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.unstageGitFile(currentDirectory, filePath);
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('gitView.toast.unstageFailed');
        toast.error(message);
      } finally {
        setStagingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [currentDirectory, git, refreshStatusAndBranches, t]
  );

  const handleRevertAll = React.useCallback(
    async (paths: string[]) => {
      if (!currentDirectory || paths.length === 0 || isRevertingAll) {
        return;
      }

      const uniquePaths = Array.from(new Set(paths));
      setIsRevertingAll(true);
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        uniquePaths.forEach((path) => next.add(path));
        return next;
      });

      const failed: Array<{ path: string; message: string }> = [];

      try {
        await Promise.all(uniquePaths.map(async (filePath) => {
          try {
            await git.revertGitFile(currentDirectory, filePath);
          } catch (err) {
            failed.push({
              path: filePath,
              message: err instanceof Error ? err.message : t('gitView.toast.revertFailed'),
            });
          }
        }));

        await refreshStatusAndBranches(false);

        if (failed.length === 0) {
          toast.success(
            uniquePaths.length === 1
              ? t('gitView.toast.revertedFilesSingle', { count: uniquePaths.length })
              : t('gitView.toast.revertedFilesPlural', { count: uniquePaths.length })
          );
        } else if (failed.length === uniquePaths.length) {
          toast.error(failed[0]?.message || t('gitView.toast.revertFailed'));
        } else {
          const successCount = uniquePaths.length - failed.length;
          toast.warning(
            successCount === 1
              ? t('gitView.toast.revertedSomeSingle', { success: successCount, failed: failed.length })
              : t('gitView.toast.revertedSomePlural', { success: successCount, failed: failed.length })
          );
        }
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          uniquePaths.forEach((path) => next.delete(path));
          return next;
        });
        setIsRevertingAll(false);
      }
    },
    [currentDirectory, git, isRevertingAll, refreshStatusAndBranches, t]
  );

  const handleSelectGitmoji = React.useCallback((emoji: string, code: string) => {
    const token = code || emoji;
    setCommitMessage((current) => {
      const trimmed = current.trimStart();
      if (trimmed.startsWith(emoji) || (code && trimmed.startsWith(code))) {
        return current;
      }
      const prefix = token.endsWith(' ') ? token : `${token} `;
      return `${prefix}${current}`.trimStart();
    });
    setGitmojiSearch('');
    setIsGitmojiPickerOpen(false);
  }, []);

  const handleLoadMoreHistory = React.useCallback(() => {
    if (!currentDirectory || isLogLoading) return;

    setLogMaxCountLocal((currentCount) => {
      const nextCount = currentCount + 25;
      setLogMaxCount(currentDirectory, nextCount);
      void fetchLog(currentDirectory, git, nextCount);
      return nextCount;
    });
  }, [currentDirectory, fetchLog, git, isLogLoading, setLogMaxCount]);

  const isUncommittedChangesError = React.useCallback((error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
      message.includes('uncommitted changes') ||
      message.includes('local changes') ||
      message.includes('your local changes would be overwritten') ||
      message.includes('please commit your changes or stash them') ||
      message.includes('cannot rebase: you have unstaged changes') ||
      message.includes('error: cannot pull with rebase')
    );
  }, []);

  // Helper to add/update operation logs
  const addOperationLog = React.useCallback((message: string, status: OperationLogEntry['status']) => {
    setOperationLogs(prev => [...prev, { message, status, timestamp: Date.now() }]);
  }, []);

  const updateLastLog = React.useCallback((status: OperationLogEntry['status'], message?: string) => {
    setOperationLogs(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        status,
        ...(message ? { message } : {}),
      };
      return updated;
    });
  }, []);

  // Called at start of operation to reset logs
  const resetOperationLogs = React.useCallback(() => {
    setOperationLogs([]);
  }, []);

  // Called when dialog is closed to fully reset state
  const handleOperationComplete = React.useCallback(() => {
    setOperationLogs([]);
    setBranchOperation(null);
  }, []);

  const resolveIntegrationTarget = React.useCallback((branch: string) => {
    const trimmed = branch.trim();
    const knownRemoteNames = new Set(effectiveRemotes.map((remote) => remote.name));
    const slashIndex = trimmed.indexOf('/');

    if (slashIndex > 0) {
      const remote = trimmed.slice(0, slashIndex);
      const remoteBranch = trimmed.slice(slashIndex + 1);
      if (knownRemoteNames.has(remote) && remoteBranch) {
        return { branch: trimmed, remote, remoteBranch };
      }
    }

    for (const remote of effectiveRemotes) {
      const remoteCandidate = `${remote.name}/${trimmed}`;
      if (remoteBranches.includes(remoteCandidate)) {
        return { branch: remoteCandidate, remote: remote.name, remoteBranch: trimmed };
      }
    }

    return { branch: trimmed, remote: null, remoteBranch: null };
  }, [effectiveRemotes, remoteBranches]);

  const handleMerge = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('merge');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Merging ${target.branch} into ${currentBranch}...`, 'running');
        const result = await git.merge(currentDirectory, { branch: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Merge conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
        } else {
          updateLastLog('done', `Merged ${target.branch} into ${currentBranch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('merge');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to merge ${target.branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleRebase = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('rebase');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Rebasing ${currentBranch} onto ${target.branch}...`, 'running');
        const result = await git.rebase(currentDirectory, { onto: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Rebase conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
        } else {
          updateLastLog('done', `Rebased ${currentBranch} onto ${target.branch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('rebase');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to rebase onto ${target.branch}`;
          updateLastLog('error', message);
        }
      } finally {
        await refreshStatusAndBranches(false);
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleAbortConflict = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      if (conflictOperation === 'merge') {
        await git.abortMerge(currentDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
        await git.abortRebase(currentDirectory);
        toast.success(t('gitView.toast.rebaseAborted'));
      }
      clearConflictState();
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to abort ${conflictOperation}`;
      toast.error(message);
    } finally {
      await refreshStatusAndBranches();
      await refreshLog();
    }
  }, [currentDirectory, git, conflictOperation, refreshStatusAndBranches, refreshLog, clearConflictState, t]);

  // Git also represents add/add and delete/delete conflicts without a U.
  const unresolvedConflictFiles = React.useMemo(() => (
    (status?.files ?? []).filter((file) => (
      file.index === 'U' || file.working_dir === 'U'
      || (file.index === 'A' && file.working_dir === 'A')
      || (file.index === 'D' && file.working_dir === 'D')
    )).map((file) => file.path)
  ), [status?.files]);
  const hasUnresolvedConflicts = unresolvedConflictFiles.length > 0;

  const handleContinueOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      const isRebase = !!status?.rebaseInProgress;

      if (isMerge) {
        const result = await git.continueMerge(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
          toast.error(t('gitView.toast.mergeConflictsDetected'));
        } else {
          clearConflictState();
          toast.success(t('gitView.toast.mergeCompleted'));
        }
      } else if (isRebase) {
        const result = await git.continueRebase(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
          toast.error(t('gitView.toast.rebaseConflictsDetected'));
        } else {
          clearConflictState();
          toast.success(t('gitView.toast.rebaseStepCompleted'));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.continueOperationFailed');
      toast.error(message);
    } finally {
      await refreshStatusAndBranches();
      await refreshLog();
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, persistConflictState, clearConflictState, t]);

  const handleAbortOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      if (isMerge) {
        await git.abortMerge(currentDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
        await git.abortRebase(currentDirectory);
        toast.success(t('gitView.toast.rebaseAborted'));
      }
      clearConflictState();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.abortOperationFailed');
      toast.error(message);
    } finally {
      await refreshStatusAndBranches();
      await refreshLog();
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, clearConflictState, t]);

  const handleResolveWithAIFromBanner = React.useCallback(() => {
    if (!currentDirectory) return;

    // Determine operation type from status
    const isMerge = !!status?.mergeInProgress?.head;
    const operation = isMerge ? 'merge' : 'rebase';

    setConflictFiles(unresolvedConflictFiles);
    setConflictOperation(operation);
    setConflictDialogOpen(true);
  }, [currentDirectory, status, unresolvedConflictFiles]);

  const handleStashAndRetry = React.useCallback(
    async (restoreAfter: boolean) => {
      if (!currentDirectory) return;

      const currentBranch = status?.current;
      const operation = stashDialogOperation;
      const branch = stashDialogBranch;

      if (operation === 'checkout') {
        const result = await checkoutBranchWithOptionalStash({
          git,
          directory: currentDirectory,
          branch,
          status,
          attachment: worktreeAttachment,
          stashConfirmed: true,
          restoreAfter,
        });

        if (result.type === 'checked-out') {
          toast.success(t('gitView.toast.checkedOut', { name: result.branch }));
          if (result.restored) {
            toast.success(t('gitView.toast.stashedRestored'));
          }
        } else if (result.type === 'restore-failed') {
          const message = result.error instanceof Error ? result.error.message : t('gitView.toast.restoreStashFailed');
          toast.error(message);
        } else if (result.type === 'blocked') {
          toast.error(t('gitView.toast.cannotCheckout', { reason: result.reason }));
        } else if (result.type === 'worktree-target') {
          await activateWorktreeTarget(result);
        }

        await refreshStatusAndBranches();
        await refreshLog();
        return;
      }

      // Stash changes
      try {
        await git.stash(currentDirectory, {
          message: `Auto-stash before ${operation} with ${branch}`,
          includeUntracked: true,
        });
      } catch (stashErr) {
        const msg = stashErr instanceof Error ? stashErr.message : 'Failed to stash changes';
        toast.error(msg);
        return;
      }

      let operationSucceeded = false;
      let hasConflict = false;

      try {
        // Perform the operation
        if (operation === 'merge') {
          const result = await git.merge(currentDirectory, { branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('merge');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.mergedIntoBranch', { branch, currentBranch: currentBranch || '' }));
          }
        } else {
          const result = await git.rebase(currentDirectory, { onto: branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('rebase');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.rebasedOntoBranch', { currentBranch: currentBranch || '', branch }));
          }
        }

        // Restore stashed changes if requested and operation succeeded
        if (restoreAfter && operationSucceeded) {
          try {
            await git.stashPop(currentDirectory);
            toast.success(t('gitView.toast.stashedRestored'));
          } catch (popErr) {
            const popMessage = popErr instanceof Error ? popErr.message : t('gitView.toast.restoreStashFailed');
            toast.error(popMessage);
          }
        } else if (restoreAfter && hasConflict) {
          toast.info(t('gitView.toast.restoreStashManually'));
        }

        await refreshStatusAndBranches();
        await refreshLog();
      } catch (err) {
        // If the operation failed (not due to conflicts), try to restore stash
        if (restoreAfter) {
          try {
            await git.stashPop(currentDirectory);
          } catch {
            // Ignore stash pop errors in this case
          }
        }
        throw err;
      }
    },
    [activateWorktreeTarget, currentDirectory, git, status, stashDialogOperation, stashDialogBranch, worktreeAttachment, refreshStatusAndBranches, refreshLog, t]
  );

  const handleFinishCurrentBranchIntoMain = React.useCallback(
    async (restoreAfter: boolean) => {
      if (!currentDirectory) return;

      const result = await finishCurrentBranchIntoMainWithOptionalStash({
        git,
        directory: currentDirectory,
        restoreAfter,
      });

      if (result.type === 'blocked') {
        toast.error(t('gitView.toast.mergeIntoMainBlocked', { reason: result.reason }));
        return;
      }

      if (result.type === 'conflict') {
        const conflictFiles = result.conflictFiles ?? [];
        setConflictFiles(conflictFiles);
        setConflictOperation('merge');
        setConflictDialogOpen(true);
        persistConflictState(currentDirectory, conflictFiles, 'merge');
        toast.error(t('gitView.toast.mergeIntoMainConflicts', { branch: result.sourceBranch }));
        await refreshStatusAndBranches();
        await refreshLog();
        return;
      }

      clearConflictState();

      if (result.type === 'delete-failed') {
        const reason = result.error instanceof Error ? result.error.message : String(result.error || t('gitView.stash.finishIntoMainFailed'));
        toast.error(t('gitView.toast.mergeIntoMainDeleteFailed', { branch: result.sourceBranch, reason }));
        await refreshStatusAndBranches();
        await refreshLog();
        return;
      }

      if (result.type === 'restore-failed') {
        const reason = result.error instanceof Error ? result.error.message : String(result.error || t('gitView.toast.restoreStashFailed'));
        toast.error(t('gitView.toast.mergeIntoMainRestoreFailed', { branch: result.sourceBranch, reason }));
        await refreshStatusAndBranches();
        await refreshLog();
        return;
      }

      toast.success(t('gitView.toast.mergedIntoMainAndDeleted', { branch: result.sourceBranch }));
      if (result.restored) {
        toast.success(t('gitView.toast.stashedRestored'));
      }
      await refreshStatusAndBranches();
      await refreshLog();
    },
    [clearConflictState, currentDirectory, git, persistConflictState, refreshLog, refreshStatusAndBranches, t]
  );

  const canFinishCurrentBranchIntoMain = React.useMemo(() => (
    stashDialogOperation === 'checkout' &&
    Boolean(status?.current && status.current !== 'main' && localBranches.includes('main'))
  ), [localBranches, stashDialogOperation, status]);

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          {t('gitView.empty.selectSessionOrDirectory')}
        </p>
      </div>
    );
  }

  if (isLoading && isGitRepo === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RiLoader4Line className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('gitView.loading.checkingRepository')}</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    if (shouldHideNotGitState) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 text-center">
          <RiLoader4Line className="mb-3 size-6 animate-spin text-muted-foreground" />
          <p className="typography-ui-label font-semibold text-foreground">
            {t('gitView.empty.worktreeSetupInProgress')}
          </p>
          <p className="typography-meta mt-1 text-muted-foreground">
            {t('gitView.empty.worktreeSetupDescription')}
          </p>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <RiGitBranchLine className="mb-3 size-6 text-muted-foreground" />
        <p className="typography-ui-label font-semibold text-foreground">
          {t('gitView.empty.notGitRepository')}
        </p>
        <p className="typography-meta mt-1 text-muted-foreground">
          {t('gitView.empty.notGitRepositoryDescription')}
        </p>
        {repairActions.includes('open-without-worktree-features') ? (
          <p className="typography-meta mt-2 text-muted-foreground">
            {t('gitView.empty.worktreeFeaturesUnavailable')}
          </p>
        ) : null}
      </div>
    );
  }

  const changesPanelStyle: React.CSSProperties = canResizeGitCommitSections
    ? {
        flexBasis: `${gitCommitSplitRatio * 100}%`,
        flexGrow: 0,
        flexShrink: 1,
      }
    : isChangesSectionOpen
      ? { flex: '1 1 0%' }
      : { flex: '0 0 auto' };

  const historyPanelStyle: React.CSSProperties = canResizeGitCommitSections
    ? {
        flexBasis: `${(1 - gitCommitSplitRatio) * 100}%`,
        flexGrow: 0,
        flexShrink: 1,
      }
    : isHistorySectionOpen
      ? { flex: '1 1 0%' }
      : { flex: '0 0 auto' };

  const gitCommitSplitPercent = Math.round(gitCommitSplitRatio * 100);
  const renderHistorySection = (contentMaxHeightClassName: string, className?: string) => (
    <HistorySection
      log={log}
      isLogLoading={isLogLoading}
      onLoadMore={handleLoadMoreHistory}
      expandedCommitHashes={expandedCommitHashes}
      onToggleCommit={handleToggleCommit}
      commitFilesMap={commitFilesMap}
      loadingCommitHashes={loadingCommitHashes}
      onCopyHash={handleCopyCommitHash}
      contentMaxHeightClassName={contentMaxHeightClassName}
      className={className}
      branchDivider={historyBranchDivider}
      currentBranch={status?.current ?? null}
      trackingBranch={status?.tracking ?? null}
      isOpen={isHistorySectionOpen}
      onOpenChange={(open) => {
        if (currentDirectory) {
          setHistorySectionOpen(currentDirectory, open);
        }
      }}
      toolbarSlot={status ? (
        <SyncActions
          syncAction={syncAction}
          remotes={effectiveRemotes}
          onFetch={(remote) => handleSyncAction('fetch', remote)}
          onPull={(remote) => handleSyncAction('pull', remote)}
          onPush={() => handleSyncAction('push')}
          onRefresh={handleRefreshHistoryControls}
          disabled={!status}
          remoteActionsDisabled={!!status.rebaseInProgress || status.headState === 'detached'}
          isRefreshing={isRefreshingHistoryControls || isLoading || isLogLoading}
          iconOnly={true}
          aheadCount={status.ahead}
          behindCount={status.behind}
          trackingRemoteName={status.tracking?.split('/')[0]}
          hasUncommittedChanges={(status.files?.length ?? 0) > 0}
        />
      ) : null}
    />
  );

  return (
    <div className={cn('@container/git-view flex h-full flex-col overflow-hidden', 'bg-sidebar')}>
          <GitHeader
            status={status}
            localBranches={localBranches}
            remoteBranches={remoteBranches}
            worktreeBranches={worktreeBranches}
            branchInfo={branches?.branches}
            remotes={effectiveRemotes}
            onCheckoutBranch={handleCheckoutBranch}
            onCreateBranch={canCreateBranches ? handleCreateBranch : undefined}
            onRenameBranch={canRenameBranch ? handleRenameBranch : undefined}
            activeIdentityProfile={activeIdentityProfile}
            availableIdentities={availableIdentities}
            onSelectIdentity={handleApplyIdentity}
            isApplyingIdentity={isSettingIdentity}
            isWorktreeMode={!!worktreeMetadata}
            actionTabItems={actionTabItems}
            activeActionTab={visibleActionTab}
            onSelectActionTab={(tabID) => setActionTab(tabID as ActionTab)}
          />

      {/* In-progress operation banner */}
      {currentDirectory && (
        (status?.mergeInProgress?.head) ||
        status?.rebaseInProgress
      ) && (
          <InProgressOperationBanner
            mergeInProgress={status?.mergeInProgress}
            rebaseInProgress={status?.rebaseInProgress}
            onContinue={handleContinueOperation}
            onAbort={handleAbortOperation}
            onResolveWithAI={handleResolveWithAIFromBanner}
            hasUnresolvedConflicts={hasUnresolvedConflicts}
            isLoading={isLoading}
          />
        )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className={cn('min-w-0 min-h-0 h-full flex flex-col', 'bg-sidebar')}>
            <ScrollableOverlay
              as={ScrollShadow}
              ref={actionPanelScrollRef}
              outerClassName="flex-1 min-h-0"
              className={cn('flex flex-col px-4', 'pt-1 pb-4')}
              disableHorizontal
              preventOverscroll
            >
              {visibleActionTab === 'commit' ? (
                <div className="flex flex-1 flex-col gap-2 min-h-0">
                  {(changeEntries?.length ?? 0) > 0 ? (
                    <>
                      <CommitSection
                        selectedCount={selectedCount}
                        commitMessage={commitMessage}
                        onCommitMessageChange={setCommitMessage}
                        onCommit={() => handleCommit({ pushAfter: false })}
                        onCommitAmend={() => handleCommit({ amend: true })}
                        onCommitAndPush={() => handleCommit({ pushAfter: true })}
                        onCommitAndSync={() => handleCommit({ syncAfter: true })}
                        onGenerateCommitMessage={handleGenerateCommitMessage}
                        commitAction={commitAction}
                        isGeneratingCommitMessage={isGeneratingCommitMessage}
                        commitGenerationDisabled={!canGenerateCommitMessage}
                        gitmojiEnabled={settingsGitmojiEnabled}
                        onOpenGitmojiPicker={() => setIsGitmojiPickerOpen(true)}
                        syncAction={syncAction}
                        remotes={effectiveRemotes}
                        onSync={(remote) => handleSyncAction('sync', remote)}
                        syncDisabled={!status || !!status.rebaseInProgress || status.headState === 'detached'}
                        aheadCount={status?.ahead ?? 0}
                        behindCount={status?.behind ?? 0}
                        trackingRemoteName={status?.tracking?.split('/')[0]}
                        hasUncommittedChanges={(status?.files?.length ?? 0) > 0}
                      />

                      <div
                        ref={gitCommitSplitContainerRef}
                        className="flex flex-1 min-h-0 flex-col overflow-hidden"
                      >
                        <div
                          className="flex min-h-0 flex-col overflow-hidden"
                          style={changesPanelStyle}
                        >
                          {stagedEntries.length > 0 ? (
                            <ChangesSection
                              title={t('gitView.changes.stagedTitle')}
                              changedFilesAriaLabel={t('gitView.changes.stagedChangedFilesAria')}
                              changeEntries={stagedEntries}
                              diffStats={status?.diffStats}
                              revertingPaths={revertingPaths}
                              stagingPaths={stagingPaths}
                              onViewDiff={(path) => {
                                recordFileOpened({ path, directory: currentDirectory || undefined, sourceSurface: 'git-changes' });
                                if (currentDirectory && !isMobile) {
                                  openContextDiff(currentDirectory, path, true);
                                  return;
                                }
                                navigateToDiff(path, { staged: true });
                                if (isMobile) {
                                  setRightSidebarOpen(false);
                                }
                              }}
                              onRevertFile={handleRevertFile}
                              onUnstageFile={handleUnstageFile}
                              isOpen={isStagedChangesSectionOpen}
                              onOpenChange={setIsStagedChangesSectionOpen}
                              className="shrink-0"
                            />
                          ) : null}
                          <ChangesSection
                            title={t('gitView.changes.title')}
                            changeEntries={unstagedEntries}
                            onVisiblePathsChange={setVisibleChangePaths}
                            diffStats={status?.diffStats}
                            revertingPaths={revertingPaths}
                            stagingPaths={stagingPaths}
                            onRevertAll={handleRevertAll}
                            onViewDiff={(path) => {
                              recordFileOpened({ path, directory: currentDirectory || undefined, sourceSurface: 'git-changes' });
                              if (currentDirectory && !isMobile) {
                                openContextDiff(currentDirectory, path);
                                return;
                              }
                              navigateToDiff(path);
                              if (isMobile) {
                                setRightSidebarOpen(false);
                              }
                            }}
                            onRevertFile={handleRevertFile}
                            onStageFile={handleStageFile}
                            isRevertingAll={isRevertingAll}
                            isOpen={isChangesSectionOpen}
                            onOpenChange={setIsChangesSectionOpen}
                          />
                        </div>

                        {canResizeGitCommitSections ? (
                          <div
                            className="group/splitter flex h-3 shrink-0 cursor-row-resize items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            tabIndex={0}
                            onPointerDown={handleGitCommitSplitPointerDown}
                            onKeyDown={handleGitCommitSplitKeyDown}
                            role="separator"
                            aria-orientation="horizontal"
                            aria-valuemin={GIT_COMMIT_SPLIT_MIN_RATIO * 100}
                            aria-valuemax={GIT_COMMIT_SPLIT_MAX_RATIO * 100}
                            aria-valuenow={gitCommitSplitPercent}
                            aria-label={t('gitView.history.resizeChangesHistoryAria')}
                          >
                            <div className="h-px w-full bg-border/60 transition-colors group-hover/splitter:bg-interactive-hover" />
                          </div>
                        ) : (
                          <div className="h-px shrink-0 bg-border/60" aria-hidden />
                        )}

                        <div
                          className="flex min-h-0 flex-col overflow-hidden"
                          style={historyPanelStyle}
                        >
                          {renderHistorySection('flex-1 min-h-0', 'flex-1')}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <GitEmptyState />
                      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                        {renderHistorySection('flex-1 min-h-0', 'flex-1')}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {visibleActionTab === 'branch' ? (
                <div className="space-y-4">
                  {canShowBranchWorkflows ? (
                    <>
                      <BranchIntegrationSection
                        mode="inline"
                        currentBranch={status?.current}
                        localBranches={localBranches}
                        remoteBranches={remoteBranches}
                        defaultTargetBranch={updateTargetBranch}
                        onMerge={handleMerge}
                        onRebase={handleRebase}
                        disabled={isBusy}
                        isOperating={branchOperation !== null}
                        operationLogs={operationLogs}
                        onOperationComplete={handleOperationComplete}
                      />
                      {integrateCommitsProps ? (
                        <IntegrateCommitsSection
                          key={integrateCommitsProps.worktreeMetadata.path}
                          repoRoot={integrateCommitsProps.repoRoot}
                          sourceBranch={integrateCommitsProps.sourceBranch}
                          worktreeMetadata={integrateCommitsProps.worktreeMetadata}
                          localBranches={integrateBranchChoices.targetBranches}
                          defaultTargetBranch={integrateBranchChoices.defaultTargetBranch}
                          refreshKey={integrateRefreshKey}
                          onRefresh={() => {
                            if (!currentDirectory) return;
                            fetchStatus(currentDirectory, git);
                            fetchBranches(currentDirectory, git);
                            fetchLog(currentDirectory, git, logMaxCountLocal);
                          }}
                        />
                      ) : null}
                    </>
                  ) : (
                    <p className="typography-meta text-muted-foreground">{t('gitView.branch.actionsUnavailable')}</p>
                  )}
                </div>
              ) : null}

              {visibleActionTab === 'pr' ? (
                <div className="space-y-4">
                  {pullRequestProps ? (
                    <PullRequestSection
                      directory={pullRequestProps.directory}
                      branch={pullRequestProps.branch}
                      baseBranch={baseBranch}
                      trackingBranch={status?.tracking ?? undefined}
                      remotes={remotes}
                      remoteBranches={remoteBranches}
                      onGeneratedDescription={scrollActionPanelToBottom}
                    />
                  ) : (
                    <div className="space-y-1">
                      <div className="typography-ui-header font-semibold text-foreground">{t('gitView.pullRequest.title')}</div>
                      <div className="typography-micro text-muted-foreground">
                        {t('gitView.pullRequest.createHint')}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </ScrollableOverlay>
          </div>
        </div>
      </div>

      <Dialog open={isGitmojiPickerOpen} onOpenChange={setIsGitmojiPickerOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>{t('gitView.gitmoji.title')}</DialogTitle>
          </DialogHeader>
          <Command className="h-[420px]">
            <CommandInput
              placeholder={t('gitView.gitmoji.searchPlaceholder')}
              value={gitmojiSearch}
              onValueChange={setGitmojiSearch}
            />
            <CommandList>
              <CommandEmpty>{t('gitView.gitmoji.empty')}</CommandEmpty>
              <CommandGroup>
                {(gitmojiEmojis.length === 0
                  ? []
                  : gitmojiEmojis.filter((entry) => {
                    const term = gitmojiSearch.trim().toLowerCase();
                    if (!term) return true;
                    return (
                      entry.emoji.includes(term) ||
                      entry.code.toLowerCase().includes(term) ||
                      entry.description.toLowerCase().includes(term)
                    );
                  })
                ).map((entry) => (
                  <CommandItem
                    key={entry.code}
                    onSelect={() => handleSelectGitmoji(entry.emoji, entry.code)}
                  >
                    <span className="text-lg">{entry.emoji}</span>
                    <span className="typography-ui-label text-foreground">{entry.code}</span>
                    <span className="typography-meta text-muted-foreground">{entry.description}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {currentDirectory && (
        <ConflictDialog
          open={conflictDialogOpen}
          onOpenChange={setConflictDialogOpen}
          conflictFiles={conflictFiles}
          directory={currentDirectory}
          operation={conflictOperation}
          onAbort={handleAbortConflict}
          onClearState={clearConflictState}
        />
      )}

      <StashDialog
        open={stashDialogOpen}
        onOpenChange={setStashDialogOpen}
        operation={stashDialogOperation}
        targetBranch={stashDialogBranch}
        onConfirm={handleStashAndRetry}
        finishBranchAction={canFinishCurrentBranchIntoMain ? { onConfirm: handleFinishCurrentBranchIntoMain } : undefined}
      />

    </div>
  );
};
