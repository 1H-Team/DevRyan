import React from 'react';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import {
  isPreviewElementMetadata,
  renderPreviewScreenshot,
  type PreviewElementMetadata,
} from '@/lib/preview/screenshot-capture';
import { openExternalUrl } from '@/lib/url';
import {
  PREVIEW_CONSOLE_EVENT_LIMIT,
  createEmptyPreviewDiagnosticsState,
  formatPreviewConsoleText,
  getPreviewConsoleFilterMatch,
  type PreviewConsoleEvent,
  type PreviewConsoleFilter,
  type PreviewDiagnosticsState,
} from './previewDiagnosticsState';

export type PreviewAnnotationAttachment = {
  target: PreviewElementMetadata;
  pageUrl: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  screenshot: File | null;
};

type PreviewBridgeMessage = {
  source?: string;
  version?: number;
  type?: string;
  level?: PreviewConsoleEvent['level'];
  args?: unknown[];
  message?: unknown;
  stack?: unknown;
  filename?: unknown;
  line?: unknown;
  column?: unknown;
  tag?: unknown;
  url?: unknown;
  outerHTML?: unknown;
  ts?: unknown;
  target?: unknown;
  navigation?: unknown;
};

type UsePreviewDiagnosticsOptions = {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  enabled: boolean;
  frameKey: string;
  pageUrl: string;
  colorScheme: 'light' | 'dark';
  initialState?: PreviewDiagnosticsState;
  onStateChange?: (state: PreviewDiagnosticsState) => void;
  onDisplayNavigate?: (url: string, reason: 'ready' | 'display') => void;
  onRenderReady?: () => void;
  onNavigationStart?: () => void;
  onTargetNavigate?: (url: string) => void;
  onExternalNavigate?: (url: string) => void;
  onAttachConsole?: (events: PreviewConsoleEvent[], pageUrl: string) => void;
  onAttachAnnotation?: (attachment: PreviewAnnotationAttachment) => void;
};

