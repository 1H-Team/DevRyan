// Starts Docker Desktop on the owner's request. The renderer supplies nothing:
// the application is addressed by its fixed bundle identifier, so a
// non-standard install location works and another container engine is simply
// reported as not opened.
const OPEN_EXECUTABLE = '/usr/bin/open';
const DOCKER_DESKTOP_BUNDLE_ID = 'com.docker.docker';
const OPEN_TIMEOUT_MS = 10_000;

export const createDockerDesktopLauncher = ({ platform = process.platform, execFile }) => ({
  async open() {
    if (platform !== 'darwin') return { opened: false, code: 'docker_desktop_unsupported_platform' };
    try {
      // -g keeps DevRyan in front while Docker Desktop starts.
      await execFile(OPEN_EXECUTABLE, ['-g', '-b', DOCKER_DESKTOP_BUNDLE_ID], { timeout: OPEN_TIMEOUT_MS });
      return { opened: true, code: null };
    } catch {
      return { opened: false, code: 'docker_desktop_open_failed' };
    }
  },
});
