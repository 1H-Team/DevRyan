import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const within = (parent, target) => {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Test-only adaptation; production main/server/preload code is imported unchanged.
export async function preparePackagedQaHost({ app, env = process.env, resourcesPath = process.resourcesPath }) {
  if (!app.isPackaged || env.DEVRYAN_QA_RUNTIME !== 'electron') throw new Error('Packaged QA requires the actual packaged Electron host');
  const runtimeRoot = env.DEVRYAN_QA_RUNTIME_ROOT;
  const home = env.DEVRYAN_QA_HOME;
  const data = env.OPENCHAMBER_DATA_DIR;
  const profile = env.OPENCHAMBER_ELECTRON_USER_DATA_DIR;
  for (const value of [runtimeRoot, home, data, profile]) {
    if (!value || !path.isAbsolute(value)) throw new Error('Packaged QA paths must be absolute owned directories');
  }
  const canonicalRoot = await realpath(runtimeRoot);
  for (const directory of [home, data]) {
    if (!within(runtimeRoot, directory) || !within(canonicalRoot, await realpath(directory))) throw new Error('Packaged QA path escaped its private runtime root');
  }
  if (path.dirname(profile) !== runtimeRoot) throw new Error('Packaged QA browser profile must be a direct child of its private runtime root');
  await mkdir(profile, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!within(canonicalRoot, await realpath(profile))) throw new Error('Packaged QA path escaped its private runtime root');
  if (!(await lstat(path.join(home, '.devryan-qa-home'))).isFile()) throw new Error('Packaged QA home ownership marker is missing');
  const settingsPath = path.join(data, 'settings.json');
  if (!(await lstat(settingsPath)).isFile()) throw new Error('Packaged QA requires its private settings file');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const credentialsPath = path.join(runtimeRoot, 'credentials.env.json');
  if (!(await lstat(credentialsPath)).isFile()) throw new Error('Packaged QA requires its private credentials file');
  const privateEnvironment = JSON.parse(await readFile(credentialsPath, 'utf8'));
  for (const [key, value] of Object.entries(privateEnvironment)) {
    if (!['MERIDIAN_PROFILES', 'MERIDIAN_DEFAULT_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key) || typeof value !== 'string') {
      throw new Error('Unexpected private QA credential environment field');
    }
  }

  const logs = path.join(runtimeRoot, 'logs');
  const shellConfig = path.join(home, '.config/qa-zsh');
  await Promise.all([logs, shellConfig].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  await writeFile(settingsPath, `${JSON.stringify({ ...settings, productionBotsRuntimeMode: 'disabled', desktopLanAccessEnabled: false })}\n`, { mode: 0o600 });
  Object.assign(env, privateEnvironment);
  env.OPENCHAMBER_ELECTRON_DEV = '0';
  env.OPENCHAMBER_DIST_DIR = path.join(resourcesPath, 'web-dist');
  // main probes a login shell on macOS. ZDOTDIR keeps that probe away from the
  // user's personal rc files without changing HOME in this or the parent process.
  env.SHELL = '/bin/zsh';
  env.ZDOTDIR = shellConfig;
  app.setPath('home', home);
  app.setPath('userData', profile);
  app.setAppLogsPath(logs);
  app.commandLine.appendSwitch('use-mock-keychain');
  // Global OS protocol ownership is outside this private Coding Agents fixture.
  app.isDefaultProtocolClient = () => true;
  app.setAsDefaultProtocolClient = () => false;
  const evidence = { isPackaged: app.isPackaged, packagedMain: 'dist-bundle/main.mjs',
    webDist: env.OPENCHAMBER_DIST_DIR, privateHome: home, privateProfile: profile, logs,
    globalProtocolRegistration: 'suppressed-for-qa', backgroundBotService: 'disabled-for-qa',
    personalShellConfiguration: 'excluded-by-private-ZDOTDIR', operatingSystemKeychain: 'mocked-for-qa' };
  await writeFile(path.join(runtimeRoot, 'packaged-host.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}
