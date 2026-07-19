import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { registerSkillRoutes } from './skill-routes.js';

const createApp = ({
  skillDir,
  settingsRef,
  discoverSkillsOverride,
  directoryOverride,
  getOpenCodePortOverride,
  deleteSkillOverride,
  persistSettingsOverride,
  refreshOpenCodeAfterConfigChangeOverride,
  isExternalOpenCodeOverride,
}) => {
  const app = express();
  app.use(express.json());

  const skillPath = path.join(skillDir, 'SKILL.md');
  const persistSettings = vi.fn(persistSettingsOverride || (async (changes) => {
    settingsRef.current = {
      ...settingsRef.current,
      ...changes,
    };
    return settingsRef.current;
  }));
  const refreshOpenCodeAfterConfigChange = vi.fn(refreshOpenCodeAfterConfigChangeOverride || (async () => {}));

  registerSkillRoutes(app, {
    fs,
    path,
    os,
    resolveProjectDirectory: async () => ({ directory: directoryOverride === undefined ? path.dirname(skillDir) : directoryOverride }),
    resolveOptionalProjectDirectory: async () => ({ directory: directoryOverride === undefined ? path.dirname(skillDir) : directoryOverride }),
    readSettingsFromDisk: async () => settingsRef.current,
    persistSettings,
    sanitizeSkillCatalogs: (value) => (Array.isArray(value) ? value : undefined),
    sanitizeHiddenSkills: (value) => (Array.isArray(value) ? value : []),
    isUnsafeSkillRelativePath: () => false,
    refreshOpenCodeAfterConfigChange,
    isExternalOpenCode: isExternalOpenCodeOverride || (() => false),
    clientReloadDelayMs: 0,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/skill',
    getOpenCodeAuthHeaders: () => ({}),
    getOpenCodePort: () => getOpenCodePortOverride ?? null,
    getSkillSources: (name, _directory, discoveredSkill = null) => {
      const selectedPath = discoveredSkill?.path || skillPath;
      return {
        md: {
          exists: name === 'lint-helper' || name === discoveredSkill?.name,
          path: selectedPath,
          dir: selectedPath ? path.dirname(selectedPath) : skillDir,
          scope: discoveredSkill?.scope || 'user',
          source: discoveredSkill?.source || 'opencode',
          fields: ['description'],
          description: discoveredSkill?.description || 'Helps lint code',
          name,
          instructions: '',
          supportingFiles: [],
        },
      };
    },
    discoverSkills: discoverSkillsOverride || (() => [
      {
        name: 'lint-helper',
        path: skillPath,
        scope: 'user',
        source: 'opencode',
        description: 'Helps lint code',
      },
    ]),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: deleteSkillOverride || vi.fn((_name, _directory, discoveredSkill) => {
      fs.rmSync(path.dirname(discoveredSkill.path), { recursive: true, force: true });
    }),
    readSkillSupportingFile: vi.fn(),
    writeSkillSupportingFile: vi.fn(),
    deleteSkillSupportingFile: vi.fn(),
    SKILL_SCOPE: { USER: 'user', PROJECT: 'project' },
    SKILL_DIR: path.dirname(skillDir),
    getCuratedSkillsSources: () => [],
    getCacheKey: () => 'cache',
    getCachedScan: () => null,
    setCachedScan: () => {},
    parseSkillRepoSource: () => ({ ok: false, error: { kind: 'invalidSource', message: 'unused' } }),
    scanSkillsRepository: vi.fn(),
    installSkillsFromRepository: vi.fn(),
    scanClawdHubPage: vi.fn(),
    installSkillsFromClawdHub: vi.fn(),
    isClawdHubSource: () => false,
    getProfiles: () => [],
    getProfile: () => null,
  });

  return { app, persistSettings, refreshOpenCodeAfterConfigChange, skillPath };
};

