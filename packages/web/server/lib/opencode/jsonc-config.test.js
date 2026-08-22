import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JSONC_CONFIG_FIXTURES } from '../../../../shared-runtime/testing/jsonc-config-fixtures.js';
import {
  INVALID_JSONC_CODE,
  parseConfigJsonc,
} from './jsonc-config.js';

describe('web JSONC configuration parser', () => {
  it.each(JSONC_CONFIG_FIXTURES)('$name', (fixture) => {
    if (fixture.valid) {
      expect(parseConfigJsonc(fixture.source, '/private/config.jsonc')).toEqual(fixture.value);
      return;
    }

    try {
      parseConfigJsonc(fixture.source, '/private/config.jsonc');
      throw new Error('expected invalid JSONC');
    } catch (error) {
      expect(error).toMatchObject({
        code: INVALID_JSONC_CODE,
        file: 'config.jsonc',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ offset: expect.any(Number), length: expect.any(Number) }),
        ]),
      });
      expect(error.message).not.toContain('/private');
      expect(error.message).not.toContain(fixture.source);
    }
  });
});

describe('web JSONC configuration integration', () => {
  let originalHome;
  let tempHome;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  const loadShared = async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-jsonc-web-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    return import('./shared.js');
  };

  it('does not modify or back up a malformed mutation target', async () => {
    const shared = await loadShared();
    const target = path.join(tempHome, 'target.jsonc');
    const original = '{"valid": true, "broken": }\n';
    fs.writeFileSync(target, original, 'utf8');

    expect(() => shared.writeConfig({ valid: false }, target)).toThrow(expect.objectContaining({
      code: INVALID_JSONC_CODE,
    }));
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(`${target}.openchamber.backup`)).toBe(false);
  });

  it('keeps a valid user layer when the project layer is malformed', async () => {
    const shared = await loadShared();
    const project = path.join(tempHome, 'project');
    const userConfig = path.join(tempHome, '.config', 'opencode', 'config.json');
    fs.mkdirSync(path.dirname(userConfig), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(userConfig, '{"provider":{"user":true}}', 'utf8');
    fs.writeFileSync(path.join(project, 'opencode.json'), '{"provider":', 'utf8');

    const layers = shared.readConfigLayers(project);
    expect(layers.userConfig).toEqual({ provider: { user: true } });
    expect(layers.projectConfig).toEqual({});
    expect(layers.mergedConfig).toEqual({ provider: { user: true } });
  });
});
