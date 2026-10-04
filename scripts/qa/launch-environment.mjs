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
