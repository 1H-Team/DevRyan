import type { State } from './types';

// Optimization receipts bind both immutable map identities. They never replace
// reducer state or authorize a merge. Unhinted hydration/pruning always scans.
const hints = new WeakMap<State['part'], { base: WeakRef<State['part']>; messageIDs: Set<string> }>();
const MAX_HINTED_MESSAGES = 512;
export function hintPartChange(next: State['part'], previous: State['part'], messageID: string): void {
  if (!messageID) return;
  const existing = hints.get(next);
  const hint = next === previous ? existing : { base: new WeakRef(previous), messageIDs: new Set<string>() };
  if (!hint) return;
  hint.messageIDs.add(messageID);
  if (hint.messageIDs.size > MAX_HINTED_MESSAGES) { hints.delete(next); return; }
  hints.set(next, hint);
}
export function getPartChangeHints(next: State['part'], previous: State['part']): ReadonlySet<string> | undefined {
  const hint = hints.get(next);
  return hint?.base.deref() === previous ? hint.messageIDs : undefined;
}

export function invalidatePartChangeHints(parts: State['part']): void { hints.delete(parts); }
