import React from 'react';
import { createPortal } from 'react-dom';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { PreviewToggleButton } from './PreviewToggleButton';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';

import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { RiCheckLine, RiClipboardLine, RiCloseLine, RiRefreshLine } from '@remixicon/react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { EditorView } from '@codemirror/view';
import { copyTextToClipboard } from '@/lib/clipboard';
import { parseProjectPlanMarkdown } from '@/lib/openchamberConfig';
import { useI18n } from '@/lib/i18n';
import { getPlanViewCandidatePaths } from './planViewPaths';
import type { SessionPlanRevisionIdentity } from '@/lib/api/types';
import { createPlanRevisionDraft, type PlanRevisionDraft } from '@/lib/plans/planRevisionDraft';
import { sessionEvents } from '@/lib/sessionEvents';
import { getAuthPrincipal } from '@/lib/authSession';

type PlanViewProps = {
  targetPath?: string | null;
  presentation?: 'standalone' | 'context-panel';
  headerActionsTarget?: HTMLElement | null;
};

// Unsaved work survives view remounts in this page; acknowledged clean drafts leave the cache.
const revisionDrafts = new Map<string, { draft: PlanRevisionDraft; identity: SessionPlanRevisionIdentity | null }>();

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const buildRepoPlanPath = (directory: string, created: number, slug: string): string => {
  return joinPath(joinPath(joinPath(directory, '.opencode'), 'plans'), `${created}-${slug}.md`);
};

const buildHomePlanPath = (created: number, slug: string): string => {
  return `~/.opencode/plans/${created}-${slug}.md`;
};

