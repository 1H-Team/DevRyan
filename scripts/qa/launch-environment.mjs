import path from 'node:path';

// Only platform launch inputs may flow from the invoking shell. Provider,
// runtime, proxy, preload, Git and account configuration belongs to the owned
// profile, never an inherited wildcard or a secret-name denylist.
const PLATFORM_KEYS = Object.freeze([
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT',
]);

export const qaPlatformEnvironment = (baseEnvironment = process.env) => Object.fromEntries(
  PLATFORM_KEYS.filter(key => typeof baseEnvironment[key] === 'string').map(key => [key, baseEnvironment[key]]),
);

export const createQaHostLaunchEnvironment = (profileEnvironment, overrides = {}, baseEnvironment = process.env) => ({
  ...qaPlatformEnvironment(baseEnvironment), ...profileEnvironment, ...overrides,
});

// The private-home host environment of run.mjs (web or Electron). Legacy
// loopback-fixture flags (OPENCODE_HOST, OPENCODE_SKIP_START, ...) arrive only
// through `overrides`; a native first launch omits them and provisions itself.
export const createQaIsolatedRuntimeEnvironment = ({ runtime, runtimeRoot, home, data, profile, distDirectory, port,
  overrides = {}, runtimeEnv = {} }, baseEnvironment = process.env) => {
  const env = createQaHostLaunchEnvironment({}, { OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile,
    OPENCHAMBER_DIST_DIR: distDirectory, OPENCHAMBER_PORT: String(port), ...overrides,
    OPENCHAMBER_ELECTRON_DEV: '1', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }, baseEnvironment);
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { DEVRYAN_QA_HOME: home, DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_RUNTIME: runtime });
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'), GH_CONFIG_DIR: path.join(home, 'gh'), ...runtimeEnv });
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'MERIDIAN_CONFIG_DIR', 'MERIDIAN_SESSION_DIR']) delete env[key];
  return env;
};
