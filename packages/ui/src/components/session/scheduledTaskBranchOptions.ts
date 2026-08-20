import type { ProjectEntry } from '@/lib/api/types';
import type { AuthPrincipal } from '@/lib/authSession';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';

export type ScheduledTaskBranchOption = NonNullable<ProjectEntry['branches']>[number];

const dedupeBranchOptions = (branches: ScheduledTaskBranchOption[]): ScheduledTaskBranchOption[] => {
  const byName = new Map<string, ScheduledTaskBranchOption>();

  for (const branch of branches) {
    const name = branch.name.trim();
    if (!name) continue;

    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { ...branch, name });
      continue;
    }

    if (branch.isDefault && !existing.isDefault) {
      byName.set(name, { ...existing, isDefault: true });
    }
  }

  return [...byName.values()];
};

export const resolveScheduledTaskBranchOptions = ({
  principal,
  project,
  task,
}: {
  principal: AuthPrincipal;
  project: ProjectEntry | null;
  task: Pick<ScheduledTask, 'ownerUserId'> | null;
}): ScheduledTaskBranchOption[] => {
  if (!project) return [];

  const isPersonalManagedTask = principal.scope === 'managed'
    && (task === null || task.ownerUserId === principal.id);
  const branches = isPersonalManagedTask
    ? principal.assignments
      .filter((assignment) => assignment.projectId === project.id)
      .map((assignment) => ({
        name: assignment.branchName,
        directory: assignment.publicDirectory,
        isDefault: assignment.isDefault,
      }))
    : project.branches || [];

  return dedupeBranchOptions(branches);
};
