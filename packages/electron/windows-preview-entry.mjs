import { app } from 'electron';
import { configureWindowsPreview } from './windows-preview.mjs';

configureWindowsPreview({ app, resourcesPath: process.resourcesPath });
// Keep this dynamic: main reads settings and eventually imports web/index.
await import('./main.mjs');
