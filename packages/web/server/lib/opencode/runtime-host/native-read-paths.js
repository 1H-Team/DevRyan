import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const denied = () => Object.assign(new Error('native_read_root_denied'), {code:'native_read_root_denied',status:403});

const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const metadata = (target) => target.split(path.sep).some(component => component.toLowerCase() === '.git');
export const nativeWebfetchBinaryDirectory=(tmp,directory)=>path.join(tmp,'devryan-webfetch',createHash('sha256').update(directory).digest('hex'));
// A missing filename still belongs to its real parent, preserving native
// missing-file/sibling recovery while resolving every existing symlink.
async function canonicalTarget(target) {
  try { return await fs.realpath(target); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalTarget(parent), path.basename(target));
  }
}

export function createNativeReadGuard(options) {
  return async (target) => {
    if (!path.isAbsolute(target)) throw denied();
    const lexical = path.resolve(target);
    const canonical = await canonicalTarget(lexical);
    const roots = await Promise.all((options.readRoots ?? [options.directory]).map(root => canonicalTarget(path.resolve(root))));
    const protectedRoots = await Promise.all((options.protectedRoots ?? []).map(root => canonicalTarget(path.resolve(root))));
    if (metadata(lexical) || metadata(canonical) || !roots.some(root => within(root, canonical))
      || protectedRoots.some(root => within(root, lexical) || within(root, canonical))) {
      throw denied();
    }
  };
}
