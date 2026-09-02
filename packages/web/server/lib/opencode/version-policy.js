export const TARGET_OPENCODE_VERSION = '1.18.26';

// The Bot runtime container image pins its own OpenCode build
// (packages/bots-runtime/docker/opencode/Dockerfile). It currently tracks the
// host runtime target, but the two roll independently: the host pin can move
// ahead while the container image waits for a rebuilt, re-verified release.
export const BOT_TARGET_OPENCODE_VERSION = '1.18.26';

export const OPENCODE_TARGET_INSTALL_COMMAND =
  `curl -fsSL https://opencode.ai/install | bash -s -- --version ${TARGET_OPENCODE_VERSION} --no-modify-path`;
