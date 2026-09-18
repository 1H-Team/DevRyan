const { ipcRenderer } = require('electron');

// Deliberately reproduce the observed clean-exit in this disposable renderer.
ipcRenderer.once('fixture-clean-exit', () => process.exit(0));
