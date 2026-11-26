// A group table (groups.mjs shape) whose one entry is a real group served
// from a copy of its files (the census's bite test): the copy may hold a
// planted route or branch. DEVRYAN_BACKEND_GROUP_COPY names the group and the
// directory holding the copy (JSON: { "name", "dir" }); the copy has the
// group's files under the same names, relative to their common directory.
// The group host loads it with --table=<this file>; the test builds the same
// entry with copiedGroup.
import path from 'node:path';
import { REPOSITORY_ROOT } from '../edge.mjs';
import { GROUPS as REAL } from '../groups.mjs';

/** The common directory of a group's files (repository-relative). */
export const groupDirectory = (files) => files.map((file) => path.posix.dirname(file)).reduce((common, dir) => { while (!`${dir}/`.startsWith(`${common}/`)) common = path.posix.dirname(common); return common; });

/** The real entry `name`, with its registrar and files taken from `dir` (absolute). */
export function copiedGroup({ name, dir }) {
  const real = REAL[name];
  if (!real) throw new Error(`no group ${name}`);
  const base = groupDirectory(real.files);
  const moved = (file) => path.relative(REPOSITORY_ROOT, path.join(dir, path.posix.relative(base, file)));
  return Object.freeze({ ...real, registrar: Object.freeze({ ...real.registrar, module: moved(real.registrar.module) }), files: Object.freeze(real.files.map(moved)) });
}

const spec = process.env.DEVRYAN_BACKEND_GROUP_COPY ? JSON.parse(process.env.DEVRYAN_BACKEND_GROUP_COPY) : null;
export const GROUPS = Object.freeze(spec ? { [spec.name]: copiedGroup(spec) } : {});
