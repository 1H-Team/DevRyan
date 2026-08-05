import { describe, expect, test } from 'bun:test';

import type { AuthAssignment, AuthPrincipal } from '@/lib/authSession';
import { projectManagedAssignments, useProjectsStore } from './useProjectsStore';

const assignment = (
  overrides: Partial<AuthAssignment> & Pick<AuthAssignment, 'projectId' | 'publicDirectory'>,
): AuthAssignment => ({
  label: 'Assigned project',
  branchName: 'main',
  githubAccountId: null,
  isDefault: false,
  ...overrides,
});

describe('managed project projection', () => {
  test('replaces host settings projects with the accepted assignments', () => {
    const result = projectManagedAssignments({
      assignments: [
        assignment({
          projectId: 'project-assigned',
          publicDirectory: '/projects/project-assigned/main',
          isDefault: true,
        }),
      ],
    }, [
      { id: 'host-project', path: '/Users/admin/private-project', label: 'Host project' },
      { id: 'project-assigned', path: '/Users/admin/assigned-project', label: 'Old label', color: 'blue' },
    ]);

    expect(result.activeProjectId).toBe('project-assigned');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toEqual({
      id: 'project-assigned',
      path: '/projects/project-assigned/main',
      label: 'Assigned project',
      color: 'blue',
      branches: [{
        name: 'main',
        directory: '/projects/project-assigned/main',
        isDefault: true,
      }],
    });
    expect(JSON.stringify(result.projects)).not.toContain('/Users/admin');
  });

  test('groups assigned branches under one project and selects the default project', () => {
    const result = projectManagedAssignments({
      assignments: [
        assignment({
          projectId: 'project-one',
          publicDirectory: '/projects/project-one/feature',
          branchName: 'feature',
        }),
        assignment({
          projectId: 'project-one',
          publicDirectory: '/projects/project-one/main',
          branchName: 'main',
          isDefault: true,
        }),
        assignment({
          projectId: 'project-two',
          publicDirectory: '/projects/project-two/main',
        }),
      ],
    });

    expect(result.activeProjectId).toBe('project-one');
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]?.path).toBe('/projects/project-one/main');
    expect(result.projects[0]?.branches).toEqual([
      { name: 'feature', directory: '/projects/project-one/feature', isDefault: false },
      { name: 'main', directory: '/projects/project-one/main', isDefault: true },
    ]);
  });

  test('applies assignments before settings hydration can expose stale projects', () => {
    useProjectsStore.setState({
      projects: [{ id: 'host-project', path: '/Users/admin/private-project' }],
      activeProjectId: 'host-project',
    });
    const principal: AuthPrincipal = {
      id: 'developer-one',
      email: 'developer@example.test',
      displayName: 'Developer',
      role: 'developer',
      scope: 'managed',
      policy: {
        settingsPages: ['appearance'],
        files: true,
        terminal: false,
        manageProjects: false,
        manageUsers: false,
        manageGlobalSettings: false,
        manageGit: true,
        push: false,
        github: false,
      },
      assignments: [assignment({
        projectId: 'assigned-project',
        publicDirectory: '/projects/assigned-project/main',
        isDefault: true,
      })],
    };

    useProjectsStore.getState().synchronizeManagedAssignments(principal);

    expect(useProjectsStore.getState().activeProjectId).toBe('assigned-project');
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual([
      '/projects/assigned-project/main',
    ]);
  });
});
