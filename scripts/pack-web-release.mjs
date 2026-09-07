import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Private workspaces cannot be fetched from npm. Bundle their source packages,
// and expose their external runtime requirements to the normal npm installer.
export function planWorkspaceBundle(source, workspaces) {
  const dependencies = { ...source.dependencies };
  const bundled = new Map();
  const visit = (name, range) => {
    if (!range.startsWith('workspace:')) return;
    if (range !== 'workspace:*' || !workspaces.has(name)) throw new Error(`Unsupported workspace dependency: ${name}`);
    if (bundled.has(name)) return;
    const workspace = workspaces.get(name);
    if (!workspace.version) throw new Error(`Workspace version missing: ${name}`);
    bundled.set(name, workspace);
    dependencies[name] = workspace.version;
    for (const [dependency, specifier] of Object.entries(workspace.dependencies || {})) {
      if (specifier.startsWith('workspace:')) visit(dependency, specifier);
      else {
        if (dependencies[dependency] && dependencies[dependency] !== specifier) throw new Error(`Conflicting bundled dependency: ${dependency}`);
        dependencies[dependency] = specifier;
      }
    }
  };
  for (const [name, range] of Object.entries(source.dependencies || {})) visit(name, range);
  const manifest = { ...source, dependencies, bundledDependencies: [...bundled.keys()] };
  delete manifest.devDependencies;
  return { manifest, bundled };
}

const command = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr}`);
  return result.stdout;
};

export async function packWebRelease({ root, destination }) {
  const workspaces = new Map();
  const directories = new Map();
  for (const entry of await fs.readdir(path.join(root, 'packages'))) {
    const directory = path.join(root, 'packages', entry);
    const manifest = await fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse, () => null);
    if (!manifest) continue;
    workspaces.set(manifest.name, manifest);
    directories.set(manifest.name, directory);
  }
  const source = workspaces.get('@openchamber/web');
  const { manifest, bundled } = planWorkspaceBundle(source, workspaces);
  await fs.mkdir(destination, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(destination, '.web-pack-'));
  const staging = path.join(scratch, 'staging');
  const unpack = async (name, target) => {
    const result = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], directories.get(name)));
    await fs.mkdir(target, { recursive: true });
    command('tar', ['-xzf', path.join(scratch, result[0].filename), '--strip-components=1', '-C', target], root);
  };
  try {
    await unpack(source.name, staging);
    for (const [name, workspace] of bundled) {
      const target = path.join(staging, 'node_modules', name);
      await unpack(name, target);
      const packaged = { ...workspace, dependencies: { ...workspace.dependencies } };
      delete packaged.devDependencies;
      for (const [dependency, range] of Object.entries(packaged.dependencies)) {
        if (range.startsWith('workspace:')) packaged.dependencies[dependency] = workspaces.get(dependency).version;
      }
      await fs.writeFile(path.join(target, 'package.json'), `${JSON.stringify(packaged, null, 2)}\n`);
    }
    await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], staging));
    return path.join(destination, result[0].filename);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 2) throw new Error('pack-web-release accepts no arguments');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(await packWebRelease({ root, destination: path.join(root, 'packages/web') }));
}
