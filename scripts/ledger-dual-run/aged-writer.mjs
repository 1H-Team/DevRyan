// Writes the aged-profile corpus (scripts/opencode-v2-native/aged-profile-fixture.mjs)
// into a fixture folder, in a child process whose HOME, XDG folders and Git
// configuration are the stage's (dual-run-runner.mjs armEnvironment).
//
//   node aged-writer.mjs <fixture folder>
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAgedProfile } from '../opencode-v2-native/aged-profile-fixture.mjs';
import { writeProject } from './dual-run-fixture.mjs';

const root = path.resolve(process.argv[2]);
const directory = path.join(root, 'project');
await writeProject(directory, { size: 'small' });
const profile = await writeAgedProfile({ webDataDirectory: path.join(root, 'webdata'), directory, files: 20 });
await fs.writeFile(path.join(root, 'aged-profile.json'), `${JSON.stringify({ scenarios: profile.scenarios, sessions: profile.native.sessions.map((row) => row.id) })}\n`);