export const usePreviewDiagnostics = ({
  iframeRef,
  enabled,
  frameKey,
  pageUrl,
  colorScheme,
  initialState,
  onStateChange,
  onDisplayNavigate,
  onRenderReady,
  onNavigationStart,
  onTargetNavigate,
  onExternalNavigate,
  onAttachConsole,
  onAttachAnnotation,
}: UsePreviewDiagnosticsOptions) => {
  const { t } = useI18n();
  const initial = React.useRef(initialState ?? createEmptyPreviewDiagnosticsState());
  const nextConsoleEventIdRef = React.useRef(
    Math.max(0, ...initial.current.consoleEvents.map((event) => event.id)) + 1,
  );
  const previousFrameKeyRef = React.useRef(frameKey);
  const [bridgeReady, setBridgeReady] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(initial.current.consoleOpen);
  const [consoleFilter, setConsoleFilter] = React.useState<PreviewConsoleFilter>(initial.current.consoleFilter);
  const [consoleEvents, setConsoleEvents] = React.useState<PreviewConsoleEvent[]>(
    initial.current.consoleEvents.slice(-PREVIEW_CONSOLE_EVENT_LIMIT),
  );
  const [inspectMode, setInspectMode] = React.useState(initial.current.inspectMode);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);

  React.useEffect(() => {
    onStateChange?.({ consoleEvents, consoleOpen, consoleFilter, inspectMode });
  }, [consoleEvents, consoleFilter, consoleOpen, inspectMode, onStateChange]);

  React.useEffect(() => {
    if (previousFrameKeyRef.current === frameKey) return;
    previousFrameKeyRef.current = frameKey;
    setBridgeReady(false);
    setConsoleEvents([]);
    setConsoleOpen(false);
    setConsoleFilter('all');
    setInspectMode(false);
    setHoverTarget(null);
    nextConsoleEventIdRef.current = 1;
  }, [frameKey]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!enabled || !bridgeReady || !frameWindow) return;
    frameWindow.postMessage({
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled: inspectMode,
    }, window.location.origin);
  }, [bridgeReady, enabled, iframeRef, inspectMode]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!enabled || !bridgeReady || !frameWindow) return;
    frameWindow.postMessage({
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-color-scheme',
      scheme: colorScheme,
    }, window.location.origin);
  }, [bridgeReady, colorScheme, enabled, iframeRef]);

  React.useEffect(() => {
    if (!inspectMode || typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setInspectMode(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [inspectMode]);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const stringify = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const pushConsoleEvent = (event: Omit<PreviewConsoleEvent, 'id'>) => {
      const id = nextConsoleEventIdRef.current;
      nextConsoleEventIdRef.current += 1;
      setConsoleEvents((current) => {
        const next = [...current, { ...event, id }];
        return next.length > PREVIEW_CONSOLE_EVENT_LIMIT
          ? next.slice(next.length - PREVIEW_CONSOLE_EVENT_LIMIT)
          : next;
      });
    };

    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'openchamber-preview-bridge' || data.version !== 1) return;

      if (data.type === 'ready') {
        setBridgeReady(true);
        const frameWindow = iframeRef.current?.contentWindow;
        frameWindow?.postMessage({
          source: 'openchamber-preview-parent',
          version: 1,
          type: 'set-inspect-mode',
          enabled: inspectMode,
        }, window.location.origin);
        frameWindow?.postMessage({
          source: 'openchamber-preview-parent',
          version: 1,
          type: 'set-color-scheme',
          scheme: colorScheme,
        }, window.location.origin);
        if (typeof data.url === 'string' && data.url) onDisplayNavigate?.(data.url, 'ready');
        return;
      }
      if (data.type === 'render-ready') {
        onRenderReady?.();
        return;
      }
      if (data.type === 'navigation-start') {
        onNavigationStart?.();
        return;
      }
      if (data.type === 'console') {
        const level = data.level === 'error' || data.level === 'warn' || data.level === 'info' || data.level === 'debug'
          ? data.level
          : 'log';
        const args = Array.isArray(data.args) ? data.args.map(stringify).filter(Boolean) : [];
        pushConsoleEvent({ level, message: args.join(' '), ts: typeof data.ts === 'number' ? data.ts : Date.now() });
        return;
      }
      if (data.type === 'runtime-error') {
        const filename = stringify(data.filename);
        const line = typeof data.line === 'number' ? data.line : null;
        const column = typeof data.column === 'number' ? data.column : null;
        const location = filename
          ? `${filename}${line !== null ? `:${line}${column !== null ? `:${column}` : ''}` : ''}`
          : '';
        pushConsoleEvent({
          level: 'runtime',
          message: stringify(data.message) || t('contextPanel.preview.console.runtimeError'),
          details: [location, stringify(data.stack)].filter(Boolean).join('\n'),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }
      if (data.type === 'resource-error') {
        const tag = stringify(data.tag) || 'resource';
        const url = stringify(data.url);
        pushConsoleEvent({
          level: 'resource',
          message: url ? `${tag}: ${url}` : tag,
          details: stringify(data.outerHTML),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }
      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }
      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        const target = data.target;
        setHoverTarget(target);
        setInspectMode(false);
        if (onAttachAnnotation) {
          void (async () => {
            let screenshot: File | null = null;
            try {
              screenshot = iframeRef.current ? await renderPreviewScreenshot(iframeRef.current, target) : null;
            } catch {
              screenshot = null;
            }
            onAttachAnnotation({
              target,
              pageUrl,
              viewport: {
                width: iframeRef.current?.clientWidth ?? window.innerWidth,
                height: iframeRef.current?.clientHeight ?? window.innerHeight,
              },
              devicePixelRatio: window.devicePixelRatio,
              screenshot,
            });
          })();
        }
        return;
      }
      if (data.type === 'navigate-preview' && typeof data.url === 'string' && data.url) {
        if (data.navigation === 'external') {
          if (onExternalNavigate) onExternalNavigate(data.url);
          else void openExternalUrl(data.url);
        } else if (data.navigation === 'target') {
          onTargetNavigate?.(data.url);
        } else {
          onDisplayNavigate?.(data.url, 'display');
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [colorScheme, enabled, iframeRef, inspectMode, onAttachAnnotation, onDisplayNavigate, onExternalNavigate, onNavigationStart, onRenderReady, onTargetNavigate, pageUrl, t]);

  const filteredConsoleEvents = React.useMemo(
    () => consoleEvents.filter((event) => getPreviewConsoleFilterMatch(event, consoleFilter)),
    [consoleEvents, consoleFilter],
  );
  const consoleErrorCount = React.useMemo(
    () => consoleEvents.filter((event) => (
      event.level === 'error' || event.level === 'runtime' || event.level === 'resource'
    )).length,
    [consoleEvents],
  );

  const copyConsoleEvents = React.useCallback(() => {
    void copyTextToClipboard(formatPreviewConsoleText(consoleEvents, pageUrl)).then((result) => {
      if (result.ok) toast.success(t('contextPanel.preview.console.copied'));
      else toast.error(t('contextPanel.preview.console.copyFailed'));
    });
  }, [consoleEvents, pageUrl, t]);

  return {
    bridgeReady,
    consoleOpen,
    setConsoleOpen,
    consoleFilter,
    setConsoleFilter,
    consoleEvents,
    setConsoleEvents,
    filteredConsoleEvents,
    consoleErrorCount,
    inspectMode,
    setInspectMode,
    hoverTarget,
    copyConsoleEvents,
    attachConsoleEvents: () => onAttachConsole?.(consoleEvents, pageUrl),
  };
};
