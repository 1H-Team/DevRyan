// Pure reducer for the agent cursor overlay.
//
// Coalescing rule (deliberate): only pointer *moves* may be dropped. Presses,
// releases, clicks, key events, text, and touch are discrete acts the viewer
// must see — dropping them would show a cursor gliding over a button that
// silently changed state.

export type AgentInputEvent =
  | { leaseId: string; kind: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: string | null; clickCount?: number }
  | { leaseId: string; kind: 'key'; keyType?: string; key?: string | null }
  | { leaseId: string; kind: 'text'; length?: number }
  | { leaseId: string; kind: 'touch'; x: number; y: number; touchType?: string };

export type AgentCursorState = {
  visible: boolean;
  x: number;
  y: number;
  pressed: boolean;
  // Incremented on each discrete press so the view can restart a ripple even
  // when two clicks land on the same coordinates.
  rippleKey: number;
  lastActivityAt: number;
  lastDiscreteAt: number;
};

export const createAgentCursorState = (): AgentCursorState => ({
  visible: false,
  x: 0,
  y: 0,
  pressed: false,
  rippleKey: 0,
  lastActivityAt: 0,
  lastDiscreteAt: 0,
});

export const AGENT_CURSOR_MOVE_COALESCE_MS = 33; // ~30Hz
export const AGENT_CURSOR_IDLE_HIDE_MS = 4000;

export const isDiscreteAgentInput = (event: AgentInputEvent): boolean => event.kind !== 'move';

export const reduceAgentCursorState = (
  state: AgentCursorState,
  event: AgentInputEvent,
  now: number,
): AgentCursorState => {
  if (event.kind === 'move') {
    // Coalesce only against the previous *move*; a recent discrete event never
    // suppresses the position update that follows it.
    if (now - state.lastActivityAt < AGENT_CURSOR_MOVE_COALESCE_MS && state.lastActivityAt !== state.lastDiscreteAt) {
      return state;
    }
    if (state.visible && state.x === event.x && state.y === event.y) {
      return { ...state, lastActivityAt: now };
    }
    return { ...state, visible: true, x: event.x, y: event.y, lastActivityAt: now };
  }

  if (event.kind === 'down') {
    return {
      ...state,
      visible: true,
      x: event.x,
      y: event.y,
      pressed: true,
      rippleKey: state.rippleKey + 1,
      lastActivityAt: now,
      lastDiscreteAt: now,
    };
  }

  if (event.kind === 'up' || event.kind === 'wheel') {
    return {
      ...state,
      visible: true,
      x: event.x,
      y: event.y,
      pressed: false,
      lastActivityAt: now,
      lastDiscreteAt: now,
    };
  }

  if (event.kind === 'touch') {
    return {
      ...state,
      visible: true,
      x: event.x,
      y: event.y,
      pressed: event.touchType === 'touchStart' || event.touchType === 'touchMove',
      rippleKey: event.touchType === 'touchStart' ? state.rippleKey + 1 : state.rippleKey,
      lastActivityAt: now,
      lastDiscreteAt: now,
    };
  }

  // Key and text events keep the overlay alive without moving it.
  return { ...state, visible: true, lastActivityAt: now, lastDiscreteAt: now };
};

export const shouldHideAgentCursor = (state: AgentCursorState, now: number): boolean => (
  state.visible && now - state.lastActivityAt >= AGENT_CURSOR_IDLE_HIDE_MS
);

export const isAgentInputEvent = (
  value: unknown,
  expectedLeaseId?: string,
): value is AgentInputEvent => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { leaseId?: unknown; kind?: unknown; x?: unknown; y?: unknown };
  if (typeof candidate.leaseId !== 'string' || !candidate.leaseId.trim()) return false;
  if (expectedLeaseId && candidate.leaseId !== expectedLeaseId) return false;
  if (typeof candidate.kind !== 'string') return false;
  if (candidate.kind === 'key' || candidate.kind === 'text') return true;
  if (!['move', 'down', 'up', 'wheel', 'touch'].includes(candidate.kind)) return false;
  return typeof candidate.x === 'number' && typeof candidate.y === 'number'
    && Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
};
