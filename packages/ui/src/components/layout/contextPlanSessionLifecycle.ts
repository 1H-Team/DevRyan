import type { ContextPanelMode } from '@/stores/useUIStore';

export const shouldCollapseContextPlanForSessionChange = ({
  previousSessionId,
  currentSessionId,
  isPanelOpen,
  activeMode,
}: {
  previousSessionId: string | null | undefined;
  currentSessionId: string | null;
  isPanelOpen: boolean;
  activeMode: ContextPanelMode | null;
}): boolean => (
  previousSessionId !== undefined
  && previousSessionId !== currentSessionId
  && isPanelOpen
  && activeMode === 'plan'
);
