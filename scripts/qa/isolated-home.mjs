import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// Imported before host modules and private provider-plugin dependencies. Never
// change HOME: that would change the calling task's user/environment contract.
const qaHome = process.env.DEVRYAN_QA_HOME;
if (!qaHome || !path.isAbsolute(qaHome)) throw new Error('QA home must be an absolute owned directory');
const ownerFile = path.join(qaHome, '.devryan-qa-home');
if (!fs.statSync(ownerFile).isFile()) throw new Error('QA home ownership marker is missing');
// Confined execution already owns a per-call scratch home. Redirecting its
// plugins back to the QA profile makes local tool initialization try to write
// outside that lease (and can contend with sibling workers).
const resolvedHome = process.env.DEVRYAN_EXECUTION_WORKER === '1' ? process.env.HOME : qaHome;
if (!resolvedHome || !path.isAbsolute(resolvedHome)) throw new Error('Execution home must be absolute');
os.homedir = () => resolvedHome;
syncBuiltinESMExports();