const resolveTilde = (path: string, homeDir: string | null): string => {
  const trimmed = path.trim();
  if (!trimmed.startsWith('~')) return trimmed;
  if (trimmed === '~') return homeDir || trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return homeDir ? `${homeDir}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
};

const toDisplayPath = (resolvedPath: string, options: { currentDirectory: string; homeDirectory: string }): string => {
  const current = normalize(options.currentDirectory);
  const home = normalize(options.homeDirectory);
  const normalized = normalize(resolvedPath);

  if (current && normalized.startsWith(current + '/')) {
    return normalized.slice(current.length + 1);
  }

  if (home && normalized === home) {
    return '~';
  }

  if (home && normalized.startsWith(home + '/')) {
    return `~${normalized.slice(home.length)}`;
  }

  return normalized;
};

type SelectedLineRange = {
  start: number;
  end: number;
};

export const PlanView: React.FC<PlanViewProps> = ({
  targetPath = null,
  presentation = 'standalone',
  headerActionsTarget = null,
}) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionPlanFileRecord = useSessionPlanFileStore((state) => {
    if (!currentSessionId) return null;
    const record = state.recordsBySession[currentSessionId];
    return record?.status === 'saved' ? record : null;
  });
  const sessionPlanPath = sessionPlanFileRecord?.path ?? null;
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const runtimeApis = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const { currentTheme } = useThemeSystem();
  React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);

  const session = React.useMemo(() => {
    if (!currentSessionId) return null;
    return sessions.find((s) => s.id === currentSessionId) ?? null;
  }, [currentSessionId, sessions]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof session?.directory === 'string' ? session.directory : '';
    return normalize(raw || '');
  }, [session?.directory]);
  const sessionSlug = session?.slug ?? null;
  const sessionCreated = session?.time?.created ?? null;
  const sessionPlanIdentity = sessionPlanFileRecord?.revisionIdentity ?? null;

  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null);
  const displayPath = React.useMemo(() => {
    if (!resolvedPath || !sessionDirectory || !homeDirectory) {
      return resolvedPath;
    }
    return toDisplayPath(resolvedPath, { currentDirectory: sessionDirectory, homeDirectory });
  }, [resolvedPath, sessionDirectory, homeDirectory]);
  const [content, setContent] = React.useState<string>('');
  const activeDraftRef = React.useRef<{ draft: PlanRevisionDraft; identity: SessionPlanRevisionIdentity | null } | null>(null);
  const draftSubscriptionRef = React.useRef<(() => void) | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loadRetryNonce, setLoadRetryNonce] = React.useState(0);
  const planFileLabel = React.useMemo(() => {
    return displayPath ? displayPath.split('/').pop() || t('planView.file.defaultName') : t('planView.file.defaultName');
  }, [displayPath, t]);
  const parsedTitle = React.useMemo(() => {
    if (!content.trim()) {
      return t('planView.title.default');
    }
    return parseProjectPlanMarkdown(content).title || t('planView.title.default');
  }, [content, t]);
  const [loading, setLoading] = React.useState(false);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('preview');
  const copiedContentTimeoutRef = React.useRef<number | null>(null);

  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setMdViewMode('preview');
  }, [currentSessionId, sessionPlanPath, targetPath]);

  const isSelectingRef = React.useRef(false);
  const selectionStartRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingRef.current = false;
      selectionStartRef.current = null;
      setIsDragging(false);
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  const extractSelectedCode = React.useCallback((text: string, range: SelectedLineRange): string => {
    const lines = text.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const commentController = useInlineCommentController<SelectedLineRange>({
    source: 'plan',
    fileLabel: planFileLabel,
    language: resolvedPath ? getLanguageFromExtension(resolvedPath) || 'markdown' : 'markdown',
    getCodeForRange: (range) => extractSelectedCode(content, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
  });

  const {
    drafts: planFileDrafts,
    commentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = commentController;

  React.useEffect(() => {
    setLineSelection(null);
    reset();
  }, [content, reset]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  const handleCancelComment = React.useCallback(() => {
    setLineSelection(null);
    cancel();
  }, [cancel]);

  const handleSaveComment = React.useCallback((textToSave: string, rangeOverride?: { start: number; end: number }) => {
    if (rangeOverride) {
      setLineSelection(rangeOverride);
    }
    saveComment(textToSave, rangeOverride ?? lineSelection ?? undefined);
    setLineSelection(null);
  }, [lineSelection, saveComment]);

  React.useEffect(() => {
    if (!lineSelection) return;

    if (isMobile && !editingDraftId) {
      // Input handles mobile scroll/focus behavior.
    }

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-comment-card="true"]') ||
        target.closest('[data-comment-input="true"]') ||
        target.closest('.oc-block-widget')
      ) {
        return;
      }

      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      setLineSelection(null);
      cancel();
    };

    const timeoutId = window.setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, editingDraftId, isMobile, lineSelection]);


  const editorExtensions = React.useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme)];
    const language = languageByExtension(resolvedPath || 'plan.md');
    if (language) {
      extensions.push(language);
    }
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, resolvedPath]);

  React.useEffect(() => {
    // Saved project plans opened via context panel should work even when session plan mode is off.
    if (!planModeEnabled && !targetPath && !sessionPlanPath) {
      setResolvedPath(null);
      setContent('');
      setLoadError(null);
      setLoading(false);
      activeDraftRef.current = null;
      draftSubscriptionRef.current?.();
      draftSubscriptionRef.current = null;
      return;
    }

    let cancelled = false;

    const readText = async (path: string): Promise<{ content: string; version: string }> => {
      if (path === sessionPlanPath && sessionPlanIdentity) {
        const result = await runtimeApis.sessionPlans.readRevision(sessionPlanIdentity);
        return result;
      }
      if (runtimeApis.files?.readFile) {
        const result = await runtimeApis.files.readFile(path);
        return { content: result?.content ?? '', version: 'generic-file' };
      }

      const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
      if (runtimeFiles?.readFile) {
        const result = await runtimeFiles.readFile(path, { optional: true });
        return { content: result?.content ?? '', version: 'generic-file' };
      }

      const response = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}&optional=true`, {
        // Avoid conditional requests (304 + empty body).
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Failed to read plan file (${response.status})`);
      }
      return { content: await response.text(), version: 'generic-file' };
    };

    const activateDraft = (path: string) => {
      const identity = path === sessionPlanPath ? sessionPlanIdentity : null;
      const key = JSON.stringify([getAuthPrincipal().id, identity ?? { path }]);
      let record = revisionDrafts.get(key);
      if (!record) {
        const draft = createPlanRevisionDraft(async (markdown, expectedVersion) => {
          if (identity) {
            const result = await runtimeApis.sessionPlans.updateRevision({ ...identity, markdown, expectedVersion });
            if (!result.saved) throw new Error(t('planView.error.writeFailed'));
            return result.version;
          }
          if (runtimeApis.files?.writeFile) {
            const result = await runtimeApis.files.writeFile(path, markdown);
            if (!result?.success) throw new Error(t('planView.error.writeFailed'));
          } else {
            const response = await fetch('/api/fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path, content: markdown }) });
            if (!response.ok) throw new Error(t('planView.error.writePlanFileFailed', { status: response.status }));
          }
          return 'generic-file';
        });
        record = { draft, identity };
        draft.subscribe(() => {
          const state = draft.snapshot();
          if (state.dirty || state.saving) revisionDrafts.set(key, { draft, identity });
          else if (revisionDrafts.get(key)?.draft === draft) revisionDrafts.delete(key);
        });
      }
      draftSubscriptionRef.current?.();
      activeDraftRef.current = record;
      const draft = record.draft;
      draftSubscriptionRef.current = draft.subscribe(() => {
        const state = draft.snapshot();
        setContent(state.content);
        setSaveError(state.error);
      });
      setContent(record.draft.snapshot().content);
      setSaveError(record.draft.snapshot().error);
      return record.draft;
    };

    const run = async () => {
      setResolvedPath(null);
      setSaveError(null);
      setLoadError(null);

      setLoading(true);

      try {
        const repoPath = sessionSlug && sessionCreated && sessionDirectory
          ? buildRepoPlanPath(sessionDirectory, sessionCreated, sessionSlug)
          : null;
        const homePath = sessionSlug && sessionCreated && sessionDirectory
          ? resolveTilde(buildHomePlanPath(sessionCreated, sessionSlug), homeDirectory || null)
          : null;
        const candidates = getPlanViewCandidatePaths({
          explicitTargetPath: targetPath,
          sessionPlanPath,
          repoPlanPath: repoPath,
          homePlanPath: homePath,
        });

        let resolved: string | null = null;
        let loaded = false;
        let canonicalReadError: string | null = null;

        for (const candidate of candidates) {
          if (cancelled) return;
          try {
            const draft = activateDraft(candidate);
            const state = draft.snapshot();
            if (!state.dirty && !state.saving) {
              const result = await readText(candidate);
              if (cancelled) return;
              draft.load(result.content, result.version);
            }
            resolved = candidate;
            loaded = true;
            break;
          } catch (error) {
            if (cancelled) return;
            if (candidate === sessionPlanPath && sessionPlanIdentity) {
              canonicalReadError = error instanceof Error
                ? error.message
                : t('planView.error.loadFailed');
              break;
            }
          }
        }

        if (cancelled) return;

        if (!resolved || !loaded) {
          setResolvedPath(null);
          setContent('');
          if (canonicalReadError) {
            setLoadError(canonicalReadError);
          }
          return;
        }

        setResolvedPath(resolved);
      } catch (error) {
        if (cancelled) return;
        setResolvedPath(null);
        setContent('');
        setLoadError(error instanceof Error ? error.message : t('planView.error.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [homeDirectory, loadRetryNonce, planModeEnabled, runtimeApis.files, runtimeApis.sessionPlans, sessionCreated, sessionDirectory, sessionPlanIdentity, sessionPlanPath, sessionSlug, t, targetPath]);

  React.useEffect(() => sessionEvents.onPlanUpdated((event) => {
    const active = activeDraftRef.current;
    const identity = active?.identity;
    if (!active || !identity || identity.sessionId !== event.sessionId || identity.sourceMessageId !== event.sourceMessageId
      || identity.directory !== event.directory || identity.sessionCreated !== event.sessionCreated || identity.sessionSlug !== event.sessionSlug) return;
    if (active.draft.observe(event.version) === 'reload') setLoadRetryNonce(nonce => nonce + 1);
  }), []);

  React.useEffect(() => () => {
    draftSubscriptionRef.current?.();
  }, []);

  React.useEffect(() => {
    const draft = activeDraftRef.current?.draft;
    if (!resolvedPath || !draft) return;

    const controller = window.setTimeout(() => {
      void draft.save();
    }, 350);

    return () => {
      window.clearTimeout(controller);
    };
  }, [content, resolvedPath]);

  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
    };
  }, []);

  const routeToChat = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
  }, [setActiveMainTab, setSessionSwitcherOpen]);

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: planFileDrafts,
      editingDraftId,
      commentText,
      selection: lineSelection,
      isDragging,
      fileLabel: planFileLabel,
      newWidgetId: 'plan-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: handleCancelComment,
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [commentText, deleteDraft, editingDraftId, handleCancelComment, handleSaveComment, isDragging, lineSelection, planFileDrafts, planFileLabel, startEdit]);

  const planActions = resolvedPath ? (
    <div className="flex shrink-0 items-center gap-1" data-plan-view-actions="true">
      <PreviewToggleButton
        currentMode={mdViewMode}
        onToggle={() => setMdViewMode(mdViewMode === 'preview' ? 'edit' : 'preview')}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          const result = await copyTextToClipboard(content);
          if (result.ok) {
            setCopiedContent(true);
            if (copiedContentTimeoutRef.current !== null) {
              window.clearTimeout(copiedContentTimeoutRef.current);
            }
            copiedContentTimeoutRef.current = window.setTimeout(() => {
              setCopiedContent(false);
            }, 1200);
          } else {
            // ignored
          }
        }}
        className="h-5 w-5 p-0"
        title={t('planView.actions.copyPlanContents')}
        aria-label={t('planView.actions.copyPlanContents')}
      >
        {copiedContent ? (
          <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
        ) : (
          <RiClipboardLine className="h-4 w-4" />
        )}
      </Button>
    </div>
  ) : null;

  const contextPanelActions = presentation === 'context-panel' && headerActionsTarget && planActions
    ? createPortal(planActions, headerActionsTarget)
    : null;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      {contextPanelActions}
      {presentation === 'standalone' ? (
        <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border/40 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label truncate font-medium">{isMobile ? t('layout.mainTab.plan') : parsedTitle}</div>
            {saveError ? (
              <div role="alert" className="typography-micro text-[color:var(--status-error)]" title={saveError}>
                {saveError || t('planView.error.saveFailed')}
              </div>
            ) : null}
          </div>
          {isMobile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0"
              data-plan-view-close="true"
              aria-label={t('planView.actions.closePlanAria')}
              onClick={routeToChat}
            >
              <RiCloseLine className="size-4" />
            </Button>
          ) : null}
          {planActions}
        </div>
      ) : saveError ? (
        <div
          className="typography-micro flex-shrink-0 truncate border-b border-border/40 px-3 py-1 text-[color:var(--status-error)]"
          title={saveError}
          role="alert"
        >
          {saveError || t('planView.error.saveFailed')}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {loading ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('planView.state.loading')}</div>
          ) : loadError ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <div>
                  <div className="typography-ui-label font-medium text-foreground">
                    {t('planView.error.loadFailed')}
                  </div>
                  <div className="mt-1 typography-micro text-muted-foreground">
                    {loadError}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setLoadRetryNonce((nonce) => nonce + 1)}
                >
                  <RiRefreshLine className="size-3.5" aria-hidden="true" />
                  {t('planView.actions.retryLoad')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="relative h-full">
              <div className="h-full">
                {mdViewMode === 'preview' ? (
                  <div className="h-full overflow-auto p-3">
                    <ErrorBoundary
                      fallback={
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                          <div className="mb-1 font-medium text-destructive">{t('planView.error.previewUnavailable')}</div>
                          <div className="text-sm text-muted-foreground">
                            {t('planView.error.switchToEditMode')}
                          </div>
                        </div>
                      }
                    >
                      <SimpleMarkdownRenderer content={content} className="typography-markdown-body" />
                    </ErrorBoundary>
                  </div>
                ) : (
                  <div className="relative h-full" ref={editorWrapperRef}>
                    <CodeMirrorEditor
                      value={content}
                      onChange={(text) => activeDraftRef.current?.draft.edit(text)}
                      readOnly={false}
                      className="h-full"
                      extensions={editorExtensions}
                      onViewReady={(view) => { editorViewRef.current = view; }}
                      onViewDestroy={() => { editorViewRef.current = null; }}
                      blockWidgets={blockWidgets}
                      highlightLines={lineSelection
                        ? {
                          start: Math.min(lineSelection.start, lineSelection.end),
                          end: Math.max(lineSelection.start, lineSelection.end),
                        }
                        : undefined}
                      lineNumbersConfig={{
                        domEventHandlers: {
                          mousedown: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.button !== 0) return false;
                            event.preventDefault();
                            const lineNumber = view.state.doc.lineAt(line.from).number;

                            if (isMobile && lineSelection && !event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineSelection.end, lineNumber);
                              const end = Math.max(lineSelection.start, lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                              isSelectingRef.current = false;
                              selectionStartRef.current = null;
                              setIsDragging(false);
                              return true;
                            }

                            isSelectingRef.current = true;
                            selectionStartRef.current = lineNumber;
                            setIsDragging(true);

                            if (lineSelection && event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineNumber);
                              const end = Math.max(lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                            } else {
                              setLineSelection({ start: lineNumber, end: lineNumber });
                            }

                            return true;
                          },
                          mouseover: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.buttons !== 1) return false;
                            if (!isSelectingRef.current || selectionStartRef.current === null) return false;
                            const lineNumber = view.state.doc.lineAt(line.from).number;
                            const start = Math.min(selectionStartRef.current, lineNumber);
                            const end = Math.max(selectionStartRef.current, lineNumber);
                            setLineSelection({ start, end });
                            setIsDragging(true);
                            return false;
                          },
                          mouseup: () => {
                            isSelectingRef.current = false;
                            selectionStartRef.current = null;
                            setIsDragging(false);
                            return false;
                          },
                        },
                    }}
                  />
                </div>
                )}
              </div>
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
