#!/bin/sh
set -eu

RUNTIME_CONFIG_DIR=/runtime-config
SOURCE_PLUGIN=/opt/devryan/devryan-bot-tools.mjs

initialize_runtime_config() {
  umask 077
  if [ -L "$RUNTIME_CONFIG_DIR" ]; then
    echo "runtime config path cannot be a symlink" >&2
    exit 1
  fi
  mkdir -p "$RUNTIME_CONFIG_DIR/plugins"
  cp "$SOURCE_PLUGIN" "$RUNTIME_CONFIG_DIR/plugins/devryan-bot-tools.mjs"
  chmod 0444 "$RUNTIME_CONFIG_DIR/plugins/devryan-bot-tools.mjs"
  node --input-type=module <<'NODE'
import fs from 'node:fs';

const config = {
  $schema: 'https://opencode.ai/config.json',
  default_agent: 'bot',
  plugin: ['/runtime-config/plugins/devryan-bot-tools.mjs'],
  mcp: {},
  agent: {
    bot: {
      mode: 'primary',
      description: 'Scoped DevRyan Production Bot runtime',
      prompt: 'Operate autonomously within this scoped Bot channel and managed workspace. Use devryan_bot for governed browser and external actions. When devryan_image is available, use its exact prompt, out, and quality arguments for requested raster image generation; save out under /workspace/generated-images and successful images attach automatically. Never guess an image.generate gateway payload or promise a later Shared-folder publication. Never seek host files, Docker, host credentials, raw browser/CDP, direct MCP, or DevRyan host-task orchestration.',
      permission: {
        '*': 'deny',
        read: 'allow',
        write: 'allow',
        edit: 'allow',
        glob: 'allow',
        grep: 'allow',
        devryan_bot: 'allow',
        devryan_image: 'allow',
        devryan_write: 'allow',
        bash: 'allow',
        terminal: 'allow',
        git: 'allow',
        task: 'allow',
        devryan_task: 'deny',
        browser: 'deny',
        devryan_browser: 'deny',
        mcp: 'deny',
        external_directory: 'deny',
      },
    },
    explore: {
      mode: 'subagent',
      permission: { '*': 'deny', read: 'allow', write: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', bash: 'allow', terminal: 'allow', git: 'allow', task: 'deny', devryan_task: 'deny', devryan_bot: 'deny', devryan_image: 'deny', devryan_write: 'deny', browser: 'deny', devryan_browser: 'deny', mcp: 'deny', external_directory: 'deny' },
    },
    general: {
      mode: 'subagent',
      permission: { '*': 'deny', read: 'allow', write: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', bash: 'allow', terminal: 'allow', git: 'allow', task: 'deny', devryan_task: 'deny', devryan_bot: 'deny', devryan_image: 'deny', devryan_write: 'deny', browser: 'deny', devryan_browser: 'deny', mcp: 'deny', external_directory: 'deny' },
    },
  },
};

fs.writeFileSync('/runtime-config/opencode.json', `${JSON.stringify(config, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o444,
});
NODE
  chmod 0444 "$RUNTIME_CONFIG_DIR/opencode.json"
}

case "${1:-serve}" in
  initialize)
    initialize_runtime_config
    ;;
  serve)
    test -r "$RUNTIME_CONFIG_DIR/opencode.json"
    test -r "$SOURCE_PLUGIN"
    export OPENCODE_CONFIG="$RUNTIME_CONFIG_DIR/opencode.json"
    export XDG_DATA_HOME=/data
    export HOME=/data/opencode/home
    mkdir -p "$HOME"
    cd /workspace
    exec node /opt/devryan/launch-opencode.mjs serve --hostname 0.0.0.0 --port 4096
    ;;
  *)
    echo "unsupported Bot OpenCode entrypoint command" >&2
    exit 64
    ;;
esac
