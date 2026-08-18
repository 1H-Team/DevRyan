import { describe, expect, test } from 'bun:test';

import type { AuthAssignment, AuthPrincipal } from '@/lib/authSession';
import { isIntegrateTempProjectPath, projectManagedAssignments, useProjectsStore } from './useProjectsStore';

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

  test('uses shared assignment visuals over stale cached project metadata', () => {
    const iconImage = { mime: 'image/png', updatedAt: 1234, source: 'custom' as const };
    const result = projectManagedAssignments({
      assignments: [
        assignment({
          projectId: 'project-one',
          publicDirectory: '/projects/project-one/main',
          isDefault: true,
          icon: 'rocket',
          color: 'primary',
          iconBackground: '#123456',
          iconImage,
        }),
        assignment({
          projectId: 'project-one',
          publicDirectory: '/projects/project-one/feature',
          branchName: 'feature',
          icon: 'rocket',
          color: 'primary',
          iconBackground: '#123456',
          iconImage,
        }),
      ],
    }, [{
      id: 'project-one',
      path: '/old/path',
      label: 'Stale',
      icon: 'code',
      color: 'error',
      iconBackground: '#ffffff',
      iconImage: { mime: 'image/jpeg', updatedAt: 1, source: 'auto' },
      sidebarCollapsed: true,
      lastOpenedAt: 99,
    }]);

    expect(result.projects[0]?.id).toBe('project-one');
    expect(result.projects[0]?.icon).toBe('rocket');
    expect(result.projects[0]?.color).toBe('primary');
    expect(result.projects[0]?.iconBackground).toBe('#123456');
    expect(result.projects[0]?.iconImage).toEqual(iconImage);
    expect(result.projects[0]?.sidebarCollapsed).toBe(true);
    expect(result.projects[0]?.lastOpenedAt).toBe(99);
    expect(result.projects[0]?.branches).toHaveLength(2);
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
        browser: true,
        createWorktrees: false,
        createBranches: false,
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

describe('git-integrate temp project paths', () => {
  test('detects leftover integrate worktree directories', () => {
    expect(isIntegrateTempProjectPath('/var/folders/xx/T/devryan-integrate-T86Wwm')).toBe(true);
    expect(isIntegrateTempProjectPath('/private/var/folders/xx/T/devryan-integrate-abc123')).toBe(true);
    expect(isIntegrateTempProjectPath('/Users/zoubair/Repositories/DevRyan')).toBe(false);
  });

  test('refuses to add integrate temp directories to the local project list', () => {
    const before = useProjectsStore.getState().projects;
    expect(useProjectsStore.getState().addProject('/tmp/devryan-integrate-T86Wwm')).toBeNull();
    expect(useProjectsStore.getState().projects).toBe(before);
  });
});
