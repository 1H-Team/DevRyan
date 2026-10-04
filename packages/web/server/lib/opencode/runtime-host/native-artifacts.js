import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifySessionExecutionLauncher } from '@openchamber/harness-runtime/lib/session-execution.js';
import { REVIEWED_AST_ASSET_SHA256 } from './reviewed-package-transforms.js';
import { REVIEWED_CLAUDE_ASSETS, REVIEWED_CLAUDE_CREDENTIALS } from './reviewed-claude-transform.js';

const exec = promisify(execFile), digestPattern = /^[a-f0-9]{64}$/;
const fail = () => Object.assign(new Error('native_runtime_artifacts_unverified'), { code: 'native_runtime_artifacts_unverified', status: 503 });
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Portable output verification never requires the build checkout or node_modules. */
export async function verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher }) {
  if (!path.isAbsolute(manifestPath ?? '') || !digestPattern.test(manifestSha256) || !path.isAbsolute(launcher ?? '')) throw fail();
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail();
  const bytes = await fs.readFile(manifestPath);
  if (createHash('sha256').update(bytes).digest('hex') !== manifestSha256) throw fail();
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || !digestPattern.test(manifest.buildId) || manifest.opencodeVersion !== '2.0.20'
    || manifest.bunVersion !== '1.3.14' || manifest.target !== `bun-${process.platform}-${process.arch}`
    || !digestPattern.test(manifest.inputs?.coreDigest) || !digestPattern.test(manifest.inputs?.lockSha256)
    || !Array.isArray(manifest.inputs.reviewedPlugins) || !Array.isArray(manifest.inputs.nativeRegistrations) || !manifest.inputs.nativeRegistrations.length
    || [...manifest.inputs.nativeRegistrations, ...manifest.inputs.reviewedPlugins].some(origin => !origin || typeof origin.id !== 'string' || !origin.id
      || !digestPattern.test(origin.manifestDigest) || !Array.isArray(origin.capabilities)
      || origin.capabilities.some(capability => !['read','write','process','network','managed-task','control','provider'].includes(capability)))
    || manifest.compiledContracts !== undefined && (!Array.isArray(manifest.compiledContracts) || manifest.compiledContracts.length > 32
      || new Set(manifest.compiledContracts).size !== manifest.compiledContracts.length || manifest.compiledContracts.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(value)))
    || !Array.isArray(manifest.files)
    || manifest.files.length < 2 || manifest.files.length > 256) throw fail();
  const directory = await fs.realpath(path.dirname(manifestPath)), files = new Map();
  let controller, writer, reviewedAst, reviewedConfiguration, reviewedClaudeCredentials;
  const reviewedClaude={};
  for (const file of manifest.files) {
    if (!file || !['controller','writer','asset'].includes(file.role) || typeof file.path !== 'string'
      || !file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
      || /[\u0000-\u001f]/.test(file.path) || files.has(file.path) || !digestPattern.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || !['unsigned','adhoc','release'].includes(file.signing?.mode)) throw fail();
    const target = path.join(directory, file.path), actual = await fs.lstat(target);
    if (!actual.isFile() || await fs.realpath(target) !== target || actual.size !== file.size
      || (actual.mode & 0o777) !== file.mode || await hashFile(target) !== file.sha256) throw fail();
    files.set(file.path, target);
    if (file.path === 'DevRyan-native-configuration.mjs') {
      if (reviewedConfiguration || file.role !== 'asset' || file.mode !== 0o644) throw fail();
      reviewedConfiguration = Object.freeze({ path: target, sha256: file.sha256, size: file.size });
    }
    if (file.path === REVIEWED_CLAUDE_CREDENTIALS.path) {
      if (reviewedClaudeCredentials || file.role !== 'asset' || file.mode !== REVIEWED_CLAUDE_CREDENTIALS.mode
        || file.sha256 !== REVIEWED_CLAUDE_CREDENTIALS.sha256 || file.size > 65536) throw fail();
      reviewedClaudeCredentials = Object.freeze({ path: target, sha256: file.sha256 });
    }
    const ast = path.basename(file.path) === 'DevRyan-ast-grep-darwin-arm64';
    const claudeAsset=Object.entries(REVIEWED_CLAUDE_ASSETS).find(([,asset])=>asset.path===file.path);
    if(claudeAsset){
      const [name,asset]=claudeAsset;if(reviewedClaude[name]||file.role!=='asset'||file.sha256!==asset.sha256||file.mode!==asset.mode)throw fail();
      reviewedClaude[name]=Object.freeze({path:target,sha256:file.sha256});
    }
    if (ast) {
      if (reviewedAst || file.role !== 'asset' || file.sha256 !== REVIEWED_AST_ASSET_SHA256 || !(file.mode & 0o111)) throw fail();
      reviewedAst = Object.freeze({ path: target, sha256: file.sha256 });
    }
    if (file.role === 'controller' || file.role === 'writer') {
      if (!path.basename(file.path).startsWith(`DevRyan-native-${file.role}`) || !(file.mode & 0o111)) throw fail();
      if (file.role === 'controller') { if (controller) throw fail(); controller = target; }
      else { if (writer) throw fail(); writer = target; }
    }
    if (file.role === 'controller' || file.role === 'writer' || ast || claudeAsset) {
      if (process.platform === 'darwin') {
        if (file.signing.mode === 'unsigned' || file.signing.verified !== true || !/^[a-f0-9]{40,64}$/.test(file.signing.cdhash)) throw fail();
        await exec('/usr/bin/codesign', ['--verify', '--strict', target], { maxBuffer: 64 * 1024 });
        const info = await exec('/usr/bin/codesign', ['-d', '--verbose=4', target], { maxBuffer: 64 * 1024 });
        const cdhash = /^CDHash=(.+)$/m.exec(info.stderr)?.[1];
        const teamID = /^TeamIdentifier=(.+)$/m.exec(info.stderr)?.[1];
        if (file.signing.cdhash !== cdhash || (file.signing.mode === 'release' && (!file.signing.teamID || file.signing.teamID === 'not set' || file.signing.teamID !== teamID))) throw fail();
      }
    }
  }
  if (!controller || !writer || manifest.inputs.reviewedPlugins.some(origin => origin.id === 'devryan.slim') && !reviewedAst
    || manifest.inputs.reviewedPlugins.some(origin => ['devryan.slim','devryan.ponytail'].includes(origin.id)) && !reviewedConfiguration
    || !await verifySessionExecutionLauncher({ launcher })) throw fail();
  if(manifest.inputs.reviewedPlugins.some(origin=>origin.id==='devryan.provider-compat')&&(!reviewedClaude.claude||!reviewedClaude.libsql))throw fail();
  if(Object.keys(reviewedClaude).length===1)throw fail();
  if(manifest.compiledContracts?.some(value=>['devryan.bundle.credentials/1','devryan.bundle.credentials/2','devryan.claude-lifecycle/1'].includes(value)) && reviewedClaude.claude && !reviewedClaudeCredentials)throw fail();
  return Object.freeze({ manifest, manifestPath, manifestSha256, directory, controller, writer, launcher, reviewedAst, reviewedConfiguration, reviewedClaudeCredentials,
    ...(reviewedClaude.claude?{reviewedClaude:Object.freeze(reviewedClaude)}:{}) });
}
