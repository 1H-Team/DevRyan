import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code, status: 403 });
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const git = file => file.split(path.sep).includes('.git');
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

/** Capture data assets only. Executable plugin code is never loaded from this manifest. */
export async function captureReviewedSkill({ directory, skill, allowedRoots, parseMarkdown }) {
  if (!skill || typeof skill.name !== 'string' || !skill.name || !path.isAbsolute(skill.path)) throw fail('native_skill_invalid');
  const file = await fs.realpath(skill.path), root = path.dirname(file);
  const roots = await Promise.all(allowedRoots.map(value => fs.realpath(value)));
  if (git(skill.path) || git(file) || !roots.some(value => within(value, file))) throw fail('native_skill_unreviewed');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) throw fail('native_skill_too_large');
  const bytes = await fs.readFile(file), parsed = parseMarkdown(file);
  if (typeof parsed.body !== 'string' || parsed.frontmatter?.name && parsed.frontmatter.name !== skill.name) throw fail('native_skill_invalid');
  const resources = [];
  let total = bytes.length;
  async function walk(folder) {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const lexical = path.join(folder, entry.name), canonical = await fs.realpath(lexical);
      if (!within(root, canonical) || git(canonical)) throw fail('native_skill_resource_escape');
      if (entry.isSymbolicLink()) throw fail('native_skill_resource_symlink');
      if (entry.isDirectory()) { await walk(lexical); continue; }
      if (!entry.isFile()) throw fail('native_skill_resource_invalid');
      if (canonical === file) continue;
      const size = (await fs.stat(canonical)).size;
      total += size;
      if (size > MAX_RESOURCE_BYTES || total > 16 * MAX_RESOURCE_BYTES || resources.length >= 512) throw fail('native_skill_resources_too_large');
      resources.push({ relativePath: path.relative(root, lexical).split(path.sep).join('/'), canonicalPath: canonical,
        sha256: hash(await fs.readFile(canonical)), size });
    }
  }
  await walk(root);
  return { id: `devryan-${hash(`${directory}\0${skill.source ?? 'opencode'}\0${file}`).slice(0, 32)}`, name: skill.name,
    path: file, content: parsed.body, description: typeof parsed.frontmatter?.description === 'string' ? parsed.frontmatter.description : '',
    source: skill.source ?? 'opencode', scope: skill.scope ?? 'user', bodySha256: hash(parsed.body), fileSha256: hash(bytes), fileSize:bytes.length, resources };
}

/** The host calls this inside the actual read permit and direct ledger fence. */
export async function readReviewedSkillResource(snapshot, input) {
  if (input.snapshotDigest !== snapshot.digest || typeof input.relativePath !== 'string' || !input.relativePath
    || input.relativePath.includes('\\') || input.relativePath.split('/').some(part => !part || part === '..' || part === '.' || part === '.git')) {
    throw fail('native_skill_resource_unreviewed');
  }
  const location = snapshot.locations.find(value => value.directory === input.directory);
  const skill = location?.skills.find(value => value.id === input.skillID);
  const resource = skill && input.relativePath===path.basename(skill.path) && Number.isSafeInteger(skill.fileSize)
    ? {canonicalPath:skill.path,sha256:skill.fileSha256,size:skill.fileSize}
    : skill?.resources.find(value => value.relativePath === input.relativePath);
  if (!skill || !resource) throw fail('native_skill_resource_unreviewed');
  const lexical = path.join(path.dirname(skill.path), input.relativePath), canonical = await fs.realpath(lexical);
  if (canonical !== resource.canonicalPath || !within(path.dirname(skill.path), canonical) || git(canonical)) throw fail('native_skill_resource_changed');
  const file = await fs.open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const current = await fs.stat(resource.canonicalPath);
    if (!stat.isFile() || stat.size !== resource.size || stat.size > MAX_RESOURCE_BYTES || stat.ino !== current.ino || stat.dev !== current.dev
      || await fs.realpath(lexical) !== resource.canonicalPath) throw fail('native_skill_resource_changed');
    const bytes = await file.readFile();
    if (bytes.length !== resource.size || hash(bytes) !== resource.sha256 || await fs.realpath(lexical) !== canonical) throw fail('native_skill_resource_changed');
    return bytes;
  } finally { await file.close(); }
}

const normalizeSkillKey=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
/** Exact IDs survive display-name collisions; legacy aliases stay unambiguous. */
export function buildReviewedSkillAliasIndex(skills) {
  const canonical=new Map(),normalized=new Map();
  const add=(index,name,id)=>{
    if(!index.has(name))index.set(name,id);
    else if(index.get(name)!==id)index.set(name,null);
  };
  for(const skill of skills) {
    add(canonical,skill.name.trim(),skill.id);
    for(const alias of [skill.name,path.basename(path.dirname(skill.path))]) {
      const key=normalizeSkillKey(alias);if(key)add(normalized,key,skill.id);
    }
  }
  return {canonical,normalized};
}
export function reviewedSkillAliases(skills) {
  const index=buildReviewedSkillAliasIndex(skills),aliases=new Map();
  for(const [name,targetID]of index.canonical)if(targetID!==null)aliases.set(name,targetID);
  const slugs=new Map();
  for(const skill of skills){const slug=path.basename(path.dirname(skill.path));if(!slugs.has(slug))slugs.set(slug,skill.id);else if(slugs.get(slug)!==skill.id)slugs.set(slug,null);}
  for(const [name,targetID]of slugs)if(targetID!==null && !index.canonical.has(name))aliases.set(name,targetID);
  for(const [name,targetID]of index.normalized)if(targetID!==null && !index.canonical.has(name))aliases.set(name,targetID);
  return [...aliases].sort(([left],[right])=>left.localeCompare(right)).map(([name,targetID])=>({name,targetID}));
}
/** Call before sealing the actual skill tool invocation, under its fresh permit. */
export function resolveReviewedSkillAlias(snapshot,directory,requested) {
  const skills=snapshot.locations.find(location=>location.directory===directory)?.skills;
  const raw=typeof requested==='string'?requested.trim():'';
  if(!skills || !raw)return null;
  if(skills.some(skill=>skill.id===raw))return raw;
  const index=buildReviewedSkillAliasIndex(skills);
  if(index.canonical.has(raw))return index.canonical.get(raw);
  const key=normalizeSkillKey(raw);if(!key)return null;
  if(index.normalized.has(key))return index.normalized.get(key);
  const prefixed=new Set();
  for(const [alias,id]of index.normalized)if(alias.startsWith(key)||key.startsWith(alias)) {
    if(id===null)return null;prefixed.add(id);
  }
  return prefixed.size===1?[...prefixed][0]:null;
}

/** Exact path lookup only; this is a grant index, never broad root authorization. */
export function lookupReviewedSkillResourcePath(snapshot,input){
 if(input.snapshotDigest!==snapshot.digest || typeof input.targetPath!=='string' || !path.isAbsolute(input.targetPath) || git(input.targetPath))return null;
 const target=path.resolve(input.targetPath),location=snapshot.locations.find(value=>value.directory===input.directory);
 for(const skill of location?.skills??[]){
  if(target===skill.path && Number.isSafeInteger(skill.fileSize))return {snapshotDigest:snapshot.digest,directory:input.directory,skillID:skill.id,relativePath:path.basename(skill.path)};
  const resource=skill.resources.find(value=>value.canonicalPath===target);
  if(resource)return {snapshotDigest:snapshot.digest,directory:input.directory,skillID:skill.id,relativePath:resource.relativePath};
 }
 return null;
}
