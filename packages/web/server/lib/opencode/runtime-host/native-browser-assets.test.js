import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { readNativeBrowserAssets } from './native-browser-assets.js';
import { AGENT_BROWSER_VERSION } from '../../agent-browser/install.js';

it('seals only an existing canonical managed installation and rejects changed layout/config/version/symlinks', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/browser-assets-'));
  const pkg = path.join(root, 'node_modules/agent-browser'), config = path.join(root, 'devryan-agent-browser.json');
  const binary = path.join(pkg, 'bin', `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
  const descriptor = { name: 'agent-browser', version: AGENT_BROWSER_VERSION };
  try {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify(descriptor));
    await fs.writeFile(config, '{}');
    await fs.writeFile(binary, 'owned fixture binary', { mode: 0o755 });
    const environment = { DEVRYAN_AGENT_BROWSER_BIN: binary, DEVRYAN_BROWSER_CDP_TOKEN: 'must-never-be-copied' };
    const sealed = await readNativeBrowserAssets(environment);
    expect(sealed).toEqual({ binaryPath: binary, sha256: createHash('sha256').update('owned fixture binary').digest('hex'),
      configPath: config, configSha256: createHash('sha256').update('{}').digest('hex') });
    expect(Object.isFrozen(sealed)).toBe(true);
    await expect(readNativeBrowserAssets({})).resolves.toBeUndefined();
    await expect(readNativeBrowserAssets({ DEVRYAN_AGENT_BROWSER_BIN: 'relative' })).rejects.toMatchObject({ code: 'native_browser_assets_invalid' });
    await fs.writeFile(config, '{"profile":"foreign"}');
    await expect(readNativeBrowserAssets(environment)).rejects.toMatchObject({ code: 'native_browser_assets_invalid' });
    await fs.writeFile(config, '{}');
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ ...descriptor, version: '0.0.0' }));
    await expect(readNativeBrowserAssets(environment)).rejects.toMatchObject({ code: 'native_browser_assets_invalid' });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify(descriptor));
    await fs.rename(binary, `${binary}-target`); await fs.symlink(`${binary}-target`, binary);
    await expect(readNativeBrowserAssets(environment)).rejects.toMatchObject({ code: 'native_browser_assets_invalid' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
