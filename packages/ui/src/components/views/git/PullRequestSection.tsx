import React from 'react';
import {
  RiChat4Line,
  RiCheckLine,
  RiCheckboxCircleLine,
  RiAiGenerate2,
  RiArrowLeftLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiEditLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiGitClosePullRequestLine,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
  RiInformationLine,
  RiLoader4Line,
  RiRefreshLine,
  RiSearchLine,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { generatePullRequestDescription, isGitGenerationCancelledError } from '@/lib/gitApi';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { openExternalUrl } from '@/lib/url';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { getGitHubPrStatusKey, PR_TERMINAL_DISCOVERY_INTERVAL_MS, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import type {
  GitHubPullRequest,
  GitHubCheckRun,
  GitHubAPI,
  GitHubPullRequestContextResult,
  GitHubPullRequestSummary,
  GitHubPullRequestStatus,
  GitHubPullRequestsListResult,
  GitRemote,
} from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { resolveGitHubSourceRepo } from '@/lib/github/sourceRepo';
import { useAuthPrincipal } from '@/lib/authSession';
import { PrBodyHydrationTracker, type PrBodyHydrationRequest } from './prBodyHydrationTracker';
import {
  createNextPullRequestDraft,
  DEFAULT_PULL_REQUEST_PANEL_VIEW,
  formatPullRequestStatus,
  isCurrentPullRequestSelection,
  nextPullRequestPanelView,
  shouldClearNextPullRequestDraft,
  shouldShowPullRequestChecks,
  shouldShowPullRequestDetails,
} from './pullRequestCycle';
import type { PullRequestPanelView } from './pullRequestCycle';

type MergeMethod = 'merge' | 'squash' | 'rebase';
type DetectedUpstream = { owner: string; repo: string; url: string; defaultBranch?: string; defaultBranchSha?: string | null; remoteName?: string | null };

const pullRequestIdentity = (pullRequest: GitHubPullRequestSummary): string => {
  const repo = pullRequest.sourceRepo;
  return `${repo?.owner ?? ''}/${repo?.repo ?? ''}#${pullRequest.number}`;
};

const sortPullRequestsByUpdated = (pullRequests: GitHubPullRequestSummary[]): GitHubPullRequestSummary[] => (
  [...pullRequests].sort((left, right) => {
    const leftUpdatedAt = Date.parse(left.updatedAt || left.createdAt || '') || 0;
    const rightUpdatedAt = Date.parse(right.updatedAt || right.createdAt || '') || 0;
    return rightUpdatedAt - leftUpdatedAt;
  })
);

const mergePullRequestPages = (
  current: GitHubPullRequestSummary[],
  incoming: GitHubPullRequestSummary[],
): GitHubPullRequestSummary[] => {
  const merged = new Map(current.map((pullRequest) => [pullRequestIdentity(pullRequest), pullRequest]));
  for (const pullRequest of incoming) {
    merged.set(pullRequestIdentity(pullRequest), pullRequest);
  }
  return sortPullRequestsByUpdated(Array.from(merged.values()));
};

const statusColor = (state: string | undefined | null): string => {
  switch (state) {
    case 'success':
      return 'bg-[color:var(--status-success)]';
    case 'failure':
      return 'bg-[color:var(--status-error)]';
    case 'pending':
      return 'bg-[color:var(--status-warning)]';
    default:
      return 'bg-muted-foreground/40';
  }
};

const getPrVisualState = (status: GitHubPullRequestStatus | null): 'draft' | 'open' | 'blocked' | 'merged' | 'closed' | null => {
  const pr = status?.pr;
  if (!pr) {
    return null;
  }
  if (pr.state === 'merged') {
    return 'merged';
  }
  if (pr.state === 'closed') {
    return 'closed';
  }
  if (pr.draft) {
    return 'draft';
  }
  const checksFailed = status?.checks?.state === 'failure';
  const mergeableState = typeof pr.mergeableState === 'string' ? pr.mergeableState : '';
  const notMergeable = pr.mergeable === false || mergeableState === 'blocked' || mergeableState === 'dirty';
  if (checksFailed || notMergeable) {
    return 'blocked';
  }
  return 'open';
};

const PR_ACTION_REFRESH_DELAYS_MS = [2_000, 5_000] as const;

const branchToTitle = (branch: string): string => {
  return branch
    .replace(/^refs\/heads\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const normalizeBranchRef = (value: string): string => {
  let normalized = value.trim();
  if (!normalized) {
    return '';
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
  return normalized;
};

const remoteBranchToName = (value: string, remoteName: string | null): string => {
  const normalized = normalizeBranchRef(value);
  if (!normalized || normalized.includes('->')) {
    return '';
  }

  if (remoteName) {
    const prefix = `${remoteName}/`;
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length).trim();
    }
    return '';
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    return normalized.slice(slashIndex + 1).trim();
  }
  return normalized;
};

const getPullRequestSnapshotKey = (directory: string, branch: string): string => `${directory}::${branch}`;

type PullRequestDraftSnapshot = {
  title: string;
  body: string;
  draft: boolean;
  additionalContext: string;
  targetBaseBranch?: string;
  selectedRemoteName?: string;
  nextPrFromTerminalNumber?: number;
};

const getTrackingRemoteName = (trackingBranch: string | null | undefined): string => {
  const normalized = String(trackingBranch || '').trim();
  if (!normalized) {
    return '';
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) {
    return '';
  }

  return normalized.slice(0, slashIndex).trim();
};

const pickInitialPrRemote = (
  remotes: GitRemote[],
  options: { selectedRemoteName?: string; trackingBranch?: string }
): GitRemote | null => {
  if (remotes.length === 0) {
    return null;
  }

  const selectedRemoteName = String(options.selectedRemoteName || '').trim();
  if (selectedRemoteName) {
    const fromSnapshot = remotes.find((remote) => remote.name === selectedRemoteName);
    if (fromSnapshot) {
      return fromSnapshot;
    }
  }

  const trackingRemoteName = getTrackingRemoteName(options.trackingBranch);
  if (trackingRemoteName) {
    const maybeUpstream =
      trackingRemoteName === 'origin'
        ? remotes.find((remote) => remote.name === 'upstream')
        : null;
    if (maybeUpstream) {
      return maybeUpstream;
    }

    const fromTracking = remotes.find((remote) => remote.name === trackingRemoteName);
    if (fromTracking) {
      return fromTracking;
    }
  }

  const originRemote = remotes.find((remote) => remote.name === 'origin');
  if (originRemote) {
    return originRemote;
  }

  return remotes[0] ?? null;
};

const isEphemeralPrRemote = (name: string): boolean => name.startsWith('pr-');

const rankRemotesForAutoSelect = (
  remotes: GitRemote[],
  trackingBranch?: string,
): GitRemote[] => {
  const trackingRemote = getTrackingRemoteName(trackingBranch);
  const byName = new Map(remotes.map((remote) => [remote.name, remote]));
  const ordered: GitRemote[] = [];
  const pushUnique = (remote: GitRemote | null | undefined) => {
    if (!remote) return;
    if (ordered.some((item) => item.name === remote.name)) return;
    ordered.push(remote);
  };

  if (trackingRemote) {
    pushUnique(byName.get(trackingRemote));
  }
  pushUnique(byName.get('upstream'));
  pushUnique(byName.get('origin'));

  remotes
    .filter((remote) => !isEphemeralPrRemote(remote.name))
    .forEach((remote) => pushUnique(remote));
  remotes.forEach((remote) => pushUnique(remote));

  return ordered;
};

type TimelineCommentItem = {
  id: string;
  body: string;
  authorName: string;
  authorLogin: string | null;
  avatarUrl: string | null;
  createdAt?: string;
  context: string;
  path: string | null;
  line: number | null;
};

type ChatDispatchTarget = {
  sessionId: string;
  providerID: string;
  modelID: string;
  currentAgentName: string | null;
  currentVariant: string | null;
};

const pullRequestDraftSnapshots = new Map<string, PullRequestDraftSnapshot>();

const openExternal = openExternalUrl;

function useDetectedUpstreamRepo(directory: string, github: GitHubAPI | undefined) {
  const [detectedUpstream, setDetectedUpstream] = React.useState<DetectedUpstream | null>(null);
  const [upstreamBranches, setUpstreamBranches] = React.useState<string[]>([]);
  const attemptedDirectoryRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setDetectedUpstream(null);
    setUpstreamBranches([]);
  }, [directory]);

  React.useEffect(() => {
    if (!directory || !github?.repoUpstream || attemptedDirectoryRef.current === directory) {
      return;
    }
    attemptedDirectoryRef.current = directory;

    let cancelled = false;
    void (async () => {
      try {
        const result = await github.repoUpstream(directory);
        if (cancelled || !result?.isFork || !result.upstream) {
          return;
        }

        setDetectedUpstream(result.upstream);
        if (!github.repoBranches) {
          return;
        }

        try {
          const branches = await github.repoBranches(result.upstream.owner, result.upstream.repo);
          if (!cancelled) {
            setUpstreamBranches(branches);
          }
        } catch {
          // Silently fail - branch list is best-effort.
        }
      } catch {
        // Silently fail - upstream detection is best-effort.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directory, github]);

  return { detectedUpstream, upstreamBranches };
}

// Server/runtime error codes for the PR "Generate" button → user-facing cause.
const GENERATE_DESCRIPTION_CAUSE_KEYS: Record<string, I18nKey> = {
  FREE_ZEN_EXHAUSTED: 'gitView.pr.toast.generateDescriptionCause.exhausted',
  NO_FREE_MODELS: 'gitView.pr.toast.generateDescriptionCause.noFreeModels',
  CATALOG_UNAVAILABLE: 'gitView.pr.toast.generateDescriptionCause.catalogUnavailable',
  SESSION_MODEL_FAILED: 'gitView.pr.toast.generateDescriptionCause.sessionModelFailed',
  TIMEOUT: 'gitView.pr.toast.generateDescriptionCause.timeout',
};

const readGenerationErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
};

export const PullRequestSection: React.FC<{
  directory: string;
  branch: string;
  baseBranch: string;
  trackingBranch?: string;
  remotes?: GitRemote[];
  remoteBranches?: string[];
  onGeneratedDescription?: () => void;
}> = ({ directory, branch, baseBranch, trackingBranch, remotes = [], remoteBranches = [], onGeneratedDescription }) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const openGitHubSettings = React.useCallback(() => {
    setSettingsPage('users');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);
  const canManageGitHubAccounts = principal.scope === 'local-admin' || principal.role === 'admin';

  const snapshotKey = React.useMemo(() => getPullRequestSnapshotKey(directory, branch), [directory, branch]);
  const initialSnapshot = React.useMemo(
    () => pullRequestDraftSnapshots.get(snapshotKey) ?? null,
    [snapshotKey]
  );
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const startPrStatusWatching = useGitHubPrStatusStore((state) => state.startWatching);
  const stopPrStatusWatching = useGitHubPrStatusStore((state) => state.stopWatching);
  const refreshPrStatus = useGitHubPrStatusStore((state) => state.refresh);
  const updatePrStatus = useGitHubPrStatusStore((state) => state.updateStatus);

  const [title, setTitle] = React.useState(() => initialSnapshot?.title ?? branchToTitle(branch));
  const [body, setBody] = React.useState(() => initialSnapshot?.body ?? '');
  const [draft, setDraft] = React.useState(() => initialSnapshot?.draft ?? false);
  const [additionalContext, setAdditionalContext] = React.useState(() => initialSnapshot?.additionalContext ?? '');
  const [nextPrFromTerminalNumber, setNextPrFromTerminalNumber] = React.useState<number | null>(
    () => initialSnapshot?.nextPrFromTerminalNumber ?? null,
  );
  const [targetBaseBranch, setTargetBaseBranch] = React.useState(() => {
    const fromSnapshot = typeof initialSnapshot?.targetBaseBranch === 'string'
      ? normalizeBranchRef(initialSnapshot.targetBaseBranch)
      : '';
    if (fromSnapshot) {
      return fromSnapshot;
    }
    return normalizeBranchRef(baseBranch);
  });
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>('squash');

  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [isMerging, setIsMerging] = React.useState(false);
  const [isMarkingReady, setIsMarkingReady] = React.useState(false);
  const [isEditingPr, setIsEditingPr] = React.useState(false);
  const [hydratingPrBodyRequest, setHydratingPrBodyRequest] = React.useState<PrBodyHydrationRequest | null>(null);
  const [bodyHydrationRetryVersion, setBodyHydrationRetryVersion] = React.useState(0);
  const [editTitle, setEditTitle] = React.useState('');
  const [editBody, setEditBody] = React.useState('');

  const [isContextOpen, setIsContextOpen] = React.useState(false);
  const [isContextSheetOpen, setIsContextSheetOpen] = React.useState(false);
  const [selectedRemote, setSelectedRemote] = React.useState<GitRemote | null>(() =>
    pickInitialPrRemote(remotes, {
      selectedRemoteName: initialSnapshot?.selectedRemoteName,
      trackingBranch,
    })
  );
  const [useDetectedUpstream, setUseDetectedUpstream] = React.useState(false);
  const { detectedUpstream, upstreamBranches } = useDetectedUpstreamRepo(directory, github);

  React.useEffect(() => {
    setUseDetectedUpstream(false);
  }, [directory]);

  const hasUpstreamRemote = remotes.some((r) => r.name === 'upstream');
  const isFork = hasUpstreamRemote || detectedUpstream !== null;
  const canShow = Boolean(directory && branch && baseBranch && (branch !== baseBranch || isFork));

  const prStatusKey = React.useMemo(
    () => getGitHubPrStatusKey(directory, branch),
    [directory, branch],
  );
  const statusEntry = useGitHubPrStatusStore((state) => state.entries[prStatusKey]);

  const isLoading = statusEntry?.isLoading ?? false;
  const status = statusEntry?.status ?? null;
  const statusRepoOwner = status?.repo?.owner;
  const statusRepoName = status?.repo?.repo;
  const sourceRepo = React.useMemo(
    () => resolveGitHubSourceRepo({ owner: statusRepoOwner, repo: statusRepoName }),
    [statusRepoName, statusRepoOwner],
  );
  const error = statusEntry?.error ?? null;
  const isInitialStatusResolved = statusEntry?.isInitialStatusResolved ?? false;

  const availableBaseBranches = React.useMemo(() => {
    const selectedRemoteName = useDetectedUpstream ? null : (selectedRemote?.name?.trim() || null);
    const unique = new Set<string>();

    for (const remoteBranch of remoteBranches) {
      const branchName = remoteBranchToName(remoteBranch, selectedRemoteName);
      if (!branchName || branchName === 'HEAD') {
        continue;
      }
      unique.add(branchName);
    }

    // When using detected upstream, include all upstream repo branches
    if (useDetectedUpstream) {
      for (const b of upstreamBranches) {
        if (b && b !== 'HEAD') {
          unique.add(b);
        }
      }
    }

    const defaultBase = normalizeBranchRef(baseBranch);
    if (defaultBase && defaultBase !== 'HEAD') {
      unique.add(defaultBase);
    }

    const currentTarget = normalizeBranchRef(targetBaseBranch);
    if (currentTarget && currentTarget !== 'HEAD') {
      unique.add(currentTarget);
    }

    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [baseBranch, remoteBranches, selectedRemote?.name, targetBaseBranch, upstreamBranches, useDetectedUpstream]);

  // Update selected remote when remotes change
  React.useEffect(() => {
    if (remotes.length === 0) {
      if (selectedRemote) {
        setSelectedRemote(null);
      }
      return;
    }

    if (!selectedRemote || !remotes.some((remote) => remote.name === selectedRemote.name)) {
      setSelectedRemote(
        pickInitialPrRemote(remotes, {
          selectedRemoteName: initialSnapshot?.selectedRemoteName,
          trackingBranch,
        })
      );
    }
  }, [initialSnapshot?.selectedRemoteName, remotes, selectedRemote, trackingBranch]);

  React.useEffect(() => {
    const normalizedBase = normalizeBranchRef(baseBranch);
    if (!targetBaseBranch && normalizedBase) {
      setTargetBaseBranch(normalizedBase);
      return;
    }

    if (availableBaseBranches.length === 0) {
      return;
    }

    if (!availableBaseBranches.includes(targetBaseBranch)) {
      const fallback = availableBaseBranches.includes(normalizedBase)
        ? normalizedBase
        : availableBaseBranches[0];
      if (fallback) {
        setTargetBaseBranch(fallback);
      }
    }
  }, [availableBaseBranches, baseBranch, targetBaseBranch]);

  const [checksDialogOpen, setChecksDialogOpen] = React.useState(false);
  const [checkDetails, setCheckDetails] = React.useState<GitHubPullRequestContextResult | null>(null);
  const [isLoadingCheckDetails, setIsLoadingCheckDetails] = React.useState(false);
  const [expandedCheckStepKeys, setExpandedCheckStepKeys] = React.useState<Set<string>>(new Set());
  const [commentsDialogOpen, setCommentsDialogOpen] = React.useState(false);
  const [commentsDetails, setCommentsDetails] = React.useState<GitHubPullRequestContextResult | null>(null);
  const [isLoadingCommentsDetails, setIsLoadingCommentsDetails] = React.useState(false);
  const [dialogPullRequestNumber, setDialogPullRequestNumber] = React.useState<number | null>(null);
  const [panelView, setPanelView] = React.useState<PullRequestPanelView>(DEFAULT_PULL_REQUEST_PANEL_VIEW);
  const [pullRequestListResult, setPullRequestListResult] = React.useState<GitHubPullRequestsListResult | null>(null);
  const [pullRequests, setPullRequests] = React.useState<GitHubPullRequestSummary[]>([]);
  const [pullRequestQuery, setPullRequestQuery] = React.useState('');
  const [pullRequestListPage, setPullRequestListPage] = React.useState(1);
  const [pullRequestListHasMore, setPullRequestListHasMore] = React.useState(false);
  const [isLoadingPullRequestList, setIsLoadingPullRequestList] = React.useState(false);
  const [isLoadingMorePullRequests, setIsLoadingMorePullRequests] = React.useState(false);
  const [pullRequestListError, setPullRequestListError] = React.useState<string | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] = React.useState<GitHubPullRequestSummary | null>(null);
  const [selectedPullRequestContext, setSelectedPullRequestContext] = React.useState<GitHubPullRequestContextResult | null>(null);
  const [isLoadingSelectedPullRequest, setIsLoadingSelectedPullRequest] = React.useState(false);
  const [selectedPullRequestError, setSelectedPullRequestError] = React.useState<string | null>(null);
  const pullRequestListScrollRef = React.useRef<HTMLDivElement | null>(null);
  const pullRequestListScrollTopRef = React.useRef(0);

  const attemptedBodyHydrationRef = React.useRef<Set<string>>(new Set());
  const bodyHydrationTrackerRef = React.useRef(new PrBodyHydrationTracker());
  const lastSyncedPrNumberRef = React.useRef<number | null>(null);
  const didUserOverrideRemoteRef = React.useRef(false);
  const autoRemoteProbeDoneRef = React.useRef<Set<string>>(new Set());
  const pendingActionRefreshTimersRef = React.useRef<number[]>([]);

  React.useEffect(() => {
    setPanelView(DEFAULT_PULL_REQUEST_PANEL_VIEW);
    setPullRequestListResult(null);
    setPullRequests([]);
    setPullRequestQuery('');
    setPullRequestListPage(1);
    setPullRequestListHasMore(false);
    setPullRequestListError(null);
    setSelectedPullRequest(null);
    setSelectedPullRequestContext(null);
    setSelectedPullRequestError(null);
    pullRequestListScrollTopRef.current = 0;
  }, [directory]);

  React.useLayoutEffect(() => {
    if (panelView === 'list' && pullRequestListScrollRef.current) {
      pullRequestListScrollRef.current.scrollTop = pullRequestListScrollTopRef.current;
    }
  }, [panelView]);

  // Auto-enable detected upstream when there's no explicit upstream remote
  React.useEffect(() => {
    if (detectedUpstream && !hasUpstreamRemote) {
      setUseDetectedUpstream(true);
    }
  }, [detectedUpstream, hasUpstreamRemote]);

  // Set target base branch to upstream's default branch when using detected upstream
  React.useEffect(() => {
    if (useDetectedUpstream && detectedUpstream?.defaultBranch) {
      setTargetBaseBranch(detectedUpstream.defaultBranch);
    }
  }, [useDetectedUpstream, detectedUpstream?.defaultBranch]);

  const pr = status?.pr ?? null;
  const sourceRepoKey = sourceRepo ? `${sourceRepo.owner}/${sourceRepo.repo}` : '';
  const currentPrNumber = pr?.number ?? null;
  const currentPrBody = pr?.body ?? null;
  const currentPrBodyHydrationKey = currentPrNumber !== null ? `${directory}#${sourceRepoKey}#${currentPrNumber}` : null;
  const isHydratingCurrentPrBody = Boolean(
    currentPrBodyHydrationKey && hydratingPrBodyRequest?.key === currentPrBodyHydrationKey,
  );

  const loadPullRequestList = React.useCallback(async (nextPage: number, replace: boolean) => {
    if (!github?.prsList) {
      setPullRequestListError(t('gitView.pr.list.runtimeUnavailable'));
      return;
    }

    if (replace) {
      setIsLoadingPullRequestList(true);
      setPullRequestListError(null);
    } else {
      setIsLoadingMorePullRequests(true);
    }

    try {
      const next = await github.prsList(directory, { page: nextPage, state: 'all' });
      setPullRequestListResult(next);
      setPullRequests((current) => (
        replace
          ? sortPullRequestsByUpdated(next.prs ?? [])
          : mergePullRequestPages(current, next.prs ?? [])
      ));
      setPullRequestListPage(next.page ?? nextPage);
      setPullRequestListHasMore(Boolean(next.hasMore));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (replace) {
        setPullRequestListError(message);
      } else {
        toast.error(t('gitView.pr.list.loadMoreFailed'), { description: message });
      }
    } finally {
      if (replace) {
        setIsLoadingPullRequestList(false);
      } else {
        setIsLoadingMorePullRequests(false);
      }
    }
  }, [directory, github, t]);

  const openPullRequestList = React.useCallback(() => {
    setPanelView((current) => nextPullRequestPanelView(current, 'show-list'));
    if (!pullRequestListResult && !isLoadingPullRequestList) {
      void loadPullRequestList(1, true);
    }
  }, [isLoadingPullRequestList, loadPullRequestList, pullRequestListResult]);

  React.useEffect(() => {
    if (panelView !== 'list' || pullRequestListResult || isLoadingPullRequestList || pullRequestListError) {
      return;
    }
    void loadPullRequestList(1, true);
  }, [isLoadingPullRequestList, loadPullRequestList, panelView, pullRequestListError, pullRequestListResult]);

  const loadSelectedPullRequest = React.useCallback(async (pullRequest: GitHubPullRequestSummary) => {
    if (!github?.prContext) {
      setSelectedPullRequestError(t('gitView.pr.list.runtimeUnavailable'));
      return;
    }

    setIsLoadingSelectedPullRequest(true);
    setSelectedPullRequestError(null);
    setSelectedPullRequestContext(null);
    try {
      const context = await github.prContext(directory, pullRequest.number, {
        includeDiff: false,
        includeCheckDetails: false,
        sourceRepo: pullRequest.sourceRepo,
      });
      if (context.connected === false) {
        setSelectedPullRequestError(t('gitView.pr.list.notConnected'));
        return;
      }
      if (!context.pr) {
        setSelectedPullRequestError(t('gitView.pr.list.notFound'));
        return;
      }
      setSelectedPullRequestContext(context);
    } catch (error) {
      setSelectedPullRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingSelectedPullRequest(false);
    }
  }, [directory, github, t]);

  const selectPullRequest = React.useCallback((pullRequest: GitHubPullRequestSummary) => {
    if (isCurrentPullRequestSelection(pr?.number ?? null, sourceRepo, pullRequest)) {
      setPanelView((current) => nextPullRequestPanelView(current, 'show-current'));
      return;
    }

    setSelectedPullRequest(pullRequest);
    setPanelView((current) => nextPullRequestPanelView(current, 'show-selected'));
    void loadSelectedPullRequest(pullRequest);
  }, [loadSelectedPullRequest, pr?.number, sourceRepo]);

  const filteredPullRequests = React.useMemo(() => {
    const query = pullRequestQuery.trim().toLowerCase();
    if (!query) {
      return pullRequests;
    }
    const normalizedNumber = query.replace(/^#/, '');
    return pullRequests.filter((pullRequest) => (
      String(pullRequest.number) === normalizedNumber
      || pullRequest.title.toLowerCase().includes(query)
    ));
  }, [pullRequestQuery, pullRequests]);

  React.useEffect(() => {
    if (!github?.prContext || currentPrNumber === null || !currentPrBodyHydrationKey) {
      return;
    }

    if (typeof currentPrBody === 'string' && currentPrBody.trim().length > 0) {
      return;
    }

    const hydrationKey = currentPrBodyHydrationKey;
    const attemptedBodyHydrations = attemptedBodyHydrationRef.current;
    const bodyHydrationTracker = bodyHydrationTrackerRef.current;
    if (attemptedBodyHydrations.has(hydrationKey)) {
      return;
    }
    attemptedBodyHydrations.add(hydrationKey);
    const request = bodyHydrationTracker.begin(hydrationKey);
    setHydratingPrBodyRequest(request);

    let cancelled = false;
    let failed = false;
    void github.prContext(directory, currentPrNumber, {
      includeDiff: false,
      includeCheckDetails: false,
      sourceRepo,
    })
      .then((ctx) => {
        if (cancelled) {
          return;
        }
        const ctxPr = ctx?.pr;
        if (!ctxPr) {
          return;
        }
        updatePrStatus(prStatusKey, (prev) => {
          if (!prev?.pr || prev.pr.number !== currentPrNumber) {
            return prev;
          }
          return {
            ...prev,
            pr: {
              ...prev.pr,
              body: ctxPr.body || '',
            },
          };
        });
      })
      .catch(() => {
        failed = true;
        attemptedBodyHydrations.delete(hydrationKey);
      })
      .finally(() => {
        if (failed || cancelled) {
          attemptedBodyHydrations.delete(hydrationKey);
        }
        if (bodyHydrationTracker.settle(request)) {
          setHydratingPrBodyRequest((current) => (current?.id === request.id ? null : current));
        }
      });

    return () => {
      cancelled = true;
      attemptedBodyHydrations.delete(hydrationKey);
      if (bodyHydrationTracker.cancel(request)) {
        setHydratingPrBodyRequest((current) => (current?.id === request.id ? null : current));
      }
    };
  }, [bodyHydrationRetryVersion, currentPrBody, currentPrBodyHydrationKey, currentPrNumber, directory, github, prStatusKey, sourceRepo, sourceRepoKey, updatePrStatus]);

  React.useEffect(() => {
    if (!pr) {
      setIsEditingPr(false);
      setEditTitle('');
      setEditBody('');
      lastSyncedPrNumberRef.current = null;
      return;
    }

    const numberChanged =
      lastSyncedPrNumberRef.current !== null && lastSyncedPrNumberRef.current !== pr.number;

    if (numberChanged) {
      setIsEditingPr(false);
    }

    if (!isEditingPr || numberChanged) {
      setEditTitle(pr.title || '');
      setEditBody(pr.body || '');
    }

    lastSyncedPrNumberRef.current = pr.number;
  }, [isEditingPr, pr]);

  const openChecksDialogFor = React.useCallback(async (
    targetPullRequest: GitHubPullRequest,
    targetRepo: { owner: string; repo: string } | null,
  ) => {
    if (!github?.prContext) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }

    setChecksDialogOpen(true);
    setDialogPullRequestNumber(targetPullRequest.number);
    setExpandedCheckStepKeys(new Set());
    setIsLoadingCheckDetails(true);
    try {
      const ctx = await github.prContext(directory, targetPullRequest.number, {
        includeDiff: false,
        includeCheckDetails: true,
        sourceRepo: targetRepo,
      });
      setCheckDetails(ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.loadCheckDetailsFailed'), { description: message });
    } finally {
      setIsLoadingCheckDetails(false);
    }
  }, [directory, github, t]);

  const openChecksDialog = React.useCallback(async () => {
    if (!pr) return;
    await openChecksDialogFor(pr, sourceRepo);
  }, [openChecksDialogFor, pr, sourceRepo]);

  const openCommentsDialogFor = React.useCallback(async (
    targetPullRequest: GitHubPullRequest,
    targetRepo: { owner: string; repo: string } | null,
  ) => {
    if (!github?.prContext) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }

    setCommentsDialogOpen(true);
    setDialogPullRequestNumber(targetPullRequest.number);
    setIsLoadingCommentsDetails(true);
    try {
      const ctx = await github.prContext(directory, targetPullRequest.number, {
        includeDiff: false,
        includeCheckDetails: false,
        sourceRepo: targetRepo,
      });
      setCommentsDetails(ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.loadCommentsFailed'), { description: message });
    } finally {
      setIsLoadingCommentsDetails(false);
    }
  }, [directory, github, t]);

  const openCommentsDialog = React.useCallback(async () => {
    if (!pr) return;
    await openCommentsDialogFor(pr, sourceRepo);
  }, [openCommentsDialogFor, pr, sourceRepo]);

  const formatTimestamp = React.useCallback((value?: string) => {
    if (!value) return '';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) {
      return value;
    }
    return new Date(ts).toLocaleString();
  }, []);

  const connectedGitHubLogin = React.useMemo(() => {
    const login = githubAuthStatus?.user?.login;
    return typeof login === 'string' ? login.trim() : '';
  }, [githubAuthStatus]);

  const selfMentionHighlightClass = React.useMemo(() => {
    return "[&_a[href*='oc-self-mention=1']]:!text-[var(--primary-base)] [&_a[href*='oc-self-mention=1']]:font-semibold [&_a[href*='oc-self-mention=1']]:!no-underline [&_a[href*='oc-self-mention=1']:hover]:!text-[var(--primary-hover)]";
  }, []);

  const linkifyMentionsMarkdown = React.useCallback((content: string) => {
    const selfLoginLower = connectedGitHubLogin.toLowerCase();
    const mentionRegex = /(^|[^\w`])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))/g;
    return content.replace(mentionRegex, (_match, prefix: string, username: string) => {
      const mention = `@${username}`;
      const usernameLower = username.toLowerCase();
      const selfTag = selfLoginLower && usernameLower === selfLoginLower ? '?oc-self-mention=1' : '';
      return `${prefix}[${mention}](https://github.com/${usernameLower}${selfTag})`;
    });
  }, [connectedGitHubLogin]);

  const timelineComments = React.useMemo<TimelineCommentItem[]>(() => {
    const issue = (commentsDetails?.issueComments ?? []).map((comment) => ({
      id: `issue-${comment.id}`,
      body: comment.body || '',
      authorName: comment.author?.name || comment.author?.login || t('gitView.pr.comments.unknownAuthor'),
      authorLogin: comment.author?.login || null,
      avatarUrl: comment.author?.avatarUrl || null,
      createdAt: comment.createdAt,
      context: t('gitView.pr.comments.generalContext'),
      path: null as string | null,
      line: null as number | null,
    }));

    const review = (commentsDetails?.reviewComments ?? []).map((comment) => ({
      id: `review-${comment.id}`,
      body: comment.body || '',
      authorName: comment.author?.name || comment.author?.login || t('gitView.pr.comments.unknownAuthor'),
      authorLogin: comment.author?.login || null,
      avatarUrl: comment.author?.avatarUrl || null,
      createdAt: comment.createdAt,
      context: t('gitView.pr.comments.reviewContext'),
      path: comment.path || null,
      line: comment.line ?? null,
    }));

    const all = [...issue, ...review];
    all.sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
      const aVal = Number.isFinite(aTs) ? aTs : 0;
      const bVal = Number.isFinite(bTs) ? bTs : 0;
      return aVal - bVal;
    });
    return all;
  }, [commentsDetails, t]);

  const resolveChatDispatchTarget = React.useCallback((): ChatDispatchTarget | null => {
    if (!currentSessionId) {
      toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
      return null;
    }

    const { currentProviderId, currentModelId, currentAgentName, currentVariant } = useConfigStore.getState();
    const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
    const providerID = currentProviderId || lastUsedProvider?.providerID;
    const modelID = currentModelId || lastUsedProvider?.modelID;
    if (!providerID || !modelID) {
      toast.error(t('gitView.pr.toast.noModelSelected'));
      return null;
    }

    return {
      sessionId: currentSessionId,
      providerID,
      modelID,
      currentAgentName: currentAgentName ?? null,
      currentVariant: currentVariant ?? null,
    };
  }, [currentSessionId, t]);

  const dispatchSyntheticPrompt = React.useCallback((
    target: ChatDispatchTarget,
    visibleText: string,
    instructionsText: string,
    payloadText: string,
  ) => {
    void useSessionUIStore.getState().sendMessage(
      visibleText,
      target.providerID,
      target.modelID,
      target.currentAgentName ?? undefined,
      undefined,
      undefined,
      [
        { text: instructionsText, synthetic: true },
        { text: payloadText, synthetic: true },
      ],
      target.currentVariant ?? undefined,
    ).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.sendMessageFailed'), { description: message });
    });
  }, [t]);

  const renderCheckRunSummary = React.useCallback((run: GitHubCheckRun) => {
    const status = run.status || 'unknown';
    const conclusion = run.conclusion ?? undefined;
    const statusText = conclusion ? `${status} / ${conclusion}` : status;
    const appName = run.app?.name || run.app?.slug;
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground truncate">{run.name}</div>
            <div className="typography-micro text-muted-foreground truncate">
              {appName ? `${appName} · ${statusText}` : statusText}
            </div>
          </div>

          {run.detailsUrl ? (
            <Button variant="outline" size="sm" asChild className="flex-shrink-0">
              <a href={run.detailsUrl} target="_blank" rel="noopener noreferrer">
                <RiExternalLinkLine className="size-4" />
                Open
              </a>
            </Button>
          ) : null}
        </div>

        {run.output?.title ? (
          <div className="typography-micro text-foreground">{run.output.title}</div>
        ) : null}
        {run.output?.summary ? (
          <div className="typography-micro text-muted-foreground whitespace-pre-wrap">
            {run.output.summary}
          </div>
        ) : null}
        {run.output?.text ? (
          <div className="rounded border border-border/40 bg-transparent px-2 py-2 typography-micro text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
            {run.output.text}
          </div>
        ) : null}

        {Array.isArray(run.annotations) && run.annotations.length > 0 ? (
          <div className="space-y-1">
            <div className="typography-micro text-muted-foreground">
              Failed annotations{run.annotations.length > 20 ? ` (showing 20/${run.annotations.length})` : ''}
            </div>
            <div className="space-y-1">
              {run.annotations.slice(0, 20).map((annotation, idx) => (
                <div key={`${annotation.path || 'file'}:${annotation.startLine || idx}:${idx}`} className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-2 py-2">
                  <div className="typography-micro text-[var(--status-error)]">
                    {annotation.title || annotation.level || 'Issue'}
                    {annotation.path ? ` · ${annotation.path}` : ''}
                    {typeof annotation.startLine === 'number' ? `:${annotation.startLine}` : ''}
                    {typeof annotation.endLine === 'number' && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}
                  </div>
                  <div className="typography-micro text-foreground whitespace-pre-wrap mt-1">
                    {annotation.message}
                  </div>
                  {annotation.rawDetails ? (
                    <div className="typography-micro text-muted-foreground whitespace-pre-wrap mt-1">
                      {annotation.rawDetails}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {run.job?.steps && run.job.steps.length > 0 ? (
          <div className="space-y-1">
            <div className="typography-micro text-muted-foreground">{t('gitView.pr.checks.steps')}</div>
            <div className="space-y-1">
              {run.job.steps.map((step, idx) => {
                const c = (step.conclusion || '').toLowerCase();
                const isFail = c && !['success', 'neutral', 'skipped'].includes(c);
                const stepKey = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${step.number ?? idx}:${step.name}`;
                const stepExpanded = expandedCheckStepKeys.has(stepKey);
                if (!isFail) {
                  return (
                    <div
                      key={stepKey}
                      className="typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-muted-foreground"
                    >
                      <span className="truncate">{step.name}</span>
                      {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                    </div>
                  );
                }
                return (
                  <Collapsible key={stepKey} open={stepExpanded}>
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedCheckStepKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(stepKey)) {
                            next.delete(stepKey);
                          } else {
                            next.add(stepKey);
                          }
                          return next;
                        });
                      }}
                      className={
                        'typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-left ' +
                        (isFail ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground')
                      }
                    >
                      {stepExpanded ? <RiArrowDownSLine className="size-4" /> : <RiArrowRightSLine className="size-4" />}
                      <span className="truncate">{step.name}</span>
                      {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                    </button>
                    <CollapsibleContent>
                      <div className="ml-6 mt-1 rounded border border-border/40 bg-transparent px-2 py-2 typography-micro text-muted-foreground space-y-1">
                        {typeof step.number === 'number' ? <div>{t('gitView.pr.checks.stepLabel')}: {step.number}</div> : null}
                        {step.status ? <div>{t('gitView.pr.checks.statusLabel')}: {step.status}</div> : null}
                        {step.conclusion ? <div>{t('gitView.pr.checks.conclusionLabel')}: {step.conclusion}</div> : null}
                        {step.startedAt ? <div>{t('gitView.pr.checks.startedLabel')}: {formatTimestamp(step.startedAt)}</div> : null}
                        {step.completedAt ? <div>{t('gitView.pr.checks.completedLabel')}: {formatTimestamp(step.completedAt)}</div> : null}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [expandedCheckStepKeys, formatTimestamp, t]);

  const sendFailedChecksToChat = React.useCallback(async () => {
    setActiveMainTab('chat');

    if (!github?.prContext) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }
    if (!directory || !pr) return;
    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    try {
      const context = await github.prContext(directory, pr.number, {
        includeDiff: false,
        includeCheckDetails: true,
        sourceRepo,
      });
      const runs = context.checkRuns ?? [];
      const failed = runs.filter((r) => {
        const conclusion = typeof r.conclusion === 'string' ? r.conclusion.toLowerCase() : '';
        if (!conclusion) return false;
        return !['success', 'neutral', 'skipped'].includes(conclusion);
      });

      if (failed.length === 0) {
        toast.message(t('gitView.pr.toast.noFailedChecks'));
        return;
      }

      const visibleText = await renderMagicPrompt('github.pr.checks.review.visible');
      const instructionsText = await renderMagicPrompt('github.pr.checks.review.instructions');
      const failedAnnotations = failed.flatMap((run) => {
        const annotations = Array.isArray(run.annotations) ? run.annotations : [];
        return annotations.map((annotation) => ({
          run: run.name,
          level: annotation.level,
          title: annotation.title,
          path: annotation.path,
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          message: annotation.message,
          rawDetails: annotation.rawDetails,
        }));
      });
      const payloadText = `GitHub PR failed checks (JSON)\n${JSON.stringify({
        repo: context.repo ?? null,
        pr: context.pr ?? null,
        failedChecks: failed,
        failedAnnotations,
      }, null, 2)}`;

      dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.loadChecksFailed'), { description: message });
    }
  }, [directory, dispatchSyntheticPrompt, github, pr, resolveChatDispatchTarget, setActiveMainTab, sourceRepo, t]);

  const sendCommentsToChat = React.useCallback(async () => {
    setActiveMainTab('chat');

    if (!github?.prContext) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }
    if (!directory || !pr) return;
    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    try {
      const context = await github.prContext(directory, pr.number, {
        includeDiff: false,
        includeCheckDetails: false,
        sourceRepo,
      });
      const issueComments = context.issueComments ?? [];
      const reviewComments = context.reviewComments ?? [];
      const total = issueComments.length + reviewComments.length;
      if (total === 0) {
        toast.message(t('gitView.pr.toast.noPrComments'));
        return;
      }

      const visibleText = await renderMagicPrompt('github.pr.comments.review.visible');
      const instructionsText = await renderMagicPrompt('github.pr.comments.review.instructions');
      const payloadText = `GitHub PR comments (JSON)\n${JSON.stringify({
        repo: context.repo ?? null,
        pr: context.pr ?? null,
        issueComments,
        reviewComments,
      }, null, 2)}`;

      dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.loadPrCommentsFailed'), { description: message });
    }
  }, [directory, dispatchSyntheticPrompt, github, pr, resolveChatDispatchTarget, setActiveMainTab, sourceRepo, t]);

  const sendSingleCommentToChat = React.useCallback(async (comment: TimelineCommentItem) => {
    setCommentsDialogOpen(false);
    setActiveMainTab('chat');

    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    const visibleText = await renderMagicPrompt('github.pr.comment.single.visible');
    const instructionsText = await renderMagicPrompt('github.pr.comment.single.instructions');
    const payloadText = `GitHub PR comment (JSON)\n${JSON.stringify({
      repo: commentsDetails?.repo ?? null,
      pr: commentsDetails?.pr ?? pr ?? null,
      comment,
    }, null, 2)}`;

    dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
  }, [commentsDetails, dispatchSyntheticPrompt, pr, resolveChatDispatchTarget, setActiveMainTab]);

  const refresh = React.useCallback(async (options?: { force?: boolean; onlyExistingPr?: boolean; silent?: boolean; markInitialResolved?: boolean }) => {
    if (options?.force && currentPrBodyHydrationKey && !currentPrBody?.trim()) {
      attemptedBodyHydrationRef.current.delete(currentPrBodyHydrationKey);
      setBodyHydrationRetryVersion((version) => version + 1);
    }
    await refreshPrStatus(prStatusKey, options);
  }, [currentPrBody, currentPrBodyHydrationKey, prStatusKey, refreshPrStatus]);

  const scheduleActionRefresh = React.useCallback(() => {
    pendingActionRefreshTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    pendingActionRefreshTimersRef.current = PR_ACTION_REFRESH_DELAYS_MS.map((delayMs) => window.setTimeout(() => {
      void refresh({ force: true, silent: true, markInitialResolved: true });
    }, delayMs));
  }, [refresh]);

  React.useEffect(() => {
    if (!github?.prStatus || !canShow || remotes.length <= 1) {
      return;
    }
    if (didUserOverrideRemoteRef.current) {
      return;
    }
    if (status?.pr) {
      return;
    }

    const probeKey = `${snapshotKey}::${selectedRemote?.name ?? ''}`;
    if (autoRemoteProbeDoneRef.current.has(probeKey)) {
      return;
    }
    autoRemoteProbeDoneRef.current.add(probeKey);

    const candidates = rankRemotesForAutoSelect(remotes, trackingBranch)
      .filter((remote) => remote.name !== selectedRemote?.name);
    if (candidates.length === 0) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      for (const candidate of candidates) {
        if (cancelled) {
          return;
        }
        try {
          const next = await github.prStatus(directory, branch, candidate.name);
          if (!next?.pr) {
            continue;
          }
          if (cancelled) {
            return;
          }
          setSelectedRemote((prev) => (prev?.name === candidate.name ? prev : candidate));
          return;
        } catch {
          // ignore
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [branch, canShow, directory, github, remotes, selectedRemote?.name, snapshotKey, status?.pr, trackingBranch]);

  React.useEffect(() => {
    ensurePrStatusEntry(prStatusKey);
    setPrStatusParams(prStatusKey, {
      directory,
      branch,
      remoteName: selectedRemote?.name ?? null,
      canShow,
      github,
      githubAuthChecked,
      githubConnected: githubAuthStatus?.connected ?? null,
    });
  }, [
    branch,
    canShow,
    directory,
    ensurePrStatusEntry,
    github,
    githubAuthChecked,
    githubAuthStatus?.connected,
    prStatusKey,
    selectedRemote?.name,
    setPrStatusParams,
  ]);

  React.useEffect(() => {
    startPrStatusWatching(prStatusKey);
    return () => {
      stopPrStatusWatching(prStatusKey);
    };
  }, [prStatusKey, startPrStatusWatching, stopPrStatusWatching]);

  React.useEffect(() => {
    const snapshot = pullRequestDraftSnapshots.get(snapshotKey) ?? null;
    setTitle(snapshot?.title ?? branchToTitle(branch));
    setBody(snapshot?.body ?? '');
    setDraft(snapshot?.draft ?? false);
    setAdditionalContext(snapshot?.additionalContext ?? '');
    setNextPrFromTerminalNumber(snapshot?.nextPrFromTerminalNumber ?? null);
    setTargetBaseBranch(snapshot?.targetBaseBranch ? normalizeBranchRef(snapshot.targetBaseBranch) : normalizeBranchRef(baseBranch));
    const nextRemote = pickInitialPrRemote(remotes, {
      selectedRemoteName: snapshot?.selectedRemoteName,
      trackingBranch,
    });
    setSelectedRemote((prev) => (prev?.name === nextRemote?.name ? prev : nextRemote));
  }, [baseBranch, branch, remotes, snapshotKey, trackingBranch]);

  React.useEffect(() => {
    void refresh({ markInitialResolved: true });
  }, [prStatusKey, refresh]);

  React.useEffect(() => {
    if (!canShow || !selectedRemote?.name) {
      return;
    }
    void refresh({ force: true, silent: true, markInitialResolved: true });
  }, [canShow, refresh, selectedRemote?.name]);

  React.useEffect(() => {
    const resolvedRemoteName = status?.resolvedRemoteName?.trim();
    if (!resolvedRemoteName || didUserOverrideRemoteRef.current) {
      return;
    }
    const resolvedRemote = remotes.find((candidate) => candidate.name === resolvedRemoteName);
    if (!resolvedRemote) {
      return;
    }
    setSelectedRemote((prev) => (prev?.name === resolvedRemote.name ? prev : resolvedRemote));
  }, [remotes, status?.resolvedRemoteName]);

  React.useEffect(() => {
    const isTerminal = status?.pr?.state === 'closed' || status?.pr?.state === 'merged';
    const lastRefreshAt = statusEntry?.lastRefreshAt ?? 0;
    const staleAfter = isTerminal ? PR_TERMINAL_DISCOVERY_INTERVAL_MS : 60_000;

    const onFocus = () => {
      if (Date.now() - lastRefreshAt > staleAfter) {
        void refresh({ force: true, silent: true });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastRefreshAt > staleAfter) {
          void refresh({ force: true, silent: true });
        }
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, status?.pr?.state, statusEntry?.lastRefreshAt]);

  React.useEffect(() => {
    if (shouldClearNextPullRequestDraft(nextPrFromTerminalNumber, pr?.state)) {
      setNextPrFromTerminalNumber(null);
      setTitle(branchToTitle(branch));
      setBody('');
      setDraft(false);
      setAdditionalContext('');
    }
  }, [branch, nextPrFromTerminalNumber, pr?.state]);

  React.useEffect(() => {
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      void refresh({ force: true, silent: true, markInitialResolved: true });
    }
  }, [githubAuthChecked, githubAuthStatus, refresh]);

  React.useEffect(() => {
    if (!directory || !branch) {
      return;
    }
    pullRequestDraftSnapshots.set(snapshotKey, {
      title,
      body,
      draft,
      additionalContext,
      targetBaseBranch,
      selectedRemoteName: selectedRemote?.name,
      ...(nextPrFromTerminalNumber !== null ? { nextPrFromTerminalNumber } : {}),
    });
  }, [snapshotKey, title, body, draft, additionalContext, targetBaseBranch, selectedRemote?.name, nextPrFromTerminalNumber, directory, branch]);

  React.useEffect(() => {
    const pendingActionRefreshTimers = pendingActionRefreshTimersRef.current;
    return () => {
      pendingActionRefreshTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      pendingActionRefreshTimersRef.current = [];
    };
  }, []);

  // Lets the failure toast's Retry action call the latest generateDescription
  // without the callback having to reference itself.
  const generateDescriptionRef = React.useRef<() => Promise<void>>(async () => {});

  const generateDescription = React.useCallback(async () => {
    if (isGenerating) return;
    if (!directory) return;
    setIsGenerating(true);
    try {
      // For cross-repo PRs, use the upstream's default branch SHA for the commit range.
      // Using a bare branch name like "main" would resolve to the local ref, making
      // "git log main..main" a no-op. The SHA points to the actual upstream commit.
      const baseRef = (useDetectedUpstream && detectedUpstream?.defaultBranchSha)
        ? detectedUpstream.defaultBranchSha
        : targetBaseBranch;
      const payload: { base: string; head: string; context?: string; files?: string[] } = {
        base: baseRef,
        head: branch,
      };
      if (additionalContext) {
        payload.context = additionalContext;
      }
      const generated = await generatePullRequestDescription(directory, payload);
      const nextTitle = generated.title?.trim() ?? '';
      const nextBody = generated.body?.trim() ?? '';
      if (!nextTitle && !nextBody) {
        throw new Error('The model returned an empty pull request description');
      }

      // Replace both fields from the response so a fresh title never sits next
      // to a stale body (or vice versa).
      setTitle(nextTitle);
      setBody(nextBody);
      if (!nextTitle || !nextBody) {
        toast.warning(t('gitView.pr.toast.generateDescriptionPartial'), {
          description: t(nextTitle
            ? 'gitView.pr.toast.generateDescriptionPartialBody'
            : 'gitView.pr.toast.generateDescriptionPartialTitle'),
        });
      }
      onGeneratedDescription?.();
    } catch (e) {
      if (isGitGenerationCancelledError(e)) {
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      const code = readGenerationErrorCode(e);
      const causeKey = code ? GENERATE_DESCRIPTION_CAUSE_KEYS[code] : undefined;
      toast.error(t('gitView.pr.toast.generateDescriptionFailed'), {
        description: causeKey ? `${t(causeKey)} ${message}` : message,
        action: {
          label: t('gitView.pr.toast.generateDescriptionRetry'),
          onClick: () => {
            void generateDescriptionRef.current();
          },
        },
      });
    } finally {
      setIsGenerating(false);
    }
  }, [additionalContext, branch, detectedUpstream?.defaultBranchSha, directory, isGenerating, onGeneratedDescription, targetBaseBranch, t, useDetectedUpstream]);

  React.useEffect(() => {
    generateDescriptionRef.current = generateDescription;
  }, [generateDescription]);

  const startNextPr = React.useCallback(() => {
    if (!pr || (pr.state !== 'closed' && pr.state !== 'merged')) {
      return;
    }
    const nextDraft = createNextPullRequestDraft(branch, pr.number, branchToTitle);
    setNextPrFromTerminalNumber(nextDraft.terminalPrNumber);
    setTitle(nextDraft.title);
    setBody(nextDraft.body);
    setDraft(nextDraft.draft);
    setAdditionalContext(nextDraft.additionalContext);
    setIsEditingPr(false);
  }, [branch, pr]);

  const openCurrentPullRequest = React.useCallback(() => {
    if (pr?.state === 'closed' || pr?.state === 'merged') {
      startNextPr();
    }
    setPanelView((current) => nextPullRequestPanelView(current, 'show-current'));
  }, [pr?.state, startNextPr]);

  const createPr = React.useCallback(async () => {
    if (!github?.prCreate) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t('gitView.pr.toast.titleRequired'));
      return;
    }

    const trimmedBase = targetBaseBranch.trim();
    if (!trimmedBase) {
      toast.error(t('gitView.pr.toast.baseBranchRequired'));
      return;
    }
    if (!useDetectedUpstream && trimmedBase === branch) {
      toast.error(t('gitView.pr.toast.baseMustDifferFromHead'));
      return;
    }

    setIsCreating(true);
    try {
      const trackingRemoteName = getTrackingRemoteName(trackingBranch);

      const usingDetectedUpstream = useDetectedUpstream && detectedUpstream;

      const pr = await github.prCreate({
        directory,
        title: trimmedTitle,
        head: branch,
        base: trimmedBase,
        ...(body.trim() ? { body } : {}),
        draft,
        ...(usingDetectedUpstream
          ? { targetRepo: { owner: detectedUpstream.owner, repo: detectedUpstream.repo }, headRemote: 'origin' }
          : {
              ...(selectedRemote ? { remote: selectedRemote.name } : {}),
              ...(trackingRemoteName && trackingRemoteName !== selectedRemote?.name
                ? { headRemote: trackingRemoteName }
                : {}),
            }),
      });
      toast.success(t('gitView.pr.toast.prCreated'));
      setNextPrFromTerminalNumber(null);
      setTitle(branchToTitle(branch));
      setBody('');
      setDraft(false);
      setAdditionalContext('');
      updatePrStatus(prStatusKey, (prev) => (prev ? { ...prev, pr } : prev));
      await refresh({ force: true });
      scheduleActionRefresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.createPrFailed'), { description: message });
    } finally {
      setIsCreating(false);
    }
  }, [body, branch, detectedUpstream, directory, draft, github, prStatusKey, refresh, scheduleActionRefresh, selectedRemote, targetBaseBranch, title, trackingBranch, updatePrStatus, useDetectedUpstream, t]);

  const mergePr = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prMerge) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }
    setIsMerging(true);
    try {
      const result = await github.prMerge({ directory, number: pr.number, method: mergeMethod });
      if (result.merged) {
        toast.success(t('gitView.pr.toast.prMerged'));
      } else {
        toast.message(t('gitView.pr.toast.prNotMerged'), { description: result.message || t('gitView.pr.notMergeable') });
      }
      await refresh({ force: true });
      scheduleActionRefresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.mergeFailed'), { description: message });
      if (pr.url) {
        void openExternal(pr.url);
      }
    } finally {
      setIsMerging(false);
    }
  }, [directory, github, mergeMethod, refresh, scheduleActionRefresh, t]);

  const markReady = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prReady) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }
    setIsMarkingReady(true);
    try {
      await github.prReady({ directory, number: pr.number });
      toast.success(t('gitView.pr.toast.markedReady'));
      await refresh({ force: true });
      scheduleActionRefresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.markReadyFailed'), { description: message });
      if (pr.url) {
        void openExternal(pr.url);
      }
    } finally {
      setIsMarkingReady(false);
    }
  }, [directory, github, refresh, scheduleActionRefresh, t]);

  const updatePr = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prUpdate) {
      toast.error(t('gitView.pr.toast.githubApiUnavailable'));
      return;
    }

    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      toast.error(t('gitView.pr.toast.titleRequired'));
      return;
    }

    setIsUpdating(true);
    try {
      const updated = await github.prUpdate({
        directory,
        number: pr.number,
        title: trimmedTitle,
        body: editBody,
      });
      updatePrStatus(prStatusKey, (prev) => (prev
        ? {
            ...prev,
            pr: {
              ...(prev.pr ?? pr),
              ...updated,
            },
          }
        : prev));
      setIsEditingPr(false);
      toast.success(t('gitView.pr.toast.prUpdated'));
      await refresh({ force: true });
      scheduleActionRefresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.updatePrFailed'), { description: message });
    } finally {
      setIsUpdating(false);
    }
  }, [directory, editBody, editTitle, github, prStatusKey, refresh, scheduleActionRefresh, updatePrStatus, t]);

  if (!canShow && panelView === 'current') {
    return (
      <section className="border-0 bg-transparent rounded-none">
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-fit gap-1 px-1 text-muted-foreground"
          onClick={openPullRequestList}
        >
          <RiArrowLeftLine className="size-4" />
          {t('gitView.pr.list.back')}
        </Button>
        <div className="space-y-1 pt-3">
          <div className="typography-ui-header font-semibold text-foreground">{t('gitView.pullRequest.title')}</div>
          <div className="typography-micro text-muted-foreground">
            {t('gitView.pullRequest.availableOnFeatureBranches')}
          </div>
        </div>
      </section>
    );
  }

  const originRepoUrl = status?.repo?.url || null;
  const repoUrl = (useDetectedUpstream && detectedUpstream?.url) ? detectedUpstream.url : originRepoUrl;
  const checks = status?.checks ?? null;
  const showChecks = shouldShowPullRequestChecks(checks);
  const canMerge = Boolean(status?.canMerge);
  const isConnected = Boolean(status?.connected);
  const shouldShowConnectionNotice = githubAuthChecked && status?.connected === false;
  const prVisualState = getPrVisualState(status);
  const isTerminalPr = pr?.state === 'closed' || pr?.state === 'merged';
  const showPullRequestDetails = shouldShowPullRequestDetails(pr?.state);
  const isStartingNextPr = Boolean(
    isTerminalPr && pr && nextPrFromTerminalNumber === pr.number,
  );
  const prColorVar = prVisualState ? `var(--pr-${prVisualState})` : 'var(--status-info)';
  const PrStateIcon = prVisualState === 'draft'
    ? RiGitPrDraftLine
    : prVisualState === 'merged'
      ? RiGitMergeLine
      : prVisualState === 'closed'
        ? RiGitClosePullRequestLine
        : RiGitPullRequestLine;
  const prStatusText = pr
    ? [
        `${formatPullRequestStatus(pr.state)}${pr.draft ? ` (${formatPullRequestStatus('draft')})` : ''}`,
        pr.mergeable === false ? t('gitView.pr.notMergeable') : null,
        pr.state === 'open' && typeof pr.mergeableState === 'string' && pr.mergeableState && pr.mergeableState !== 'unknown'
          ? formatPullRequestStatus(pr.mergeableState)
          : null,
      ].filter(Boolean).join(' · ')
    : '';
  const checksText = checks
    ? `${checks.success}/${checks.total} ${t('gitView.pr.checks.label')}`
    : '';
  const displayedSelectedPullRequest = selectedPullRequestContext?.pr ?? selectedPullRequest;
  const selectedChecks = selectedPullRequestContext?.checks ?? null;
  const showSelectedChecks = shouldShowPullRequestChecks(selectedChecks);
  const selectedRepo = selectedPullRequest?.sourceRepo
    ? { owner: selectedPullRequest.sourceRepo.owner, repo: selectedPullRequest.sourceRepo.repo }
    : selectedPullRequestContext?.repo
      ? { owner: selectedPullRequestContext.repo.owner, repo: selectedPullRequestContext.repo.repo }
      : null;
  const selectedVisualState = displayedSelectedPullRequest
    ? getPrVisualState({
        connected: true,
        pr: displayedSelectedPullRequest,
        checks: selectedChecks,
      })
    : null;
  const selectedColorVar = selectedVisualState ? `var(--pr-${selectedVisualState})` : 'var(--status-info)';
  const SelectedPrStateIcon = selectedVisualState === 'draft'
    ? RiGitPrDraftLine
    : selectedVisualState === 'merged'
      ? RiGitMergeLine
      : selectedVisualState === 'closed'
        ? RiGitClosePullRequestLine
        : RiGitPullRequestLine;
  const selectedStatusText = displayedSelectedPullRequest
    ? [
        `${formatPullRequestStatus(displayedSelectedPullRequest.state)}${displayedSelectedPullRequest.draft ? ` (${formatPullRequestStatus('draft')})` : ''}`,
        displayedSelectedPullRequest.mergeable === false ? t('gitView.pr.notMergeable') : null,
        displayedSelectedPullRequest.state === 'open'
          && typeof displayedSelectedPullRequest.mergeableState === 'string'
          && displayedSelectedPullRequest.mergeableState
          && displayedSelectedPullRequest.mergeableState !== 'unknown'
          ? formatPullRequestStatus(displayedSelectedPullRequest.mergeableState)
          : null,
      ].filter(Boolean).join(' · ')
    : '';
  const containerClassName = 'border-0 bg-transparent rounded-none';
  const headerClassName = 'px-0 py-3 border-b border-border/40 flex flex-col gap-1';
  const bodyClassName = 'flex flex-col gap-3 py-3';
  const currentBranchActionLabel = pr?.state === 'open'
    ? t('gitView.pr.actions.viewCurrentPr', { number: pr.number })
    : t('gitView.pr.actions.createPr');
  const isCurrentBranchActionLoading = canShow && !isInitialStatusResolved;
  const currentBranchActionButton = (
    <Button
      size="sm"
      className="h-7 shrink-0 gap-1.5 px-2"
      onClick={openCurrentPullRequest}
      disabled={!canShow || isCurrentBranchActionLoading}
    >
      {isCurrentBranchActionLoading
        ? <RiLoader4Line className="size-4 animate-spin" />
        : <RiGitPullRequestLine className="size-4" />}
      {currentBranchActionLabel}
    </Button>
  );

  return (
    <section className={containerClassName}>
      {panelView === 'list' ? (
        <div className="flex flex-col gap-3 py-3">
          <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-3">
            <h3 className="min-w-0 typography-ui-header font-semibold text-foreground">{t('gitView.pr.list.title')}</h3>
            <div className="flex shrink-0 items-center gap-1">
              {canShow ? currentBranchActionButton : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex"
                      tabIndex={0}
                      aria-label={t('gitView.pr.actions.creationUnavailableAria')}
                    >
                      {currentBranchActionButton}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent><p>{t('gitView.pullRequest.availableOnFeatureBranches')}</p></TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0"
                    onClick={() => void loadPullRequestList(1, true)}
                    disabled={isLoadingPullRequestList}
                    aria-label={t('gitView.pr.list.refreshAria')}
                  >
                    {isLoadingPullRequestList
                      ? <RiLoader4Line className="size-4 animate-spin" />
                      : <RiRefreshLine className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>{t('gitView.pr.list.refresh')}</p></TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="relative">
            <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pullRequestQuery}
              onChange={(event) => setPullRequestQuery(event.target.value)}
              placeholder={t('gitView.pr.list.searchPlaceholder')}
              className="h-8 pl-8"
            />
          </div>

          <div
            ref={pullRequestListScrollRef}
            className="max-h-[calc(100vh-15rem)] min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1"
            onScroll={(event) => {
              pullRequestListScrollTopRef.current = event.currentTarget.scrollTop;
            }}
          >
            {pullRequestListResult?.connected === false ? (
              <div className="space-y-2 py-8 text-center">
                <p className="typography-small text-muted-foreground">{t('gitView.pr.list.notConnected')}</p>
                {canManageGitHubAccounts ? (
                  <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                    {t('gitView.pr.actions.openSettings')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {pullRequestListError ? (
              <div className="space-y-2 py-8 text-center">
                <p className="typography-small break-words text-muted-foreground">{pullRequestListError}</p>
                <Button variant="outline" size="sm" onClick={() => void loadPullRequestList(1, true)}>
                  {t('gitView.pr.list.retry')}
                </Button>
              </div>
            ) : null}

            {isLoadingPullRequestList && pullRequests.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 typography-small text-muted-foreground">
                <RiLoader4Line className="size-4 animate-spin" />
                {t('gitView.pr.list.loading')}
              </div>
            ) : null}

            {!isLoadingPullRequestList
              && !pullRequestListError
              && pullRequestListResult?.connected !== false
              && filteredPullRequests.length === 0 ? (
                <div className="py-8 text-center typography-small text-muted-foreground">
                  {pullRequestQuery.trim() ? t('gitView.pr.list.noMatches') : t('gitView.pr.list.empty')}
                </div>
              ) : null}

            {filteredPullRequests.map((pullRequest) => {
              const stateLabel = pullRequest.draft ? t('gitView.pr.list.draft') : formatPullRequestStatus(pullRequest.state);
              const stateColor = pullRequest.state === 'merged'
                ? 'var(--pr-merged)'
                : pullRequest.state === 'closed'
                  ? 'var(--pr-closed)'
                  : pullRequest.draft
                    ? 'var(--pr-draft)'
                    : 'var(--pr-open)';
              return (
                <button
                  type="button"
                  key={pullRequestIdentity(pullRequest)}
                  className="group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-interactive-hover/40"
                  onClick={() => selectPullRequest(pullRequest)}
                >
                  <span className="mt-1 size-2 shrink-0 rounded-full" style={{ backgroundColor: stateColor }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate typography-ui-label font-medium text-foreground">
                      <span className="mr-1 text-muted-foreground">#{pullRequest.number}</span>
                      {pullRequest.title}
                    </span>
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 typography-meta text-muted-foreground">
                      <span style={{ color: stateColor }}>{stateLabel}</span>
                      <span className="truncate">{pullRequest.head} → {pullRequest.base}</span>
                      {pullRequest.sourceRepo?.source === 'upstream' ? (
                        <span className="truncate">{pullRequest.sourceRepo.owner}/{pullRequest.sourceRepo.repo}</span>
                      ) : null}
                    </span>
                  </span>
                  <RiArrowRightSLine className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              );
            })}

            {pullRequestListHasMore && pullRequestListResult?.connected !== false ? (
              <div className="flex justify-center py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadPullRequestList(pullRequestListPage + 1, false)}
                  disabled={isLoadingMorePullRequests}
                >
                  {isLoadingMorePullRequests ? <RiLoader4Line className="size-4 animate-spin" /> : null}
                  {isLoadingMorePullRequests ? t('gitView.pr.list.loadingMore') : t('gitView.pr.list.loadMore')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : panelView === 'selected' ? (
        <div className="flex flex-col gap-3 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-fit gap-1 px-1 text-muted-foreground"
            onClick={() => setPanelView((current) => nextPullRequestPanelView(current, 'show-list'))}
          >
            <RiArrowLeftLine className="size-4" />
            {t('gitView.pr.list.back')}
          </Button>

          {isLoadingSelectedPullRequest ? (
            <div className="flex items-center justify-center gap-2 py-8 typography-small text-muted-foreground">
              <RiLoader4Line className="size-4 animate-spin" />
              {t('gitView.pr.list.loadingDetails')}
            </div>
          ) : selectedPullRequestError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="typography-small break-words text-muted-foreground">{selectedPullRequestError}</p>
              {selectedPullRequest ? (
                <Button variant="outline" size="sm" onClick={() => void loadSelectedPullRequest(selectedPullRequest)}>
                  {t('gitView.pr.list.retry')}
                </Button>
              ) : null}
            </div>
          ) : displayedSelectedPullRequest ? (
            <>
              <div className="flex flex-col gap-1 border-b border-border/40 pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <SelectedPrStateIcon className="size-4 shrink-0" style={{ color: selectedColorVar }} />
                    <h3 className="typography-ui-header font-semibold text-foreground">{t('gitView.pullRequest.title')}</h3>
                    <span className="typography-meta text-muted-foreground">#{displayedSelectedPullRequest.number}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0"
                    onClick={() => void openExternal(displayedSelectedPullRequest.url)}
                    aria-label={t('gitView.pr.actions.openOnGitHubAria')}
                  >
                    <RiExternalLinkLine className="size-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
                  <span style={{ color: selectedColorVar }}>{selectedStatusText}</span>
                  {showSelectedChecks && selectedChecks ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${statusColor(selectedChecks.state)}`} />
                      {selectedChecks.success}/{selectedChecks.total} {t('gitView.pr.checks.label')}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {showSelectedChecks && selectedChecks ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 px-0"
                        onClick={() => void openChecksDialogFor(displayedSelectedPullRequest, selectedRepo)}
                        aria-label={t('gitView.pr.actions.openChecksAria')}
                      >
                        <RiInformationLine className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent><p>{t('gitView.pr.actions.openChecks')}</p></TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 px-0"
                      onClick={() => void openCommentsDialogFor(displayedSelectedPullRequest, selectedRepo)}
                      aria-label={t('gitView.pr.actions.openCommentsAria')}
                    >
                      <RiChat4Line className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent><p>{t('gitView.pr.actions.openComments')}</p></TooltipContent>
                </Tooltip>
              </div>

              <div className="min-w-0">
                <div className="typography-markdown text-xl font-semibold leading-snug text-foreground break-words">
                  {displayedSelectedPullRequest.title}
                </div>
                {displayedSelectedPullRequest.body?.trim() ? (
                  <SimpleMarkdownRenderer
                    content={displayedSelectedPullRequest.body}
                    className="mt-1 typography-markdown-body text-muted-foreground break-words"
                  />
                ) : (
                  <div className="mt-1 typography-micro text-muted-foreground">{t('gitView.pr.noDescription')}</div>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 w-fit gap-1 px-1 text-muted-foreground"
            onClick={openPullRequestList}
          >
            <RiArrowLeftLine className="size-4" />
            {t('gitView.pr.list.back')}
          </Button>
      <div className={headerClassName}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {pr ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70 hover:bg-interactive-hover/60"
                    onClick={() => void openExternal(pr.url)}
                    aria-label={t('gitView.pr.actions.openOnGitHubAria')}
                  >
                    <PrStateIcon className="size-4 shrink-0" style={{ color: prColorVar }} />
                  </button>
                </TooltipTrigger>
                <TooltipContent><p>{t('gitView.pr.actions.openOnGitHub')}</p></TooltipContent>
              </Tooltip>
            ) : (
              <PrStateIcon className="size-4 shrink-0" style={{ color: 'var(--surface-muted-foreground)' }} />
            )}
            <h3 className="typography-ui-header font-semibold text-foreground truncate">{t('gitView.pullRequest.title')}</h3>
            {pr ? (
              <span className="typography-meta text-muted-foreground truncate">#{pr.number}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isLoading ? <RiLoader4Line className="size-4 animate-spin text-muted-foreground" /> : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded hover:bg-interactive-hover/60 disabled:opacity-40"
                  disabled={isLoading}
                  onClick={() => void refresh({ force: true })}
                  aria-label={t('gitView.pr.actions.refreshAria')}
                >
                  <RiRefreshLine className="size-3.5 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent><p>{t('gitView.pr.actions.refresh')}</p></TooltipContent>
            </Tooltip>
          </div>
        </div>

        {pr ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
            <span style={{ color: prColorVar }}>{prStatusText}</span>
            {showChecks && checks ? (
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${statusColor(checks.state)}`} />
                {checksText}
              </span>
            ) : null}
            {trackingBranch && selectedRemote && trackingBranch.split('/')[0] !== selectedRemote.name ? (
              <span className="min-w-0 truncate">
                {trackingBranch.split('/')[0]} → {selectedRemote.name}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={bodyClassName}>
        {shouldShowConnectionNotice ? (
          <div className="space-y-2">
              <div className="typography-meta text-muted-foreground">
                {canManageGitHubAccounts ? t('gitView.pr.githubNotConnected') : t('settings.github.accountManagement.adminRequired')}
              </div>
              {canManageGitHubAccounts && (
                <Button variant="outline" size="sm" onClick={openGitHubSettings} className="w-fit">
                  {t('gitView.pr.actions.openSettings')}
                </Button>
              )}
              </div>
            ) : null}

            {error ? (
              <div className="space-y-2">
                <div className="typography-ui-label text-foreground">{t('gitView.pr.statusUnavailable')}</div>
                <div className="typography-meta text-muted-foreground break-words">{error}</div>
                {repoUrl ? (
                  <Button variant="outline" size="sm" asChild className="w-fit">
                    <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                      <RiExternalLinkLine className="size-4" />
                      Open Repo
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {!pr && !isInitialStatusResolved && !error && !shouldShowConnectionNotice ? (
              <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                <RiLoader4Line className="size-4 animate-spin" />
                {t('gitView.pr.checkingStatus')}
              </div>
            ) : pr && !isStartingNextPr ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-3">
                  {showPullRequestDetails ? (
                    <div className="min-w-0">
                      {isEditingPr ? (
                        <div className="space-y-2">
                          <Input
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            placeholder={t('gitView.pr.placeholder.title')}
                            autoCorrect={hasTouchInput ? "on" : "off"}
                            autoCapitalize={hasTouchInput ? "sentences" : "off"}
                            spellCheck={hasTouchInput}
                          />
                          <Textarea
                            value={editBody}
                            onChange={(e) => setEditBody(e.target.value)}
                            className="min-h-[120px] bg-background/80"
                            placeholder={t('gitView.pr.placeholder.description')}
                            autoCorrect={hasTouchInput ? "on" : "off"}
                            autoCapitalize={hasTouchInput ? "sentences" : "off"}
                            spellCheck={hasTouchInput}
                          />
                        </div>
                      ) : (
                        <>
                          <div className="typography-markdown text-xl font-semibold text-foreground break-words leading-snug">{pr.title}</div>
                          {pr.body?.trim() ? (
                            <SimpleMarkdownRenderer
                              content={pr.body}
                              className="typography-markdown-body text-muted-foreground break-words mt-1"
                            />
                          ) : (
                            <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words mt-1">
                              {isHydratingCurrentPrBody ? t('gitView.pr.loadingDescription') : t('gitView.pr.noDescription')}
                            </div>
                          )}
                        </>
                      )}
                      {canMerge && pr.draft ? (
                        <div className="typography-micro text-muted-foreground">
                          {t('gitView.pr.draftMustBeReady')}
                        </div>
                      ) : null}
                      {!canMerge ? (
                        <div className="typography-micro text-muted-foreground">{t('gitView.pr.noMergePermission')}</div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="order-first w-full flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {pr.state === 'open' ? (
                        isEditingPr ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  onClick={() => {
                                    setIsEditingPr(false);
                                    setEditTitle(pr.title || '');
                                    setEditBody(pr.body || '');
                                  }}
                                  disabled={isUpdating}
                                  aria-label={t('gitView.pr.actions.cancelEditingAria')}
                                >
                                  <RiCloseLine className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><p>{t('gitView.pr.actions.cancelEditing')}</p></TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  onClick={() => updatePr(pr)}
                                  disabled={isUpdating || !editTitle.trim()}
                                  aria-label={t('gitView.pr.actions.savePrAria')}
                                >
                                  {isUpdating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiCheckLine className="size-4" />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><p>{t('gitView.pr.actions.savePr')}</p></TooltipContent>
                            </Tooltip>
                          </>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 w-7 px-0"
                                onClick={() => setIsEditingPr(true)}
                                aria-label={t('gitView.pr.actions.editPrAria')}
                              >
                                <RiEditLine className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>{t('gitView.pr.actions.editPr')}</p></TooltipContent>
                          </Tooltip>
                        )
                      ) : null}

                      {showChecks && checks ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 px-0"
                              onClick={openChecksDialog}
                              disabled={isLoadingCheckDetails}
                              aria-label={t('gitView.pr.actions.openChecksAria')}
                            >
                              {isLoadingCheckDetails ? <RiLoader4Line className="size-4 animate-spin" /> : <RiInformationLine className="size-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>{t('gitView.pr.actions.openChecks')}</p></TooltipContent>
                        </Tooltip>
                      ) : null}

                      {checks?.failure ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 px-0 border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]"
                              onClick={sendFailedChecksToChat}
                              aria-label={t('gitView.pr.actions.resolveFailedChecksAria')}
                            >
                              <RiErrorWarningLine className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>{t('gitView.pr.actions.resolveFailedChecks')}</p></TooltipContent>
                        </Tooltip>
                      ) : null}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 px-0"
                            onClick={openCommentsDialog}
                            aria-label={t('gitView.pr.actions.openCommentsAria')}
                          >
                            <RiChat4Line className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>{t('gitView.pr.actions.openComments')}</p></TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 px-0 border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]"
                            onClick={sendCommentsToChat}
                            aria-label={t('gitView.pr.actions.shareCommentsAria')}
                          >
                            <RiAiGenerate2 className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>{t('gitView.pr.actions.shareComments')}</p></TooltipContent>
                      </Tooltip>

                      {canMerge && pr.draft && pr.state === 'open' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 px-0"
                              onClick={() => markReady(pr)}
                              disabled={isMarkingReady || isMerging || isUpdating || isEditingPr}
                              aria-label={t('gitView.pr.actions.markReadyAria')}
                            >
                              {isMarkingReady ? <RiLoader4Line className="size-4 animate-spin" /> : <RiCheckboxCircleLine className="size-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>{t('gitView.pr.actions.markReady')}</p></TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>

                    <div className="ml-auto flex items-center gap-2">
                      {isTerminalPr ? (
                        <Button size="sm" className="h-7" onClick={startNextPr}>
                          <RiGitPullRequestLine className="size-4" />
                          {t('gitView.pr.actions.startNextPr')}
                        </Button>
                      ) : null}
                      {canMerge ? (
                        <>
                          <Select
                            value={mergeMethod}
                            onValueChange={(value) => setMergeMethod(value as MergeMethod)}
                            disabled={isMerging || pr.state !== 'open'}
                          >
                            <SelectTrigger size="lg" className="h-7 w-auto min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="squash">{t('gitView.pr.mergeMethod.squash')}</SelectItem>
                              <SelectItem value="merge">{t('gitView.pr.mergeMethod.merge')}</SelectItem>
                              <SelectItem value="rebase">{t('gitView.pr.mergeMethod.rebase')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                className="h-7 w-7 px-0"
                                onClick={() => mergePr(pr)}
                                disabled={isMerging || isMarkingReady || pr.state !== 'open' || pr.draft || isUpdating || isEditingPr}
                                aria-label={t('gitView.pr.actions.mergePrAria')}
                              >
                                {isMerging ? <RiLoader4Line className="size-4 animate-spin" /> : <RiGitMergeLine className="size-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>{t('gitView.pr.actions.mergePr')}</p></TooltipContent>
                          </Tooltip>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {isStartingNextPr ? (
                  <div className="flex items-center">
                    <Button variant="ghost" size="sm" onClick={() => setNextPrFromTerminalNumber(null)}>
                      {t('gitView.pr.actions.cancelNextPr')}
                    </Button>
                  </div>
                ) : null}

                <div className="flex flex-col gap-2 @[440px]/git-view:flex-row @[440px]/git-view:items-center @[440px]/git-view:justify-between">
                  <div className="min-w-0">
                    <div className="typography-ui-label text-foreground">
                      {isStartingNextPr ? t('gitView.pr.createNextTitle') : t('gitView.pr.createTitle')}
                    </div>
                    <div className="typography-micro text-muted-foreground truncate">
                      {branch} <span className="opacity-60">(local)</span> → {targetBaseBranch} <span className="opacity-60">({useDetectedUpstream && detectedUpstream ? 'upstream' : 'remote'})</span>
                    </div>
                  </div>
                  {!isStartingNextPr && repoUrl ? (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Button variant="outline" size="sm" asChild>
                        <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                          <RiExternalLinkLine className="size-4" />
                          {t('gitView.pr.actions.repo')}
                        </a>
                      </Button>
                    </div>
                  ) : null}
                </div>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">{t('gitView.pr.field.title')}</div>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('gitView.pr.placeholder.title')}
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </label>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">{t('gitView.pr.field.baseBranch')}</div>
                  {availableBaseBranches.length > 0 ? (
                    <Select value={targetBaseBranch} onValueChange={setTargetBaseBranch}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder={t('gitView.pr.placeholder.selectBaseBranch')} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableBaseBranches.map((candidate) => (
                          <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={targetBaseBranch}
                      onChange={(e) => setTargetBaseBranch(e.target.value)}
                      placeholder={t('gitView.pr.placeholder.main')}
                    />
                  )}
                </label>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">{t('gitView.pr.field.description')}</div>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="min-h-[110px]"
                    placeholder={t('gitView.pr.placeholder.whatChanged')}
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </label>

                <div
                  className="flex items-center gap-2 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-pressed={draft}
                  onClick={() => setDraft((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setDraft((v) => !v);
                    }
                  }}
                >
                  <Checkbox
                    size="sm"
                    checked={draft}
                    onChange={(next) => setDraft(next)}
                    ariaLabel={t('gitView.pr.actions.toggleDraftAria')}
                  />
                  <span className="typography-ui-label text-foreground select-none">{t('gitView.pr.field.draft')}</span>
                </div>

                {/* Additional Context Section */}
                {isMobile ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="typography-micro text-muted-foreground">
                        {t('gitView.pr.additionalContext.optional')}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsContextSheetOpen(true)}
                      >
                        {additionalContext.trim() ? t('gitView.pr.actions.edit') : t('gitView.pr.actions.add')}
                      </Button>
                    </div>
                    {additionalContext.trim() && (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 text-xs text-[var(--interactive-selection-foreground)]">
                          {t('gitView.pr.additionalContext.added')}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <Collapsible open={isContextOpen} onOpenChange={setIsContextOpen}>
                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2 hover:bg-[var(--interactive-hover)]">
                      <span className="typography-micro text-muted-foreground">
                        {t('gitView.pr.additionalContext.optional')}
                      </span>
                      <span className="typography-micro text-[var(--primary-base)]">
                        {isContextOpen ? t('gitView.pr.actions.hide') : additionalContext.trim() ? t('gitView.pr.actions.edit') : t('gitView.pr.actions.add')}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
                        <Textarea
                          value={additionalContext}
                          onChange={(e) => setAdditionalContext(e.target.value)}
                          className="min-h-[100px] bg-transparent"
                          placeholder={t('gitView.pr.placeholder.additionalContext')}
                        />
                        <p className="typography-micro text-muted-foreground">
                          {t('gitView.pr.additionalContext.hint')}
                        </p>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {/* Mobile Sheet for Context */}
                <MobileOverlayPanel
                  open={isContextSheetOpen}
                  onClose={() => setIsContextSheetOpen(false)}
                  title={t('gitView.pr.additionalContext.title')}
                  footer={
                    <Button
                      size="sm"
                      onClick={() => setIsContextSheetOpen(false)}
                      className="w-full"
                    >
                      {t('gitView.common.done')}
                    </Button>
                  }
                >
                  <div className="space-y-3">
                    <Textarea
                      value={additionalContext}
                      onChange={(e) => setAdditionalContext(e.target.value)}
                      className="min-h-[200px] bg-transparent"
                      placeholder={t('gitView.pr.placeholder.additionalContext')}
                      autoFocus
                    />
                    <p className="typography-micro text-muted-foreground">
                      {t('gitView.pr.additionalContext.hint')}
                    </p>
                  </div>
                </MobileOverlayPanel>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateDescription}
                    disabled={isGenerating || isCreating}
                  >
                    {isGenerating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiAiGenerate2 className="size-4 text-primary" />}
                    {t('gitView.commit.generate')}
                  </Button>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    className="min-w-[7.5rem] justify-center gap-2"
                    onClick={createPr}
                    disabled={isCreating || !isConnected || !targetBaseBranch.trim() || (!useDetectedUpstream && targetBaseBranch.trim() === branch)}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      {isCreating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiGitPullRequestLine className="size-4" />}
                    </span>
                    <span>{t('gitView.pr.actions.createPr')}</span>
                  </Button>
                </div>
              </div>
            )}
      </div>
        </>
      )}

      <Dialog open={checksDialogOpen} onOpenChange={setChecksDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col min-h-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RiGitPullRequestLine className="h-5 w-5" />
              {t('gitView.pr.checkDetails.title')}
            </DialogTitle>
            <DialogDescription>
              {dialogPullRequestNumber !== null
                ? t('gitView.pr.numberLabel', { number: dialogPullRequestNumber })
                : t('gitView.pullRequest.title')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto mt-2">
            {isLoadingCheckDetails ? (
              <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                {t('gitView.loading.loading')}
              </div>
            ) : null}

            {!isLoadingCheckDetails ? (
              <div className="space-y-3">
                {Array.isArray(checkDetails?.checkRuns) && checkDetails?.checkRuns.length > 0 ? (
                  checkDetails.checkRuns.map((run, idx) => {
                    const key = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${run.name}:${idx}`;
                    return (
                      <div key={key} className="p-1">
                        {renderCheckRunSummary(run)}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center text-muted-foreground py-8">{t('gitView.pr.checkDetails.empty')}</div>
                )}
              </div>
            ) : null}
          </div>

        </DialogContent>
      </Dialog>

      <Dialog open={commentsDialogOpen} onOpenChange={setCommentsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[82vh] min-h-[38rem] flex flex-col gap-2">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RiGitPullRequestLine className="h-5 w-5" />
              {t('gitView.pr.comments.title')}
              {dialogPullRequestNumber !== null ? (
                <span className="typography-meta text-muted-foreground">{t('gitView.pr.numberLabel', { number: dialogPullRequestNumber })}</span>
              ) : null}
            </DialogTitle>
          </DialogHeader>

          <ScrollShadow className="mt-2 max-h-[66vh] overflow-y-auto overlay-scrollbar-target overlay-scrollbar-container">
            {isLoadingCommentsDetails ? (
              <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                {t('gitView.loading.loading')}
              </div>
            ) : null}

            {!isLoadingCommentsDetails ? (
              <div className="space-y-4">
                {timelineComments.length > 0 ? (
                  <div className="relative pl-3">
                    <div>
                      {timelineComments.map((comment, idx) => {
                        const initial = (comment.authorName || '?').charAt(0).toUpperCase();
                        const isLast = idx === timelineComments.length - 1;
                        return (
                          <div key={comment.id} className="relative pl-10 pb-5 last:pb-0">
                            {!isLast ? <div className="absolute left-4 top-[2.375rem] bottom-[0.375rem] w-px bg-border/60" /> : null}
                            <div className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated text-xs text-muted-foreground">
                              {comment.avatarUrl ? (
                                <img src={comment.avatarUrl} alt={comment.authorName} className="h-full w-full object-cover" />
                              ) : (
                                <span>{initial}</span>
                              )}
                            </div>
                            <div className="rounded-lg bg-surface-elevated px-3 pt-0 pb-3 space-y-2">
                              <div className="flex flex-col items-start gap-1 typography-micro text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1 sm:gap-y-1">
                                <span className="text-foreground whitespace-nowrap">
                                  {comment.authorName}
                                  {comment.authorLogin && comment.authorLogin !== comment.authorName ? ` · @${comment.authorLogin}` : ''}
                                </span>
                                {comment.createdAt ? <span className="whitespace-nowrap">{formatTimestamp(comment.createdAt)}</span> : null}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-0 has-[>svg]:px-0 sm:px-2 sm:has-[>svg]:px-2.5 text-[var(--status-success)] hover:bg-[var(--status-success-background)] hover:text-[var(--status-success)] justify-start"
                                      onClick={() => {
                                        void sendSingleCommentToChat(comment);
                                      }}
                                      aria-label={t('gitView.pr.actions.sendCommentToAgentAria')}
                                    >
                                      <RiAiGenerate2 className="size-3.5" />
                                      {t('gitView.pr.actions.sendToAgent')}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent><p>{t('gitView.pr.actions.sendCommentToAgent')}</p></TooltipContent>
                                </Tooltip>
                              </div>
                              <div className="typography-micro text-muted-foreground">
                                {comment.context}
                                {comment.path ? ` · ${comment.path}` : ''}
                                {comment.line ? `:${comment.line}` : ''}
                              </div>
                              <SimpleMarkdownRenderer
                                content={linkifyMentionsMarkdown(comment.body)}
                                className={[
                                  'typography-markdown-body text-foreground break-words [&_a]:no-underline [&_a:hover]:no-underline',
                                  selfMentionHighlightClass,
                                ].filter(Boolean).join(' ')}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8">{t('gitView.pr.comments.empty')}</div>
                )}
              </div>
            ) : null}
          </ScrollShadow>

        </DialogContent>
      </Dialog>
    </section>
  );
};
