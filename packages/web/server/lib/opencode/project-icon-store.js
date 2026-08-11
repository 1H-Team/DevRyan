const MANIFEST_VERSION = 1;

export const createProjectIconStore = ({ fsPromises, path, crypto, dataDirectory, logger = console }) => {
  const iconsDirectory = path.join(dataDirectory, 'project-icons');
  const manifestPath = path.join(iconsDirectory, 'manifest.json');
  const mimeToExtension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
  };
  let operationLock = Promise.resolve();

  const runExclusive = async (operation) => {
    const result = operationLock.then(operation, operation);
    operationLock = result.catch(() => {});
    return result;
  };

  const projectIconBaseName = (projectId) => {
    const hash = crypto.createHash('sha1').update(projectId).digest('hex');
    return `project-${hash}`;
  };

  const fileNameFor = (projectId, mime) => {
    const extension = mimeToExtension[mime];
    return extension ? `${projectIconBaseName(projectId)}.${extension}` : null;
  };

  const candidatePaths = (projectId) => Object.values(mimeToExtension).map(
    (extension) => path.join(iconsDirectory, `${projectIconBaseName(projectId)}.${extension}`)
  );

  const iconImageFromEntry = (entry) => ({
    mime: entry.mime,
    updatedAt: entry.updatedAt,
    source: entry.source,
  });

  const normalizeEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const projectId = typeof entry.projectId === 'string' ? entry.projectId.trim() : '';
    const projectPath = typeof entry.projectPath === 'string' ? entry.projectPath.trim() : '';
    const mime = typeof entry.mime === 'string' && mimeToExtension[entry.mime] ? entry.mime : '';
    const source = entry.source === 'custom' || entry.source === 'auto' ? entry.source : '';
    const updatedAt = Number.isFinite(entry.updatedAt) && entry.updatedAt > 0
      ? Math.round(entry.updatedAt)
      : 0;
    const fileName = typeof entry.fileName === 'string' ? entry.fileName.trim() : '';
    if (!projectId || !projectPath || !mime || !source || !updatedAt || !fileName) return null;
    if (path.basename(fileName) !== fileName || path.extname(fileName).slice(1) !== mimeToExtension[mime]) return null;
    return { projectId, projectPath, mime, source, updatedAt, fileName };
  };

  const emptyManifest = () => ({ version: MANIFEST_VERSION, icons: [] });

  const readManifestUnlocked = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(manifestPath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return emptyManifest();
      throw error;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.icons)) {
      throw new Error('Project icon manifest is invalid');
    }
    const icons = parsed.icons.map(normalizeEntry);
    if (icons.some((entry) => entry === null)) {
      throw new Error('Project icon manifest contains an invalid entry');
    }
    return { version: MANIFEST_VERSION, icons };
  };

  const writeManifestUnlocked = async (manifest) => {
    await fsPromises.mkdir(iconsDirectory, { recursive: true });
    const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
      await fsPromises.rename(temporaryPath, manifestPath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const entryForProject = (manifest, project) => manifest.icons.find(
    (entry) => entry.projectId === project.id
  ) || manifest.icons.find((entry) => entry.projectPath === project.path) || null;

  const pathExists = async (filePath) => {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
      throw error;
    }
  };

  const removePaths = async (paths) => {
    await Promise.all(Array.from(new Set(paths)).map(async (filePath) => {
      try {
        await fsPromises.rm(filePath, { force: true });
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      }
    }));
  };

  const replaceIcon = async ({ project, mime, source, updatedAt, bytes }, persistMetadata) => runExclusive(async () => {
    const fileName = fileNameFor(project.id, mime);
    if (!fileName) throw new Error('Unsupported icon format');

    const previousManifest = await readManifestUnlocked();
    const nextEntry = {
      projectId: project.id,
      projectPath: project.path,
      mime,
      source,
      updatedAt,
      fileName,
    };
    const nextManifest = {
      version: MANIFEST_VERSION,
      icons: [
        ...previousManifest.icons.filter(
          (entry) => entry.projectId !== project.id && entry.projectPath !== project.path
        ),
        nextEntry,
      ],
    };

    await fsPromises.mkdir(iconsDirectory, { recursive: true });
    const finalPath = path.join(iconsDirectory, fileName);
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const temporaryPath = `${finalPath}.tmp-${suffix}`;
    const backupPath = `${finalPath}.bak-${suffix}`;
    const hadPreviousFinal = await pathExists(finalPath);
    let finalInstalled = false;
    let manifestInstalled = false;

    let result;
    try {
      await fsPromises.writeFile(temporaryPath, bytes);
      if (hadPreviousFinal) await fsPromises.rename(finalPath, backupPath);
      await fsPromises.rename(temporaryPath, finalPath);
      finalInstalled = true;
      await writeManifestUnlocked(nextManifest);
      manifestInstalled = true;

      result = await persistMetadata(iconImageFromEntry(nextEntry));
    } catch (error) {
      if (manifestInstalled) {
        await writeManifestUnlocked(previousManifest).catch(() => {});
      }
      if (finalInstalled) await fsPromises.rm(finalPath, { force: true }).catch(() => {});
      if (hadPreviousFinal) await fsPromises.rename(backupPath, finalPath).catch(() => {});
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }

    await fsPromises.rm(backupPath, { force: true }).catch((error) => {
      logger.warn?.('[project-icons] Failed to remove icon backup:', error);
    });
    await removePaths(candidatePaths(project.id).filter((candidate) => candidate !== finalPath)).catch((error) => {
      logger.warn?.('[project-icons] Failed to remove superseded icon files:', error);
    });
    return result;
  });

  const deleteIcon = async ({ project }, persistMetadata) => runExclusive(async () => {
    const previousManifest = await readManifestUnlocked();
    const previousEntry = entryForProject(previousManifest, project);
    const nextManifest = {
      version: MANIFEST_VERSION,
      icons: previousManifest.icons.filter(
        (entry) => entry.projectId !== project.id && entry.projectPath !== project.path
      ),
    };
    const manifestChanged = nextManifest.icons.length !== previousManifest.icons.length;

    if (manifestChanged) await writeManifestUnlocked(nextManifest);
    let result;
    try {
      result = await persistMetadata(null);
    } catch (error) {
      if (manifestChanged) await writeManifestUnlocked(previousManifest).catch(() => {});
      throw error;
    }

    const projectIds = [project.id, previousEntry?.projectId].filter(Boolean);
    await removePaths(projectIds.flatMap(candidatePaths)).catch((error) => {
      logger.warn?.('[project-icons] Failed to remove deleted icon files:', error);
    });
    return result;
  });

  const resolveIcon = async (project) => runExclusive(async () => {
    const manifest = await readManifestUnlocked();
    const entry = entryForProject(manifest, project);
    if (!entry) return null;
    const filePath = path.join(iconsDirectory, entry.fileName);
    if (!(await pathExists(filePath))) return null;
    return { filePath, iconImage: iconImageFromEntry(entry) };
  });

  const migrateProjectId = async ({ oldId, newId, projectPath }) => runExclusive(async () => {
    if (!oldId || !newId || oldId === newId) return;

    const manifest = await readManifestUnlocked();
    const entryIndex = manifest.icons.findIndex(
      (entry) => entry.projectId === oldId || entry.projectPath === projectPath
    );
    if (entryIndex < 0) {
      await fsPromises.mkdir(iconsDirectory, { recursive: true });
      for (const extension of Object.values(mimeToExtension)) {
        const oldPath = path.join(iconsDirectory, `${projectIconBaseName(oldId)}.${extension}`);
        const newPath = path.join(iconsDirectory, `${projectIconBaseName(newId)}.${extension}`);
        if (!(await pathExists(oldPath))) continue;
        if (await pathExists(newPath)) {
          await fsPromises.rm(oldPath, { force: true });
        } else {
          await fsPromises.rename(oldPath, newPath);
        }
      }
      return;
    }

    const previousEntry = manifest.icons[entryIndex];
    const oldPath = path.join(iconsDirectory, previousEntry.fileName);
    if (!(await pathExists(oldPath))) return;
    const nextFileName = fileNameFor(newId, previousEntry.mime);
    const nextPath = path.join(iconsDirectory, nextFileName);
    const nextEntry = {
      ...previousEntry,
      projectId: newId,
      projectPath,
      fileName: nextFileName,
    };
    const nextManifest = {
      version: MANIFEST_VERSION,
      icons: manifest.icons.map((entry, index) => index === entryIndex ? nextEntry : entry),
    };

    if (oldPath === nextPath) {
      await writeManifestUnlocked(nextManifest);
      return;
    }

    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const temporaryPath = `${nextPath}.tmp-${suffix}`;
    const backupPath = `${nextPath}.bak-${suffix}`;
    const hadPreviousTarget = await pathExists(nextPath);
    let targetInstalled = false;
    try {
      const bytes = await fsPromises.readFile(oldPath);
      await fsPromises.writeFile(temporaryPath, bytes);
      if (hadPreviousTarget) await fsPromises.rename(nextPath, backupPath);
      await fsPromises.rename(temporaryPath, nextPath);
      targetInstalled = true;
      await writeManifestUnlocked(nextManifest);
    } catch (error) {
      if (targetInstalled) await fsPromises.rm(nextPath, { force: true }).catch(() => {});
      if (hadPreviousTarget) await fsPromises.rename(backupPath, nextPath).catch(() => {});
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }

    await fsPromises.rm(backupPath, { force: true }).catch((error) => {
      logger.warn?.('[project-icons] Failed to remove migrated icon backup:', error);
    });
    await fsPromises.rm(oldPath, { force: true }).catch((error) => {
      logger.warn?.('[project-icons] Failed to remove old migrated icon:', error);
    });
  });

  const reconcileProjects = async (projects) => runExclusive(async () => {
    const manifest = await readManifestUnlocked();
    if (manifest.icons.length === 0 || !Array.isArray(projects) || projects.length === 0) {
      return { projects, changed: false };
    }

    let manifestChanged = false;
    let projectsChanged = false;
    const nextEntries = [...manifest.icons];
    const nextProjects = [];

    for (const project of projects) {
      const projectIdEntryIndex = nextEntries.findIndex((entry) => entry.projectId === project.id);
      const entryIndex = projectIdEntryIndex >= 0
        ? projectIdEntryIndex
        : nextEntries.findIndex((entry) => entry.projectPath === project.path);
      if (entryIndex < 0) {
        nextProjects.push(project);
        continue;
      }

      let entry = nextEntries[entryIndex];
      let filePath = path.join(iconsDirectory, entry.fileName);
      if (!(await pathExists(filePath))) {
        nextEntries.splice(entryIndex, 1);
        manifestChanged = true;
        if (project.iconImage !== null) {
          nextProjects.push({ ...project, iconImage: null });
          projectsChanged = true;
        } else {
          nextProjects.push(project);
        }
        continue;
      }

      if (entry.projectId !== project.id) {
        const nextFileName = fileNameFor(project.id, entry.mime);
        const nextFilePath = path.join(iconsDirectory, nextFileName);
        if (nextFilePath !== filePath) {
          const bytes = await fsPromises.readFile(filePath);
          const temporaryPath = `${nextFilePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await fsPromises.writeFile(temporaryPath, bytes);
          await fsPromises.rename(temporaryPath, nextFilePath);
          filePath = nextFilePath;
        }
        entry = { ...entry, projectId: project.id, projectPath: project.path, fileName: nextFileName };
        nextEntries[entryIndex] = entry;
        manifestChanged = true;
      }

      const iconImage = iconImageFromEntry(entry);
      if (JSON.stringify(project.iconImage ?? null) !== JSON.stringify(iconImage)) {
        nextProjects.push({ ...project, iconImage });
        projectsChanged = true;
      } else {
        nextProjects.push(project);
      }
    }

    if (manifestChanged) {
      await writeManifestUnlocked({ version: MANIFEST_VERSION, icons: nextEntries });
      const referencedNames = new Set(nextEntries.map((entry) => entry.fileName));
      const migratedEntries = manifest.icons.filter((entry) => !referencedNames.has(entry.fileName));
      await removePaths(migratedEntries.map((entry) => path.join(iconsDirectory, entry.fileName)));
    }

    return { projects: projectsChanged ? nextProjects : projects, changed: projectsChanged };
  });

  return {
    candidatePaths,
    deleteIcon,
    migrateProjectId,
    reconcileProjects,
    replaceIcon,
    resolveIcon,
  };
};
