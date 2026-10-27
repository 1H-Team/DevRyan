// Side-effect module: import it first in a process entry so every later module,
// including ones that read env at import time, sees the DEVRYAN_* names.
import { adoptLegacyEnvironment } from './legacy-environment.js';

adoptLegacyEnvironment(process.env);
