const path = require('node:path');

module.exports = {
  appId: 'ai.devryan.production-bots-visual-fixture',
  productName: 'DevRyan Production Bots Visual Fixture',
  electronVersion: '41.2.1',
  asar: true,
  npmRebuild: false,
  files: [
    'electron-shell.cjs',
    'package.json',
  ],
  directories: {
    output: path.resolve(__dirname, '../../.cache/e2e/production-bots-visual-shell'),
  },
  mac: {
    target: ['dir'],
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    target: ['dir'],
    category: 'Development',
  },
  win: {
    target: ['dir'],
  },
};
