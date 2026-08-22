import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JSONC_CONFIG_FIXTURES } from '../../shared-runtime/testing/jsonc-config-fixtures.js';
import { parseConfigJsonc as parseWebConfigJsonc } from '../../web/server/lib/opencode/jsonc-config.js';
import {
  INVALID_JSONC_CODE,
  parseConfigJsonc,
} from './jsoncConfig';

describe('VS Code JSONC configuration parser', () => {
  it.each(JSONC_CONFIG_FIXTURES)('$name', (fixture) => {
    if (fixture.valid) {
      expect(parseConfigJsonc(fixture.source, '/private/config.jsonc')).toEqual(fixture.value);
      return;
    }

    const capture = (parse: typeof parseConfigJsonc) => {
      try {
        parse(fixture.source, '/private/config.jsonc');
        throw new Error('expected invalid JSONC');
      } catch (error) {
        expect(error).toMatchObject({ code: INVALID_JSONC_CODE, file: 'config.jsonc' });
        return error as { code: string; diagnostics: unknown[]; message: string };
      }
    };
    const vscodeError = capture(parseConfigJsonc);
    const webError = capture(parseWebConfigJsonc as typeof parseConfigJsonc);
    expect(vscodeError.diagnostics).toEqual(webError.diagnostics);
    expect(vscodeError.message).toBe(webError.message);
    expect(vscodeError.message).not.toContain('/private');
  });
});

describe('VS Code JSONC configuration integration', () => {
  let originalHome: string | undefined;
  let tempHome: string | undefined;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  const loadConfig = async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-jsonc-vscode-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    return import('./opencodeConfig');
  };

  it('does not modify or back up a malformed mutation target', async () => {
    const config = await loadConfig();
    const target = path.join(tempHome!, 'target.jsonc');
    const original = '{"valid": true, "broken": }\n';
    fs.writeFileSync(target, original, 'utf8');

    expect(() => config.__testing.writeConfig({ valid: false }, target)).toThrow(expect.objectContaining({
      code: INVALID_JSONC_CODE,
    }));
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(`${target}.openchamber.backup`)).toBe(false);
  });

  it('keeps a valid user layer when the project layer is malformed', async () => {
    const config = await loadConfig();
    const project = path.join(tempHome!, 'project');
    const userConfig = path.join(tempHome!, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(userConfig), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(userConfig, '{"provider":{"user":true}}', 'utf8');
    fs.writeFileSync(path.join(project, 'opencode.json'), '{"provider":', 'utf8');

    const layers = config.__testing.readConfigLayers(project);
    expect(layers.userConfig).toEqual({ provider: { user: true } });
    expect(layers.projectConfig).toEqual({});
    expect(layers.mergedConfig).toEqual({ provider: { user: true } });
  });
});
