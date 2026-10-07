import path from 'node:path';
import fs from 'node:fs';

export const WINDOWS_PREVIEW_VERSION = '2.0.3-windows-preview.1';
export const WINDOWS_PREVIEW_NAME = 'DevRyan Windows Preview';
export const WINDOWS_PREVIEW_APP_ID = 'dev.devryan.windows.preview';
export const WINDOWS_PREVIEW_GUID = 'a3f0708c-9c32-4e09-8da5-213d2859e69b';
export const WINDOWS_PREVIEW_OPENCODE_VERSION = '2.0.20';
export const WINDOWS_PREVIEW_OPENCODE_PINS = Object.freeze({
  x64: { package: '@opencode/cli-windows-x64', integrity: 'sha512-JomkE7e4++aQCVnwgAXwhsTgDdV0DiQZSZDzJUJbSfwKcTq9CR54xIfovBa+57S+yRVlw0JgKHh4TBpGvf8IlQ==' },
  arm64: { package: '@opencode/cli-windows-arm64', integrity: 'sha512-KGBhcKG+o5ENbWXsGm1A02C5nxE8jdmqhRObDjMEcwHEpY4Gj8jSCLAsX3ioQT/aRCt3yde4vM/a8MGKo4eo3Q==' },
});

export function isPreviewUnsupportedCommand(command) {
  return typeof command !== 'string' || ['desktop_bot_', 'desktop_agent_browser_', 'desktop_browser_',
    'desktop_macos_speech_', 'desktop_runtime_service_', 'desktop_runtime_bundle_'].some(prefix => command.startsWith(prefix))
    || ['desktop_set_agent_browser_control', 'desktop_export_bot_recovery', 'desktop_restore_bot_recovery'].includes(command);
}

/** Only the dedicated packaged entry can select this desktop composition. */
export function isWindowsPreview({ app, platform = process.platform, environment = process.env }) {
  const selected = environment.DEVRYAN_RUNTIME_MODE === 'standard-preview';
  if (!selected) return false;
  if (!app.isPackaged || platform !== 'win32' || app.getVersion() !== WINDOWS_PREVIEW_VERSION
    || app.getName() !== WINDOWS_PREVIEW_NAME) throw new Error('windows_preview_package_identity_required');
  return true;
}

export function configureWindowsPreview({ app, resourcesPath, platform = process.platform, arch = process.arch, environment = process.env }) {
  if (!app.isPackaged || platform !== 'win32' || !['x64', 'arm64'].includes(arch)
    || app.getVersion() !== WINDOWS_PREVIEW_VERSION || !path.isAbsolute(resourcesPath)) {
    throw new Error('windows_preview_package_identity_required');
  }
  if (process.argv.some(argument => argument === '--runtime-service' || argument.startsWith('--runtime-service-control='))) {
    throw new Error('windows_preview_runtime_service_unavailable');
  }
  app.setName(WINDOWS_PREVIEW_NAME);
  app.setAppUserModelId(WINDOWS_PREVIEW_APP_ID);
  const smoke = process.argv.includes('--devryan-preview-smoke');
  const override = environment.DEVRYAN_PREVIEW_SMOKE_USER_DATA;
  if (override !== undefined && (!smoke || !path.isAbsolute(override) || /[\u0000-\u001f]/.test(override))) {
    throw new Error('windows_preview_smoke_profile_invalid');
  }
  const userData = override || path.join(app.getPath('appData'), WINDOWS_PREVIEW_NAME);
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  if (smoke) {
    const fixtureRoot = environment.DEVRYAN_PREVIEW_SMOKE_ROOT;
    if (!path.isAbsolute(fixtureRoot || '') || !override || !path.resolve(override).startsWith(path.resolve(fixtureRoot) + path.sep)) {
      throw new Error('windows_preview_smoke_fixture_invalid');
    }
    const project = path.join(fixtureRoot, 'project');
    fs.mkdirSync(project, { recursive: true });
    try { fs.writeFileSync(path.join(project, 'opencode.json'), '{}\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  // Do not inherit installed-native bundle selection, development redirects,
  // external OpenCode endpoints or credential/config roots into this product.
  for (const key of ['DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCHAMBER_ELECTRON_USER_DATA_DIR', 'OPENCHAMBER_ELECTRON_DEV',
    'OPENCODE_BINARY', 'OPENCODE_PATH', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR',
    'OPENCODE_PORT', 'OPENCODE_SERVER_URL', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START']) delete environment[key];
  Object.assign(environment, {
    DEVRYAN_RUNTIME_MODE: 'standard-preview',
    DEVRYAN_STANDARD_OPENCODE_BINARY: path.join(resourcesPath, 'opencode', 'opencode.exe'),
    OPENCHAMBER_DATA_DIR: path.join(userData, 'data'),
    XDG_CONFIG_HOME: path.join(userData, 'config'),
    XDG_DATA_HOME: path.join(userData, 'share'),
    XDG_STATE_HOME: path.join(userData, 'state'),
    XDG_CACHE_HOME: path.join(userData, 'cache'),
  });
  return userData;
}

export function createPreviewUpdater() {
  const refuse = async () => { throw new Error('windows_preview_updates_disabled'); };
  return Object.freeze({ check: refuse, download: refuse, getDownloaded: refuse, isDownloaded: () => false });
}
