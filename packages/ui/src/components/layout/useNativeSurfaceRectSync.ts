import React from 'react';

export type NativeSurfaceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
};

const POLL_INTERVAL_MS = 250;
const ACTIVITY_HARD_STOP_MS = 1_000;
const ACTIVITY_SETTLE_MS = 80;

const sameRect = (left: NativeSurfaceRect | null, right: NativeSurfaceRect): boolean => (
  left?.x === right.x
  && left.y === right.y
  && left.width === right.width
  && left.height === right.height
  && left.bottom === right.bottom
);

const readRoundedRect = (element: HTMLElement): NativeSurfaceRect => {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
    bottom: Math.round(rect.bottom),
  };
};

export const useNativeSurfaceRectSync = (
  elementRef: React.RefObject<HTMLElement | null>,
  onRectChange: (rect: NativeSurfaceRect) => void,
): void => {
  const callbackRef = React.useRef(onRectChange);
  const lastRectRef = React.useRef<NativeSurfaceRect | null>(null);

  React.useLayoutEffect(() => {
    callbackRef.current = onRectChange;
    lastRectRef.current = null;
  }, [onRectChange]);

  React.useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || typeof window === 'undefined' || typeof document === 'undefined') return;

    let animationFrame = 0;
    let hardStopTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (document.visibilityState === 'hidden') return;
      const next = readRoundedRect(element);
      if (sameRect(lastRectRef.current, next)) return;
      lastRectRef.current = next;
      callbackRef.current(next);
    };

    const stopActivityLoop = (measureFinalRect = true) => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (hardStopTimer) clearTimeout(hardStopTimer);
      hardStopTimer = null;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (measureFinalRect) measure();
    };

    const runActivityFrame = () => {
      measure();
      animationFrame = window.requestAnimationFrame(runActivityFrame);
    };

    const startActivityLoop = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(runActivityFrame);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (hardStopTimer) clearTimeout(hardStopTimer);
      hardStopTimer = setTimeout(stopActivityLoop, ACTIVITY_HARD_STOP_MS);
    };

    const settleActivityLoop = () => {
      if (!animationFrame) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(stopActivityLoop, ACTIVITY_SETTLE_MS);
    };

    const handleTransitionStart = (event: Event) => {
      if (event instanceof TransitionEvent && event.propertyName === 'width') {
        startActivityLoop();
      }
    };
    const handleTransitionEnd = (event: Event) => {
      if (event instanceof TransitionEvent && event.propertyName === 'width') {
        settleActivityLoop();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-panel-resize-handle]')) {
        startActivityLoop();
      }
    };

    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    document.addEventListener('transitionrun', handleTransitionStart, true);
    document.addEventListener('transitionstart', handleTransitionStart, true);
    document.addEventListener('transitionend', handleTransitionEnd, true);
    document.addEventListener('transitioncancel', handleTransitionEnd, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', settleActivityLoop, true);
    document.addEventListener('pointercancel', settleActivityLoop, true);
    const pollTimer = window.setInterval(measure, POLL_INTERVAL_MS);

    return () => {
      stopActivityLoop(false);
      observer?.disconnect();
      window.clearInterval(pollTimer);
      window.removeEventListener('resize', measure);
      document.removeEventListener('transitionrun', handleTransitionStart, true);
      document.removeEventListener('transitionstart', handleTransitionStart, true);
      document.removeEventListener('transitionend', handleTransitionEnd, true);
      document.removeEventListener('transitioncancel', handleTransitionEnd, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', settleActivityLoop, true);
      document.removeEventListener('pointercancel', settleActivityLoop, true);
    };
  }, [elementRef, onRectChange]);
};
