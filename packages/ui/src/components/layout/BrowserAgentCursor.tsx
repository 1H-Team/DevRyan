import React from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  AGENT_CURSOR_IDLE_HIDE_MS,
  createAgentCursorState,
  isAgentInputEvent,
  reduceAgentCursorState,
  shouldHideAgentCursor,
  type AgentCursorState,
} from './browserAgentCursorState';

// Simulated cursor drawn over the browser guest while an agent drives it via
// CDP. Coordinates arrive as CSS px in the guest's viewport, so they map
// directly onto the overlay box. The overlay is inert (pointer-events:none) and
// never intercepts the user's own input.

type BrowserAgentCursorProps = {
  active: boolean;
  leaseId: string;
};

export const BrowserAgentCursor: React.FC<BrowserAgentCursorProps> = ({ active, leaseId }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<AgentCursorState>(createAgentCursorState);
  const prefersReducedMotion = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.current = query.matches;
    const onChange = (event: MediaQueryListEvent) => { prefersReducedMotion.current = event.matches; };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  React.useEffect(() => {
    if (!active || typeof window === 'undefined') return;

    const onInput = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isAgentInputEvent(detail, leaseId)) return;
      setState((current) => reduceAgentCursorState(current, detail, Date.now()));
    };

    window.addEventListener('browser-agent-input', onInput);
    return () => window.removeEventListener('browser-agent-input', onInput);
  }, [active, leaseId]);

  // Idle hide: stop showing a stale cursor once the agent goes quiet.
  React.useEffect(() => {
    if (!state.visible) return;
    const timer = setTimeout(() => {
      setState((current) => (shouldHideAgentCursor(current, Date.now())
        ? { ...current, visible: false, pressed: false }
        : current));
    }, AGENT_CURSOR_IDLE_HIDE_MS);
    return () => clearTimeout(timer);
  }, [state.visible, state.lastActivityAt]);

  React.useEffect(() => {
    if (!active) setState(createAgentCursorState());
  }, [active]);

  if (!active) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div
        role="status"
        aria-live="polite"
        className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-[var(--status-info)]/40 bg-background/90 px-2 py-0.5 typography-micro text-[var(--status-info)] shadow-sm"
      >
        {t('contextPanel.browser.agentDriving')}
      </div>
      {state.visible ? (
        <div
          className={cn(
            'absolute -ml-[2px] -mt-[2px] h-5 w-5',
            !prefersReducedMotion.current && 'transition-transform duration-100 ease-out'
          )}
          style={{ transform: `translate3d(${state.x}px, ${state.y}px, 0)` }}
          aria-hidden
        >
          <svg viewBox="0 0 20 20" className="h-5 w-5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]">
            <path
              d="M3 2 L3 16 L7 12.5 L9.6 17.6 L12 16.4 L9.4 11.6 L14.6 11.4 Z"
              fill="var(--status-info)"
              stroke="white"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          {state.pressed ? (
            <span
              key={state.rippleKey}
              className={cn(
                'absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--status-info)]',
                prefersReducedMotion.current ? 'h-6 w-6 opacity-60' : 'h-6 w-6 animate-ping opacity-75'
              )}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
