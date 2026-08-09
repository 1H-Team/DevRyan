import type { UserAnalyticsEvent } from './types';

export interface PromptSessionGroup {
  key: string;
  sessionId: string | null;
  events: UserAnalyticsEvent[];
}

export const resolveAnalyticsDetailRange = (
  range: { start: string; end: string },
  selectedDate: string | null,
): { start: string; end: string } => (
  selectedDate ? { start: selectedDate, end: selectedDate } : range
);

export const nextSelectedAnalyticsDate = (current: string | null, date: string): string | null => (
  current === date ? null : date
);

export const groupPromptEventsBySession = (events: UserAnalyticsEvent[]): PromptSessionGroup[] => {
  const groups = new Map<string, PromptSessionGroup>();
  for (const event of events) {
    const sessionId = event.session_id?.trim() || null;
    const key = sessionId ? `session:${sessionId}` : 'unattributed';
    const group = groups.get(key) ?? { key, sessionId, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.events.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  }
  return [...groups.values()].sort((left, right) => (
    Date.parse(right.events[0]?.created_at ?? '') - Date.parse(left.events[0]?.created_at ?? '')
  ));
};
