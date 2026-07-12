import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPluginReadModel, registerReadonlyPluginRoutes } from './plugins-readonly.js';

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

describe('read-only plugin config model', () => {
  it('lists config entries and plugin files from user and project scopes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-plugins-readonly-'));
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const userConfig = path.join(home, '.config', 'opencode', 'opencode.json');
    const projectConfig = path.join(project, '.opencode', 'opencode.json');
    writeJson(userConfig, {
      plugin: [
        'user-plugin@1.0.0',
        ['./local-user-plugin.js', { enabled: true }],
      ],
    });
    writeJson(projectConfig, {
      plugin: ['@scope/project-plugin@2.0.0'],
    });
    fs.mkdirSync(path.join(home, '.config', 'opencode', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(project, '.opencode', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'plugins', 'user-file.js'), '', 'utf8');
    fs.writeFileSync(path.join(project, '.opencode', 'plugins', 'project-file.ts'), '', 'utf8');
    fs.writeFileSync(path.join(project, '.opencode', 'plugins', 'ignore.txt'), '', 'utf8');

    try {
      const model = createPluginReadModel({
        fs,
        path,
        homedir: () => home,
        env: {},
      });

      const result = model.listPlugins(project);

      expect(result.entries.map((plugin) => `${plugin.scope}:${plugin.spec}:${plugin.parsedKind}`)).toEqual([
        'user:user-plugin@1.0.0:npm',
        'user:./local-user-plugin.js:path',
        'project:@scope/project-plugin@2.0.0:npm',
      ]);
      expect(result.entries[1].options).toEqual({ enabled: true });
      expect(result.files.map((pluginFile) => `${pluginFile.scope}:${pluginFile.fileName}`)).toEqual([
        'user:user-file.js',
        'project:project-file.ts',
      ]);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports malformed plugin entries without dropping valid entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-plugins-malformed-'));
    const home = path.join(root, 'home');
    const userConfig = path.join(home, '.config', 'opencode', 'opencode.json');
    writeJson(userConfig, {
      plugin: [
        'valid-plugin',
        ['', { invalid: true }],
        ['missing-options-object', 'bad'],
        42,
      ],
    });

    try {
      const model = createPluginReadModel({
        fs,
        path,
        homedir: () => home,
        env: {},
      });

      const result = model.listPlugins(null);

      expect(result.entries.map((plugin) => plugin.spec)).toEqual(['valid-plugin']);
      expect(result.errors).toEqual([
        expect.objectContaining({ scope: 'user', index: 1 }),
        expect.objectContaining({ scope: 'user', index: 2 }),
        expect.objectContaining({ scope: 'user', index: 3 }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('read-only plugin routes', () => {
  it('registers only GET /api/config/plugins', async () => {
    const app = express();
    app.use(express.json());
    const listPlugins = vi.fn(() => ({ entries: [], files: [], errors: [] }));
    registerReadonlyPluginRoutes(app, {
      resolveOptionalProjectDirectory: async () => ({ directory: '/tmp/project' }),
      listPlugins,
    });

    const getResponse = await request(app).get('/api/config/plugins');
    const postResponse = await request(app).post('/api/config/plugins').send({});

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual({ entries: [], files: [], errors: [] });
    expect(listPlugins).toHaveBeenCalledWith('/tmp/project');
    expect(postResponse.status).toBe(404);
  });
});
