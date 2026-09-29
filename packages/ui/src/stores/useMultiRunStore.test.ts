import { expect, spyOn, test } from 'bun:test';
import { useMultiRunStore } from './useMultiRunStore';
import { useProjectsStore } from './useProjectsStore';
import { useDirectoryStore } from './useDirectoryStore';
import { opencodeClient } from '../lib/opencode/client';
import * as git from '../lib/gitApi';

test('multi-run resolves the requested project without repointing navigation while creation waits or fails', async () => {
  const previous = useProjectsStore.getState();
  const directory = useDirectoryStore.getState().currentDirectory;
  const clientDirectory = opencodeClient.getDirectory();
  let release!: (value: boolean) => void;
  const blocked = new Promise<boolean>(resolve => { release = resolve; });
  const checkGit = spyOn(git, 'checkIsGitRepository').mockImplementation(() => blocked);
  const params = { projectId: 'target', name: 'fixture', prompt: 'fixture', models: [{ providerID: 'fixture', modelID: 'fixture' }] };
  try {
    useProjectsStore.setState({ activeProjectId: 'displayed', projects: [
      { id: 'displayed', path: '/fixture/displayed', addedAt: 1 },
      { id: 'target', path: '/fixture/target', addedAt: 1 },
    ] });
    const pending = useMultiRunStore.getState().createMultiRun(params);
    expect(checkGit).toHaveBeenCalledWith('/fixture/target');
    expect(useProjectsStore.getState().activeProjectId).toBe('displayed');
    release(false);
    expect(await pending).toBeNull();
    expect(useProjectsStore.getState().activeProjectId).toBe('displayed');
    expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
    expect(opencodeClient.getDirectory()).toBe(clientDirectory);
    expect(await useMultiRunStore.getState().createMultiRun({ ...params, projectId: 'missing' })).toBeNull();
    expect(checkGit).toHaveBeenCalledTimes(1);
  } finally { release(false); checkGit.mockRestore(); useProjectsStore.setState(previous); }
});