describe('skill routes', () => {
  it('keeps same-name skills separate when their canonical SKILL.md paths differ', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, 'user-skills', 'lint-helper');
    const projectSkillDir = path.join(tempRoot, '.opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app } = createApp({
      skillDir: userSkillDir,
      settingsRef,
      discoverSkillsOverride: () => [
        {
          name: 'lint-helper',
          path: path.join(userSkillDir, 'SKILL.md'),
          scope: 'user',
          source: 'opencode',
          description: 'User helper',
        },
        {
          name: 'lint-helper',
          path: path.join(projectSkillDir, 'SKILL.md'),
          scope: 'project',
          source: 'opencode',
          description: 'Project helper',
        },
      ],
    });

    const response = await request(app).get('/api/config/skills').query({ directory: tempRoot });

    expect(response.status).toBe(200);
    expect(response.body.skills).toHaveLength(2);
    expect(response.body.skills.map((skill) => skill.scope).sort()).toEqual(['project', 'user']);
  });

  it('lists only user-scoped skills when Settings requests the global skills scope', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, 'home', '.config', 'opencode', 'skills', 'lint-helper');
    const projectSkillDir = path.join(tempRoot, 'project', '.opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.mkdirSync(projectSkillDir, { recursive: true });
    const userSkillPath = path.join(userSkillDir, 'SKILL.md');
    const projectSkillPath = path.join(projectSkillDir, 'SKILL.md');
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app } = createApp({
      skillDir: userSkillDir,
      settingsRef,
      discoverSkillsOverride: () => [
        {
          name: 'lint-helper',
          path: userSkillPath,
          scope: 'user',
          source: 'opencode',
          description: 'User helper',
        },
        {
          name: 'lint-helper',
          path: projectSkillPath,
          scope: 'project',
          source: 'opencode',
          description: 'Project helper',
        },
      ],
    });

    const response = await request(app).get('/api/config/skills').query({ directory: tempRoot, scope: 'user' });

    expect(response.status).toBe(200);
    expect(response.body.skills).toEqual([
      expect.objectContaining({
        name: 'lint-helper',
        path: userSkillPath,
        scope: 'user',
      }),
    ]);
  });

  it('lists all active skill scopes and sources when Settings does not request a scope filter', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userAgentsSkillDir = path.join(tempRoot, 'home', '.agents', 'skills', 'lint-helper');
    const projectAgentsSkillDir = path.join(tempRoot, 'project', '.agents', 'skills', 'lint-helper');
    const projectOpenCodeSkillDir = path.join(tempRoot, 'project', '.opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userAgentsSkillDir, { recursive: true });
    fs.mkdirSync(projectAgentsSkillDir, { recursive: true });
    fs.mkdirSync(projectOpenCodeSkillDir, { recursive: true });
    const userAgentsSkillPath = path.join(userAgentsSkillDir, 'SKILL.md');
    const projectAgentsSkillPath = path.join(projectAgentsSkillDir, 'SKILL.md');
    const projectOpenCodeSkillPath = path.join(projectOpenCodeSkillDir, 'SKILL.md');
    fs.writeFileSync(userAgentsSkillPath, '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(projectAgentsSkillPath, '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(projectOpenCodeSkillPath, '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app } = createApp({
      skillDir: userAgentsSkillDir,
      settingsRef,
      discoverSkillsOverride: () => [
        {
          name: 'lint-helper',
          path: userAgentsSkillPath,
          scope: 'user',
          source: 'agents',
          description: 'User agents helper',
        },
        {
          name: 'lint-helper',
          path: projectAgentsSkillPath,
          scope: 'project',
          source: 'agents',
          description: 'Project agents helper',
        },
        {
          name: 'lint-helper',
          path: projectOpenCodeSkillPath,
          scope: 'project',
          source: 'opencode',
          description: 'Project OpenCode helper',
        },
      ],
    });

    const response = await request(app).get('/api/config/skills').query({ directory: tempRoot });

    expect(response.status).toBe(200);
    expect(response.body.skills.map((skill) => `${skill.scope}/${skill.source}/${skill.path}`)).toEqual([
      `user/agents/${userAgentsSkillPath}`,
      `project/agents/${projectAgentsSkillPath}`,
      `project/opencode/${projectOpenCodeSkillPath}`,
    ]);
  });

  it('wraps catalog scan and install responses without removing compatibility fields', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, 'home', '.config', 'opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userSkillDir, { recursive: true });

    const settingsRef = { current: { hiddenSkills: [] } };
    const scanSkillsRepository = vi.fn(async () => ({
      ok: true,
      items: [{ skillName: 'lint-helper', skillDir: 'skills/lint-helper' }],
    }));
    const installSkillsFromRepository = vi.fn(async () => ({
      ok: true,
      installed: [{ skillName: 'lint-helper', scope: 'user', source: 'opencode' }],
      skipped: [],
    }));
    const focused = express();
    focused.use(express.json());
    registerSkillRoutes(focused, {
      fs,
      path,
      os,
      resolveProjectDirectory: async () => ({ directory: tempRoot }),
      resolveOptionalProjectDirectory: async () => ({ directory: tempRoot }),
      readSettingsFromDisk: async () => settingsRef.current,
      persistSettings: vi.fn(async (changes) => ({ ...settingsRef.current, ...changes })),
      sanitizeSkillCatalogs: (value) => (Array.isArray(value) ? value : undefined),
      sanitizeHiddenSkills: (value) => (Array.isArray(value) ? value : []),
      isUnsafeSkillRelativePath: () => false,
      refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
      clientReloadDelayMs: 0,
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/skill',
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodePort: () => null,
      getSkillSources: () => ({ md: { exists: false, supportingFiles: [] } }),
      discoverSkills: () => [],
      createSkill: vi.fn(),
      updateSkill: vi.fn(),
      deleteSkill: vi.fn(),
      readSkillSupportingFile: vi.fn(),
      writeSkillSupportingFile: vi.fn(),
      deleteSkillSupportingFile: vi.fn(),
      SKILL_SCOPE: { USER: 'user', PROJECT: 'project' },
      SKILL_DIR: path.dirname(userSkillDir),
      getCuratedSkillsSources: () => [],
      getCacheKey: () => 'cache',
      getCachedScan: () => null,
      setCachedScan: () => {},
      parseSkillRepoSource: () => ({ ok: true, normalizedRepo: 'owner/repo' }),
      scanSkillsRepository,
      installSkillsFromRepository,
      scanClawdHubPage: vi.fn(),
      installSkillsFromClawdHub: vi.fn(),
      isClawdHubSource: () => false,
      getProfiles: () => [],
      getProfile: () => null,
    });

    await request(focused)
      .post('/api/config/skills/scan')
      .send({ source: 'owner/repo' })
      .expect(200)
      .expect((res) => {
        expect(res.body.ok).toBe(true);
        expect(res.body.items).toEqual([{ skillName: 'lint-helper', skillDir: 'skills/lint-helper' }]);
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'success',
          summary: 'Skills scan completed',
        }));
      });

    await request(focused)
      .post('/api/config/skills/install')
      .send({ source: 'owner/repo', scope: 'user', selections: [{ skillDir: 'skills/lint-helper' }] })
      .expect(200)
      .expect((res) => {
        expect(res.body.ok).toBe(true);
        expect(res.body.installed).toHaveLength(1);
        expect(res.body.requiresReload).toBe(true);
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'success',
          summary: 'Skills install completed',
        }));
      });
  });

  it('wraps catalog source and install validation errors without removing compatibility fields', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'skills', 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    const settingsRef = {
      current: {
        hiddenSkills: [],
        skillCatalogs: [{ id: 'repo', label: 'Repo', source: 'bad-source' }],
      },
    };
    const { app } = createApp({
      skillDir,
      settingsRef,
      directoryOverride: null,
    });

    await request(app)
      .get('/api/config/skills/catalog/source')
      .query({ sourceId: 'repo' })
      .expect(400)
      .expect((res) => {
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toEqual({ kind: 'invalidSource', message: 'unused' });
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'error',
          summary: 'Skills catalog source failed to load',
        }));
      });

    await request(app)
      .post('/api/config/skills/install')
      .send({ source: 'owner/repo', scope: 'project' })
      .expect(400)
      .expect((res) => {
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toEqual({
          kind: 'invalidSource',
          message: 'Project installs require a directory parameter',
        });
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'error',
          summary: 'Skills install failed',
        }));
      });
  });

  it('updates and reads supporting files from the exact selected same-name skill path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, 'home', '.agents', 'skills', 'lint-helper');
    const projectSkillDir = path.join(tempRoot, 'project', '.opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.mkdirSync(projectSkillDir, { recursive: true });
    const userSkillPath = path.join(userSkillDir, 'SKILL.md');
    const projectSkillPath = path.join(projectSkillDir, 'SKILL.md');
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\ndescription: User helper\n---\n', 'utf8');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\ndescription: Project helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const updateSkill = vi.fn();
    const readSkillSupportingFile = vi.fn(() => 'project reference');
    const writeSkillSupportingFile = vi.fn();
    const focused = express();
    focused.use(express.json());
    registerSkillRoutes(focused, {
      fs,
      path,
      os,
      resolveProjectDirectory: async () => ({ directory: tempRoot }),
      resolveOptionalProjectDirectory: async () => ({ directory: tempRoot }),
      readSettingsFromDisk: async () => settingsRef.current,
      persistSettings: vi.fn(async (changes) => ({ ...settingsRef.current, ...changes })),
      sanitizeSkillCatalogs: (value) => (Array.isArray(value) ? value : undefined),
      sanitizeHiddenSkills: (value) => (Array.isArray(value) ? value : []),
      isUnsafeSkillRelativePath: () => false,
      refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
      clientReloadDelayMs: 0,
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/skill',
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodePort: () => null,
      getSkillSources: (name, _directory, discoveredSkill = null) => ({
        md: {
          exists: Boolean(discoveredSkill?.path),
          path: discoveredSkill?.path || null,
          dir: discoveredSkill?.path ? path.dirname(discoveredSkill.path) : null,
          scope: discoveredSkill?.scope || null,
          source: discoveredSkill?.source || null,
          fields: ['description'],
          description: discoveredSkill?.description || '',
          name,
          instructions: '',
          supportingFiles: [],
        },
      }),
      discoverSkills: () => [
        {
          name: 'lint-helper',
          path: userSkillPath,
          scope: 'user',
          source: 'agents',
          description: 'User helper',
        },
        {
          name: 'lint-helper',
          path: projectSkillPath,
          scope: 'project',
          source: 'opencode',
          description: 'Project helper',
        },
      ],
      createSkill: vi.fn(),
      updateSkill,
      deleteSkill: vi.fn(),
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile: vi.fn(),
      SKILL_SCOPE: { USER: 'user', PROJECT: 'project' },
      SKILL_DIR: path.dirname(userSkillDir),
      getCuratedSkillsSources: () => [],
      getCacheKey: () => 'cache',
      getCachedScan: () => null,
      setCachedScan: () => {},
      parseSkillRepoSource: () => ({ ok: false, error: { kind: 'invalidSource', message: 'unused' } }),
      scanSkillsRepository: vi.fn(),
      installSkillsFromRepository: vi.fn(),
      scanClawdHubPage: vi.fn(),
      installSkillsFromClawdHub: vi.fn(),
      isClawdHubSource: () => false,
      getProfiles: () => [],
      getProfile: () => null,
    });

    const patch = await request(focused)
      .patch('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, scope: 'project', path: projectSkillPath })
      .send({ description: 'Updated project helper' });
    const readFile = await request(focused)
      .get('/api/config/skills/lint-helper/files/reference.md')
      .query({ directory: tempRoot, scope: 'project', path: projectSkillPath });
    const writeFile = await request(focused)
      .put('/api/config/skills/lint-helper/files/reference.md')
      .query({ directory: tempRoot, scope: 'project', path: projectSkillPath })
      .send({ content: 'updated' });

    expect(patch.status).toBe(200);
    expect(readFile.status).toBe(200);
    expect(writeFile.status).toBe(200);
    expect(updateSkill).toHaveBeenCalledWith(
      'lint-helper',
      { description: 'Updated project helper' },
      tempRoot,
      expect.objectContaining({ path: projectSkillPath, preferDiscoveredPath: true }),
    );
    expect(readSkillSupportingFile).toHaveBeenCalledWith(path.dirname(projectSkillPath), 'reference.md');
    expect(writeSkillSupportingFile).toHaveBeenCalledWith(path.dirname(projectSkillPath), 'reference.md', 'updated');
  });

  it('lists user-scoped skills without an active project directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app } = createApp({ skillDir, settingsRef, directoryOverride: null });

    const response = await request(app).get('/api/config/skills').query({ scope: 'user' });

    expect(response.status).toBe(200);
    expect(response.body.skills.map((skill) => skill.name)).toEqual(['lint-helper']);
  });

  it('removes the exact selected user skill when a same-name project skill exists', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, 'home', '.config', 'opencode', 'skills', 'lint-helper');
    const projectSkillDir = path.join(tempRoot, 'project', '.opencode', 'skills', 'lint-helper');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.mkdirSync(projectSkillDir, { recursive: true });
    const userSkillPath = path.join(userSkillDir, 'SKILL.md');
    const projectSkillPath = path.join(projectSkillDir, 'SKILL.md');
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, persistSettings } = createApp({
      skillDir: userSkillDir,
      settingsRef,
      discoverSkillsOverride: () => [
        {
          name: 'lint-helper',
          path: userSkillPath,
          scope: 'user',
          source: 'opencode',
          description: 'User helper',
        },
        {
          name: 'lint-helper',
          path: projectSkillPath,
          scope: 'project',
          source: 'opencode',
          description: 'Project helper',
        },
      ],
    });

    const removed = await request(app)
      .post('/api/config/skills/lint-helper/hide')
      .query({ directory: tempRoot, scope: 'user', path: userSkillPath });

    expect(removed.status).toBe(200);
    expect(persistSettings).toHaveBeenCalledWith({
      hiddenSkills: [
        {
          name: 'lint-helper',
          path: fs.realpathSync(userSkillPath),
          scope: 'user',
          source: 'opencode',
        },
      ],
    });
    expect(settingsRef.current.hiddenSkills[0].path).not.toBe(fs.realpathSync(projectSkillPath));
  });

  it('hides and restores a skill without deleting its directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: lint-helper\ndescription: Helps lint code\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, persistSettings, refreshOpenCodeAfterConfigChange, skillPath } = createApp({ skillDir, settingsRef });
    const canonicalSkillPath = fs.realpathSync(skillPath);

    const initial = await request(app).get('/api/config/skills').query({ directory: tempRoot });
    expect(initial.status).toBe(200);
    expect(initial.body.skills.map((skill) => skill.name)).toEqual(['lint-helper']);

    const removed = await request(app).post('/api/config/skills/lint-helper/hide').query({ directory: tempRoot });
    expect(removed.status).toBe(200);
    expect(removed.body.success).toBe(true);
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(persistSettings).toHaveBeenCalledWith({
      hiddenSkills: [
        {
          name: 'lint-helper',
          path: canonicalSkillPath,
          scope: 'user',
          source: 'opencode',
        },
      ],
    });

    const visibleAfterRemove = await request(app).get('/api/config/skills').query({ directory: tempRoot });
    expect(visibleAfterRemove.status).toBe(200);
    expect(visibleAfterRemove.body.skills).toEqual([]);

    const hidden = await request(app).get('/api/config/skills').query({ directory: tempRoot, includeHidden: 'true' });
    expect(hidden.status).toBe(200);
    expect(hidden.body.hiddenSkills.map((skill) => skill.name)).toEqual(['lint-helper']);

    const restored = await request(app)
      .post('/api/config/skills/hidden/restore')
      .query({ directory: tempRoot })
      .send({ path: skillPath });
    expect(restored.status).toBe(200);
    expect(restored.body.success).toBe(true);
    expect(settingsRef.current.hiddenSkills).toEqual([]);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalled();

    const visibleAfterRestore = await request(app).get('/api/config/skills').query({ directory: tempRoot });
    expect(visibleAfterRestore.status).toBe(200);
    expect(visibleAfterRestore.body.skills.map((skill) => skill.name)).toEqual(['lint-helper']);
  });

  it('permanently deletes only the selected same-name skill path and removes its stale hidden entry', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const userSkillDir = path.join(tempRoot, '.agents', 'skills', 'lint-helper');
    const projectSkillDir = path.join(tempRoot, '.opencode', 'skills', 'lint-helper');
    const userSkillPath = path.join(userSkillDir, 'SKILL.md');
    const projectSkillPath = path.join(projectSkillDir, 'SKILL.md');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\n---\n', 'utf8');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\n---\n', 'utf8');

    const settingsRef = {
      current: {
        hiddenSkills: [
          { name: 'lint-helper', path: projectSkillPath, scope: 'project', source: 'opencode' },
          { name: 'lint-helper', path: userSkillPath, scope: 'user', source: 'agents' },
        ],
      },
    };
    const { app, persistSettings } = createApp({
      skillDir: userSkillDir,
      settingsRef,
      discoverSkillsOverride: () => [
        { name: 'lint-helper', path: userSkillPath, scope: 'user', source: 'agents' },
        { name: 'lint-helper', path: projectSkillPath, scope: 'project', source: 'opencode' },
      ],
    });

    const removed = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, scope: 'project', path: projectSkillPath });

    expect(removed.status).toBe(200);
    expect(removed.body.message).toContain('permanently deleted');
    expect(fs.existsSync(projectSkillDir)).toBe(false);
    expect(fs.existsSync(userSkillDir)).toBe(true);
    expect(persistSettings).toHaveBeenCalledWith({
      hiddenSkills: [
        expect.objectContaining({ path: fs.realpathSync(userSkillPath) }),
      ],
    });
    expect(removed.body).toMatchObject({
      requiresReload: false,
      runtimeRefreshPending: true,
      runtimeApplied: false,
    });
  });

  it('returns permanent deletion before the managed runtime refresh settles', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: lint-helper\n---\n', 'utf8');
    let settleRefresh;
    const refreshPromise = new Promise((resolve) => {
      settleRefresh = resolve;
    });
    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, refreshOpenCodeAfterConfigChange } = createApp({
      skillDir,
      settingsRef,
      refreshOpenCodeAfterConfigChangeOverride: () => refreshPromise,
    });

    const removed = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, path: skillPath });

    expect(removed.status).toBe(200);
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('skill delete');
    settleRefresh();
  });

  it('skips automatic refresh for external runtimes and warns after a committed deletion', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: lint-helper\n---\n', 'utf8');
    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, refreshOpenCodeAfterConfigChange } = createApp({
      skillDir,
      settingsRef,
      isExternalOpenCodeOverride: () => true,
    });

    const removed = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, path: skillPath });

    expect(removed.body).toMatchObject({
      success: true,
      requiresReload: false,
      runtimeRefreshPending: false,
      runtimeApplied: false,
    });
    expect(removed.body.warning).toContain('external OpenCode runtime');
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  it('contains a managed runtime refresh failure after deletion succeeds', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: lint-helper\n---\n', 'utf8');
    const settingsRef = { current: { hiddenSkills: [] } };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({
      skillDir,
      settingsRef,
      refreshOpenCodeAfterConfigChangeOverride: async () => {
        throw new Error('restart failed');
      },
    });

    const removed = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, path: skillPath });

    expect(removed.status).toBe(200);
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        '[API:Skill delete] OpenCode refresh failed after deletion:',
        expect.objectContaining({ message: 'restart failed' }),
      );
    });
    consoleError.mockRestore();
  });

  it('reports settings cleanup failure as a warning after the skill directory is deleted', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: lint-helper\n---\n', 'utf8');
    const settingsRef = {
      current: { hiddenSkills: [{ name: 'lint-helper', path: skillPath, scope: 'user', source: 'opencode' }] },
    };
    const { app } = createApp({
      skillDir,
      settingsRef,
      persistSettingsOverride: async () => {
        throw new Error('settings unavailable');
      },
    });

    const removed = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, path: skillPath });

    expect(removed.status).toBe(200);
    expect(removed.body.success).toBe(true);
    expect(removed.body.warning).toContain('settings unavailable');
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('rejects stale skill paths instead of falling back to a same-name skill', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: lint-helper\n---\n', 'utf8');
    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, persistSettings } = createApp({ skillDir, settingsRef });

    const hidden = await request(app)
      .post('/api/config/skills/lint-helper/hide')
      .query({ directory: tempRoot, path: path.join(tempRoot, 'stale', 'SKILL.md') });
    const deleted = await request(app)
      .delete('/api/config/skills/lint-helper')
      .query({ directory: tempRoot, path: path.join(tempRoot, 'stale', 'SKILL.md') });

    expect(hidden.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('keeps persisted hidden skills visible in the hidden list when discovery is delayed', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: lint-helper\ndescription: Helps lint code\n---\n', 'utf8');
    const canonicalSkillPath = fs.realpathSync(skillPath);

    const settingsRef = {
      current: {
        hiddenSkills: [
          {
            name: 'lint-helper',
            path: skillPath,
            scope: 'user',
            source: 'opencode',
          },
        ],
      },
    };
    const { app } = createApp({
      skillDir,
      settingsRef,
      discoverSkillsOverride: () => [],
    });

    const hidden = await request(app).get('/api/config/skills').query({ directory: tempRoot, includeHidden: 'true' });

    expect(hidden.status).toBe(200);
    expect(hidden.body.skills).toEqual([]);
    expect(hidden.body.hiddenSkills).toEqual([
      expect.objectContaining({
        name: 'lint-helper',
        path: canonicalSkillPath,
        scope: 'user',
        source: 'opencode',
      }),
    ]);
  });

  it('does not duplicate hidden skill settings when a skill is hidden twice', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: lint-helper\ndescription: Helps lint code\n---\n', 'utf8');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app, persistSettings, skillPath } = createApp({ skillDir, settingsRef });
    const canonicalSkillPath = fs.realpathSync(skillPath);

    const firstRemove = await request(app).post('/api/config/skills/lint-helper/hide').query({ directory: tempRoot });
    const secondRemove = await request(app).post('/api/config/skills/lint-helper/hide').query({ directory: tempRoot });

    expect(firstRemove.status).toBe(200);
    expect(secondRemove.status).toBe(200);
    expect(settingsRef.current.hiddenSkills).toEqual([
      {
        name: 'lint-helper',
        path: canonicalSkillPath,
        scope: 'user',
        source: 'opencode',
      },
    ]);
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });

  it('drops claude-sourced skills returned by the OpenCode runtime from the merged list', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skill-routes-'));
    const skillDir = path.join(tempRoot, 'lint-helper');
    fs.mkdirSync(skillDir, { recursive: true });

    const opencodeLocation = path.join(tempRoot, 'home', '.config', 'opencode', 'skills', 'lint-helper', 'SKILL.md');
    const claudeLocation = path.join(tempRoot, 'home', '.claude', 'skills', 'secret-skill', 'SKILL.md');

    const settingsRef = { current: { hiddenSkills: [] } };
    const { app } = createApp({
      skillDir,
      settingsRef,
      discoverSkillsOverride: () => [],
      getOpenCodePortOverride: 4096,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { name: 'lint-helper', location: opencodeLocation, description: 'OpenCode helper' },
        { name: 'secret-skill', location: claudeLocation, description: 'Claude helper' },
      ],
    }));

    try {
      const response = await request(app).get('/api/config/skills').query({ directory: tempRoot });

      expect(response.status).toBe(200);
      expect(response.body.skills.map((skill) => skill.name)).toEqual(['lint-helper']);
      expect(response.body.skills.every((skill) => skill.source !== 'claude')).toBe(true);
      expect(response.body.skills.some((skill) => skill.path.includes(`${path.sep}.claude${path.sep}`))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
