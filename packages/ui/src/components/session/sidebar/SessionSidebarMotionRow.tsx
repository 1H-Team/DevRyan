import React from 'react';
import { motion, useReducedMotion } from 'motion/react';

type SessionSidebarMotionRowProps = {
  children: React.ReactNode;
};

const rowEase = [0.33, 1, 0.68, 1] as const;

const rowTransition = {
  // CSS Grid track animation: the grid container animates
  // grid-template-rows between 0fr and 1fr. The inner child stays at its
  // natural height and never reflows — only the grid track clips. This
  // eliminates the "text cut in half" artifact that height: 0 → auto
  // produces because the browser reflows content at every intermediate
  // height. With grid, the content is laid out once at full height and the
  // track simply reveals/hides it.
  gridTemplateRows: {
    type: 'tween',
    duration: 0.17,
    ease: rowEase,
  },
  // Fade out ahead of the collapse so the row is already invisible before it
  // squeezes shut — clipping shrinking text mid-collapse is what makes the
  // motion look low-framerate even when frames aren't actually dropped.
  opacity: {
    type: 'tween',
    duration: 0.1,
    ease: rowEase,
  },
} as const;

export function SessionSidebarMotionRow({ children }: SessionSidebarMotionRowProps): React.ReactElement {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return <>{children}</>;
  }

  return (
    <motion.div
      initial={{ gridTemplateRows: '0fr', opacity: 0 }}
      animate={{ gridTemplateRows: '1fr', opacity: 1 }}
      exit={{ gridTemplateRows: '0fr', opacity: 0 }}
      transition={rowTransition}
      style={{
        display: 'grid',
        minWidth: 0,
        width: '100%',
        // Session markers now live inside the row's fixed leading rail, so the
        // animation boundary only needs to clip the collapsing grid track.
        overflowX: 'visible',
        overflowY: 'clip',
      }}
    >
      {/* minHeight: 0 allows the grid item to shrink below its content
          height in the 0fr track so the collapse actually hides content. */}
      <div style={{ minHeight: 0, minWidth: 0, width: '100%' }}>{children}</div>
    </motion.div>
  );
}
