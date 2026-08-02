import { devtools as zustandDevtools } from 'zustand/middleware';

type DevtoolsFn = typeof zustandDevtools;

/**
 * Dev-gated Redux DevTools middleware. When the DevTools extension is present,
 * zustand's middleware serializes every setState and retains an unbounded
 * action history — with terminal buffers and message state flowing through at
 * streaming rates. Production builds get a pass-through instead.
 */
export const devtools: DevtoolsFn = ((...args: Parameters<DevtoolsFn>) => {
  const [initializer, options] = args;
  return zustandDevtools(initializer, { ...options, enabled: import.meta.env.DEV });
}) as DevtoolsFn;
