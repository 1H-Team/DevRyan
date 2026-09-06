import './isolated-home.mjs';
import { app } from 'electron';
import { preparePackagedQaHost } from './packaged-host-policy.mjs';

await preparePackagedQaHost({ app });
await import('./dist-bundle/main.mjs');
