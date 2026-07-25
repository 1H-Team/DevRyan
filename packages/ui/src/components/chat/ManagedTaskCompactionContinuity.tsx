import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { cn } from '@/lib/utils';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { ManagedTaskList } from './ManagedTaskList';
import { selectCompactionCarryoverTaskIds } from './managedTaskCompactionProjection';

export const ManagedTaskCompactionContinuity = React.memo(({
  rootSessionId,
  compactionBoundaryAt,
  isMobile,
  onContentChange,
}: {
  rootSessionId: string;
  compactionBoundaryAt: number | null;
  isMobile: boolean;
  onContentChange: (reason?: ContentChangeReason) => void;
}) => {
  const taskIds = useManagedOrchestrationStore(useShallow(React.useCallback(
    (state) => selectCompactionCarryoverTaskIds(
      state,
      rootSessionId,
      compactionBoundaryAt,
    ),
    [compactionBoundaryAt, rootSessionId],
  )));
  const handleContentChange = React.useCallback(() => {
    onContentChange('structural');
  }, [onContentChange]);

  if (taskIds.length === 0) {
    return null;
  }

  return (
    <div
      data-managed-task-continuity="compaction"
      className={cn(isMobile && 'chat-message-column')}
    >
      <ManagedTaskList
        taskIds={taskIds}
        onContentChange={handleContentChange}
        isMobile={isMobile}
      />
    </div>
  );
});

ManagedTaskCompactionContinuity.displayName = 'ManagedTaskCompactionContinuity';
