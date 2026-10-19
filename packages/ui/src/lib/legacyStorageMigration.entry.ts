// Side-effect entry: web entrypoints import it first, before any store hydrates.
import { migrateLegacyBrowserStorage } from './legacyStorageMigration';

migrateLegacyBrowserStorage();
