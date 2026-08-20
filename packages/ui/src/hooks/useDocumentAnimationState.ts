import React from 'react';

export type DocumentAnimationState = Readonly<{
  isVisible: boolean;
  prefersReducedMotion: boolean;
  shouldAnimate: boolean;
}>;

const VISIBLE_ANIMATED: DocumentAnimationState = Object.freeze({
  isVisible: true,
  prefersReducedMotion: false,
  shouldAnimate: true,
});
const VISIBLE_STATIC: DocumentAnimationState = Object.freeze({
  isVisible: true,
  prefersReducedMotion: true,
  shouldAnimate: false,
});
const HIDDEN_ANIMATED_PREFERENCE: DocumentAnimationState = Object.freeze({
  isVisible: false,
  prefersReducedMotion: false,
  shouldAnimate: false,
});
const HIDDEN_STATIC: DocumentAnimationState = Object.freeze({
  isVisible: false,
  prefersReducedMotion: true,
  shouldAnimate: false,
});

export const resolveDocumentAnimationState = (
  isVisible: boolean,
  prefersReducedMotion: boolean,
): DocumentAnimationState => {
  if (isVisible) {
    return prefersReducedMotion ? VISIBLE_STATIC : VISIBLE_ANIMATED;
  }
  return prefersReducedMotion ? HIDDEN_STATIC : HIDDEN_ANIMATED_PREFERENCE;
};

const listeners = new Set<() => void>();
let reducedMotionQuery: MediaQueryList | null = null;
let listening = false;
let snapshot = VISIBLE_ANIMATED;

const getReducedMotionQuery = (): MediaQueryList | null => {
  if (reducedMotionQuery || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return reducedMotionQuery;
  }
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery;
};

const readSnapshot = (): DocumentAnimationState => {
  const isVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const prefersReducedMotion = getReducedMotionQuery()?.matches === true;
  return resolveDocumentAnimationState(isVisible, prefersReducedMotion);
};

const getSnapshot = (): DocumentAnimationState => {
  snapshot = readSnapshot();
  return snapshot;
};

const notifyIfChanged = (): void => {
  const next = readSnapshot();
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
};

const addSharedListeners = (): void => {
  if (listening) return;
  listening = true;
  snapshot = readSnapshot();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', notifyIfChanged);
  }
  const query = getReducedMotionQuery();
  if (typeof query?.addEventListener === 'function') {
    query.addEventListener('change', notifyIfChanged);
  } else {
    query?.addListener(notifyIfChanged);
  }
};

const removeSharedListeners = (): void => {
  if (!listening) return;
  listening = false;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', notifyIfChanged);
  }
  if (typeof reducedMotionQuery?.removeEventListener === 'function') {
    reducedMotionQuery.removeEventListener('change', notifyIfChanged);
  } else {
    reducedMotionQuery?.removeListener(notifyIfChanged);
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    addSharedListeners();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      removeSharedListeners();
    }
  };
};

export const useDocumentAnimationState = (): DocumentAnimationState => (
  React.useSyncExternalStore(subscribe, getSnapshot, () => VISIBLE_STATIC)
);
