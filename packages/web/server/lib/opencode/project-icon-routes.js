export const registerProjectIconRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    openchamberDataDir,
    projectIconStore,
    sanitizeProjects,
    readSettingsFromDiskMigrated,
    persistSettings,
    createFsSearchRuntime,
    spawn,
    resolveGitBinaryForSpawn,
    resolveManagedProject,
  } = dependencies;

  const projectIconsDirPath = path.join(openchamberDataDir, 'project-icons');
  const projectIconMimeToExtension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
  };
  const projectIconExtensionToMime = Object.fromEntries(
    Object.entries(projectIconMimeToExtension).map(([mime, ext]) => [ext, mime])
  );
  const projectIconSupportedMimes = new Set(Object.keys(projectIconMimeToExtension));
  const projectIconMaxBytes = 5 * 1024 * 1024;
  const projectIconThemeColors = {
    light: '#111111',
    dark: '#f5f5f5',
  };
  const projectIconHexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

  const normalizeProjectIconMime = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'image/jpg') {
      return 'image/jpeg';
    }
    if (projectIconSupportedMimes.has(normalized)) {
      return normalized;
    }
    return null;
  };

  const projectIconBaseName = (projectId) => {
    const hash = crypto.createHash('sha1').update(projectId).digest('hex');
    return `project-${hash}`;
  };

  const projectIconPathForMime = (projectId, mime) => {
    const normalizedMime = normalizeProjectIconMime(mime);
    if (!normalizedMime) {
      return null;
    }
    const ext = projectIconMimeToExtension[normalizedMime];
    return path.join(projectIconsDirPath, `${projectIconBaseName(projectId)}.${ext}`);
  };

  const projectIconPathCandidates = (projectId) => {
    const base = projectIconBaseName(projectId);
    return Object.values(projectIconMimeToExtension).map((ext) => path.join(projectIconsDirPath, `${base}.${ext}`));
  };

  const removeProjectIconFiles = async (projectId, keepPath) => {
    const candidates = projectIconPathCandidates(projectId);
    await Promise.all(candidates.map(async (candidatePath) => {
      if (keepPath && candidatePath === keepPath) {
        return;
      }
      try {
        await fsPromises.unlink(candidatePath);
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }));
  };

  const parseProjectIconDataUrl = (value) => {
    if (typeof value !== 'string') {
      return { ok: false, error: 'dataUrl is required' };
    }

    const trimmed = value.trim();
    const match = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return { ok: false, error: 'Invalid dataUrl format' };
    }

    const mime = normalizeProjectIconMime(match[1]);
    if (!mime || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) {
      return { ok: false, error: 'Icon must be PNG, JPEG, or SVG' };
    }

    try {
      const base64 = match[2].replace(/\s+/g, '');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return { ok: false, error: 'Icon content is empty' };
      }
      if (bytes.length > projectIconMaxBytes) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }
      return { ok: true, mime, bytes };
    } catch {
      return { ok: false, error: 'Failed to decode icon data' };
    }
  };

  const normalizeProjectIconThemeVariant = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'light' || normalized === 'dark') {
      return normalized;
    }
    return null;
  };

  const normalizeProjectIconColor = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!projectIconHexColorPattern.test(normalized)) {
      return null;
    }
    return normalized;
  };

  const applyProjectIconSvgTheme = (svgMarkup, themeVariant, iconColor) => {
    if (typeof svgMarkup !== 'string') {
      return svgMarkup;
    }

    const color = iconColor || projectIconThemeColors[themeVariant];
    if (!color) {
      return svgMarkup;
    }

    const svgTagIndex = svgMarkup.search(/<svg\b/i);
    if (svgTagIndex === -1) {
      return svgMarkup;
    }

    const svgOpenTagEndIndex = svgMarkup.indexOf('>', svgTagIndex);
    if (svgOpenTagEndIndex === -1) {
      return svgMarkup;
    }

    const overrideStyle = `<style data-openchamber-theme-icon="1">:root{color:${color}!important;}</style>`;
    return `${svgMarkup.slice(0, svgOpenTagEndIndex + 1)}${overrideStyle}${svgMarkup.slice(svgOpenTagEndIndex + 1)}`;
  };

  const findProjectById = (settings, projectId) => {
    const projects = sanitizeProjects(settings?.projects) || [];
    const index = projects.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return { projects, index: -1, project: null };
    }
    return { projects, index, project: projects[index] };
  };

  const resolveProjectById = async (req, projectId) => {
    const settings = await readSettingsFromDiskMigrated();
    const local = findProjectById(settings, projectId);
    if (local.project) return { ...local, managed: null };
    if (typeof resolveManagedProject !== 'function') return { ...local, managed: null };
    const managed = await resolveManagedProject(req, projectId);
    return {
      projects: local.projects,
      index: -1,
      project: managed?.project ?? null,
      managed: managed ?? null,
    };
  };

  const persistProjectIconImage = async ({ projects, projectId, iconImage, managed }) => {
    if (managed) {
      if (!managed.canMutate) {
        throw Object.assign(new Error('Project metadata can only be changed by an administrator'), { statusCode: 403 });
      }
      const project = await managed.persistIconImage(iconImage);
      return { project, settings: null };
    }
    const nextProjects = projects.map((entry) => (
      entry.id === projectId ? { ...entry, iconImage } : entry
    ));
    const settings = await persistSettings({ projects: nextProjects });
    const project = (settings.projects || []).find((entry) => entry.id === projectId) || null;
    return { project, settings };
  };

  const fsSearchRuntime = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn,
  });

  app.get('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const { project } = await resolveProjectById(req, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const manifestIcon = projectIconStore ? await projectIconStore.resolveIcon(project) : null;
      const metadataMime = normalizeProjectIconMime(manifestIcon?.iconImage?.mime || project.iconImage?.mime);
      const preferredPath = manifestIcon?.filePath
        || (metadataMime ? projectIconPathForMime(projectId, metadataMime) : null);
      const candidates = preferredPath
        ? [preferredPath, ...projectIconPathCandidates(projectId).filter((candidate) => candidate !== preferredPath)]
        : projectIconPathCandidates(projectId);

      const themeQuery = Array.isArray(req.query?.theme) ? req.query.theme[0] : req.query?.theme;
      const requestedThemeVariant = normalizeProjectIconThemeVariant(themeQuery);
      const iconColorQuery = Array.isArray(req.query?.iconColor) ? req.query.iconColor[0] : req.query?.iconColor;
      const requestedIconColor = normalizeProjectIconColor(iconColorQuery);

      for (const iconPath of candidates) {
        try {
          const data = await fsPromises.readFile(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = metadataMime || projectIconExtensionToMime[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;

          if (resolvedMime === 'image/svg+xml' && requestedThemeVariant) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          if (resolvedMime === 'image/svg+xml' && requestedIconColor) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(data);
        } catch (error) {
          if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
            console.warn('Failed to read project icon:', error);
            return res.status(500).json({ error: 'Failed to read project icon' });
          }
        }
      }

      return res.status(404).json({ error: 'Project icon not found' });
    } catch (error) {
      console.warn('Failed to load project icon:', error);
      return res.status(500).json({ error: 'Failed to load project icon' });
    }
  });

  app.put('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const parsed = parseProjectIconDataUrl(req.body?.dataUrl);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const { projects, project, managed } = await resolveProjectById(req, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (managed && !managed.canMutate) {
        return res.status(403).json({ error: 'Project metadata can only be changed by an administrator' });
      }

      const iconPath = projectIconPathForMime(projectId, parsed.mime);
      if (!iconPath) {
        return res.status(400).json({ error: 'Unsupported icon format' });
      }

      const updatedAt = Date.now();
      const persistMetadata = (iconImage) => persistProjectIconImage({
        projects, projectId, iconImage, managed,
      });
      const persisted = projectIconStore
        ? await projectIconStore.replaceIcon({
          project,
          mime: parsed.mime,
          source: 'custom',
          updatedAt,
          bytes: parsed.bytes,
        }, persistMetadata)
        : await (async () => {
          await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
          await fsPromises.writeFile(iconPath, parsed.bytes);
          await removeProjectIconFiles(projectId, iconPath);
          return persistMetadata({ mime: parsed.mime, updatedAt, source: 'custom' });
        })();

      return res.json({ project: persisted.project, ...(persisted.settings ? { settings: persisted.settings } : {}) });
    } catch (error) {
      console.warn('Failed to upload project icon:', error);
      return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to upload project icon' });
    }
  });

  app.delete('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const { projects, project, managed } = await resolveProjectById(req, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (managed && !managed.canMutate) {
        return res.status(403).json({ error: 'Project metadata can only be changed by an administrator' });
      }

      const persistMetadata = (iconImage) => persistProjectIconImage({
        projects, projectId, iconImage, managed,
      });
      const persisted = projectIconStore
        ? await projectIconStore.deleteIcon({ project }, persistMetadata)
        : await (async () => {
          await removeProjectIconFiles(projectId);
          return persistMetadata(null);
        })();

      return res.json({ project: persisted.project, ...(persisted.settings ? { settings: persisted.settings } : {}) });
    } catch (error) {
      console.warn('Failed to remove project icon:', error);
      return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to remove project icon' });
    }
  });

  app.post('/api/projects/:projectId/icon/discover', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const { projects, project, managed } = await resolveProjectById(req, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (managed && !managed.canDiscover) {
        return res.status(400).json({ error: 'Icon discovery requires administrator repository access' });
      }

      const force = req.body?.force === true;
      if (project.iconImage?.source === 'custom' && !force) {
        return res.json({
          project,
          skipped: true,
          reason: 'custom-icon-present',
        });
      }

      const faviconCandidates = await fsSearchRuntime.searchFilesystemFiles(project.path, {
        limit: 200,
        query: 'favicon',
        includeHidden: true,
        respectGitignore: false,
      });

      const filtered = faviconCandidates
        .filter((entry) => /(^|\/)favicon\.(ico|png|svg|jpg|jpeg|webp)$/i.test(entry.path))
        .sort((a, b) => a.path.length - b.path.length);

      const selected = filtered[0];
      if (!selected) {
        return res.status(404).json({ error: 'No favicon found in project' });
      }

      const ext = path.extname(selected.path).slice(1).toLowerCase();
      const mime = projectIconExtensionToMime[ext] || null;
      if (!mime) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const bytes = await fsPromises.readFile(selected.path);
      if (bytes.length === 0) {
        return res.status(400).json({ error: 'Discovered icon is empty' });
      }
      if (bytes.length > projectIconMaxBytes) {
        return res.status(400).json({ error: 'Discovered icon exceeds size limit (5 MB)' });
      }

      const iconPath = projectIconPathForMime(projectId, mime);
      if (!iconPath) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const updatedAt = Date.now();
      const persistMetadata = (iconImage) => persistProjectIconImage({
        projects, projectId, iconImage, managed,
      });
      const persisted = projectIconStore
        ? await projectIconStore.replaceIcon({
          project,
          mime,
          source: 'auto',
          updatedAt,
          bytes,
        }, persistMetadata)
        : await (async () => {
          await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
          await fsPromises.writeFile(iconPath, bytes);
          await removeProjectIconFiles(projectId, iconPath);
          return persistMetadata({ mime, updatedAt, source: 'auto' });
        })();

      return res.json({
        project: persisted.project,
        ...(persisted.settings ? { settings: persisted.settings } : {}),
        discoveredPath: selected.path,
      });
    } catch (error) {
      console.warn('Failed to discover project icon:', error);
      return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to discover project icon' });
    }
  });
};
