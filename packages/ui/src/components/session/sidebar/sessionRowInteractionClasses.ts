type SessionRowInteractionClasses = {
  revealOnHoverClass: string;
  hideOnHoverClass: string;
  revealPaddingClass: string;
};

export type MobileSessionSwipeAction = 'reveal' | 'hide' | null;

export function resolveSessionRowInteractionClasses(): SessionRowInteractionClasses {
  return {
    revealOnHoverClass: 'group-hover:opacity-100 group-hover:pointer-events-auto',
    hideOnHoverClass: 'group-hover:opacity-0',
    revealPaddingClass: 'group-hover:pr-9',
  };
}

export function resolveMobileSessionSwipeAction(
  deltaX: number,
  deltaY: number,
  threshold = 44,
): MobileSessionSwipeAction {
  const horizontalDistance = Math.abs(deltaX);
  if (horizontalDistance < threshold) return null;
  if (horizontalDistance <= Math.abs(deltaY) * 1.2) return null;
  return deltaX < 0 ? 'reveal' : 'hide';
}
