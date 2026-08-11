import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectIconStore } from './project-icon-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true })
  ));
});

const createFixture = async (fsPromises = fs) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-project-icons-'));
  temporaryDirectories.push(dataDirectory);
  return {
    dataDirectory,
    store: createProjectIconStore({ fsPromises, path, crypto, dataDirectory }),
  };
};

const readManifest = async (dataDirectory) => JSON.parse(
  await fs.readFile(path.join(dataDirectory, 'project-icons', 'manifest.json'), 'utf8')
);

describe('project icon store', () => {
  it('restores manifest-backed metadata after a runtime restart', async () => {
    const { dataDirectory, store } = await createFixture();
    const project = { id: 'legacy-id', path: '/tmp/project-one' };
    const iconImage = { mime: 'image/png', source: 'custom', updatedAt: 1234 };

    await store.replaceIcon({ ...iconImage, project, bytes: Buffer.from('icon-one') }, async (metadata) => {
      expect(metadata).toEqual(iconImage);
      return metadata;
    });

    const restartedStore = createProjectIconStore({ fsPromises: fs, path, crypto, dataDirectory });
    const reconciled = await restartedStore.reconcileProjects([{ ...project, iconImage: null }]);
    const resolved = await restartedStore.resolveIcon(project);

    expect(reconciled).toEqual({
      changed: true,
      projects: [{ ...project, iconImage }],
    });
    expect(await fs.readFile(resolved.filePath, 'utf8')).toBe('icon-one');
  });

  it('migrates manifest-backed files when a project ID changes but its path remains stable', async () => {
    const { dataDirectory, store } = await createFixture();
    const oldProject = { id: 'random-id', path: '/tmp/project-two' };
    const newProject = { id: 'path_deterministic', path: oldProject.path };

    await store.replaceIcon({
      project: oldProject,
      mime: 'image/svg+xml',
      source: 'custom',
      updatedAt: 2000,
      bytes: Buffer.from('<svg/>'),
    }, async () => null);
    const oldManifest = await readManifest(dataDirectory);
    const oldPath = path.join(dataDirectory, 'project-icons', oldManifest.icons[0].fileName);

    const reconciled = await store.reconcileProjects([newProject]);
    const nextManifest = await readManifest(dataDirectory);
    const resolved = await store.resolveIcon(newProject);

    expect(reconciled.projects[0]).toMatchObject({
      id: newProject.id,
      iconImage: { mime: 'image/svg+xml', source: 'custom', updatedAt: 2000 },
    });
    expect(nextManifest.icons[0]).toMatchObject({ projectId: newProject.id, projectPath: newProject.path });
    expect(nextManifest.icons[0].fileName).not.toBe(oldManifest.icons[0].fileName);
    await expect(fs.access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(resolved.filePath, 'utf8')).toBe('<svg/>');
  });

  it('keeps a still-visible legacy icon through a known project ID migration without adopting it', async () => {
    const { store } = await createFixture();
    const oldId = 'legacy-random-id';
    const newId = 'path_current';
    const oldPath = store.candidatePaths(oldId)[0];
    const newPath = store.candidatePaths(newId)[0];
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, 'legacy-visible');

    await store.migrateProjectId({ oldId, newId, projectPath: '/tmp/project-legacy' });

    await expect(fs.access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(newPath, 'utf8')).toBe('legacy-visible');
    expect(await store.resolveIcon({ id: newId, path: '/tmp/project-legacy' })).toBeNull();
  });

  it('rolls back image and manifest changes when settings persistence fails', async () => {
    const { dataDirectory, store } = await createFixture();
    const project = { id: 'project-three', path: '/tmp/project-three' };

    await store.replaceIcon({
      project,
      mime: 'image/png',
      source: 'custom',
      updatedAt: 3000,
      bytes: Buffer.from('original'),
    }, async () => null);
    const previousManifest = await readManifest(dataDirectory);

    await expect(store.replaceIcon({
      project,
      mime: 'image/png',
      source: 'custom',
      updatedAt: 4000,
      bytes: Buffer.from('replacement'),
    }, async () => {
      throw new Error('settings write failed');
    })).rejects.toThrow('settings write failed');

    const resolved = await store.resolveIcon(project);
    expect(await readManifest(dataDirectory)).toEqual(previousManifest);
    expect(await fs.readFile(resolved.filePath, 'utf8')).toBe('original');
    expect((await fs.readdir(path.join(dataDirectory, 'project-icons'))).some(
      (name) => name.includes('.tmp-') || name.includes('.bak-')
    )).toBe(false);
  });

  it.each([
    ['image temporary file', (filePath) => filePath.includes('.png.tmp-')],
    ['manifest temporary file', (filePath) => filePath.includes('manifest.json.tmp-')],
  ])('preserves the previous icon when writing the %s fails', async (_label, shouldFail) => {
    const fixture = await createFixture();
    const project = { id: 'project-four', path: '/tmp/project-four' };
    await fixture.store.replaceIcon({
      project,
      mime: 'image/png',
      source: 'custom',
      updatedAt: 5000,
      bytes: Buffer.from('original'),
    }, async () => null);
    const previousManifest = await readManifest(fixture.dataDirectory);

    const failingFs = {
      ...fs,
      writeFile: vi.fn(async (filePath, ...args) => {
        if (shouldFail(String(filePath))) throw new Error('injected write failure');
        return fs.writeFile(filePath, ...args);
      }),
    };
    const failingStore = createProjectIconStore({
      fsPromises: failingFs,
      path,
      crypto,
      dataDirectory: fixture.dataDirectory,
    });

    await expect(failingStore.replaceIcon({
      project,
      mime: 'image/png',
      source: 'custom',
      updatedAt: 6000,
      bytes: Buffer.from('replacement'),
    }, async () => null)).rejects.toThrow('injected write failure');

    const resolved = await fixture.store.resolveIcon(project);
    expect(await readManifest(fixture.dataDirectory)).toEqual(previousManifest);
    expect(await fs.readFile(resolved.filePath, 'utf8')).toBe('original');
  });

  it('removes manifest state on delete and does not restore the icon after restart', async () => {
    const { dataDirectory, store } = await createFixture();
    const project = { id: 'project-five', path: '/tmp/project-five' };

    await store.replaceIcon({
      project,
      mime: 'image/jpeg',
      source: 'custom',
      updatedAt: 7000,
      bytes: Buffer.from('jpeg'),
    }, async () => null);
    await store.deleteIcon({ project }, async (metadata) => {
      expect(metadata).toBeNull();
      return null;
    });

    const restartedStore = createProjectIconStore({ fsPromises: fs, path, crypto, dataDirectory });
    expect(await restartedStore.resolveIcon(project)).toBeNull();
    expect(await restartedStore.reconcileProjects([{ ...project, iconImage: null }])).toEqual({
      projects: [{ ...project, iconImage: null }],
      changed: false,
    });
    expect((await readManifest(dataDirectory)).icons).toEqual([]);
  });

  it('keeps the icon when deletion metadata persistence fails', async () => {
    const { dataDirectory, store } = await createFixture();
    const project = { id: 'project-six', path: '/tmp/project-six' };
    await store.replaceIcon({
      project,
      mime: 'image/png',
      source: 'custom',
      updatedAt: 8000,
      bytes: Buffer.from('keep-me'),
    }, async () => null);
    const previousManifest = await readManifest(dataDirectory);

    await expect(store.deleteIcon({ project }, async () => {
      throw new Error('settings delete failed');
    })).rejects.toThrow('settings delete failed');

    const resolved = await store.resolveIcon(project);
    expect(await readManifest(dataDirectory)).toEqual(previousManifest);
    expect(await fs.readFile(resolved.filePath, 'utf8')).toBe('keep-me');
  });

  it('ignores legacy icon files that have no manifest entry', async () => {
    const { dataDirectory, store } = await createFixture();
    const project = { id: 'legacy-project', path: '/tmp/legacy-project', iconImage: null };
    const legacyPath = store.candidatePaths(project.id)[0];
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, 'legacy');

    expect(await store.reconcileProjects([project])).toEqual({ projects: [project], changed: false });
    expect(await store.resolveIcon(project)).toBeNull();
    expect(await fs.readFile(legacyPath, 'utf8')).toBe('legacy');
  });
});
