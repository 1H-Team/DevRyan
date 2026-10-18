import { artifactDiagnostic } from '@openchamber/shared-runtime/startup-diagnostics.js';
import {isNativeOpenCodeVersion} from '../version-policy.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifySessionExecutionLauncher } from '@openchamber/harness-runtime/lib/session-execution.js';
import { REVIEWED_AST_ASSET_SHA256 } from './reviewed-ast-asset.js';
import { REVIEWED_CLAUDE_ASSETS, REVIEWED_CLAUDE_CREDENTIALS } from './reviewed-claude-transform.js';
import {assertWindowsBinaryArchitecture,reviewedWindowsRuntimeAsset,readWindowsLibsqlEvidence} from './reviewed-windows-assets.js';
import {nativeArtifactInventoryLimit,validWindowsArtifactPath,verifyWindowsGitInventory,verifyWindowsGitMetadata} from './reviewed-windows-git.js';

const exec = promisify(execFile), digestPattern = /^[a-f0-9]{64}$/;
// This previously reviewed binary is migration/explicit rollback authority, never a new target pin.
export const REVIEWED_PREVIOUS_CLAUDE_ASSET = Object.freeze({ version: '2.1.251', path: 'DevRyan-Claude-darwin-arm64',
  sha256: '625869b01e0050f260b2980fac248fd9cef9e462612bded4ec9d3d49ff8969a5', size: 197171680, mode: 0o755 });
export const isReviewedPreviousClaudeAsset = (file, purpose, platform = process.platform, arch = process.arch) =>
  ['bundle-source', 'bundle-rollback'].includes(purpose) && platform === 'darwin' && arch === 'arm64'
  && file?.role === 'asset' && (file.version === undefined || file.version === REVIEWED_PREVIOUS_CLAUDE_ASSET.version)
  && ['path', 'sha256', 'size', 'mode'].every(key => file[key] === REVIEWED_PREVIOUS_CLAUDE_ASSET[key]);
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Initial provisioning needs a bounded manifest read before it can pin its digest. */
export async function readNativeRuntimeManifest(manifestPath, purpose = 'current') {
  let reason = 'manifest_invalid';
  const verificationPurpose = ['current', 'bundle-source', 'bundle-rollback'].includes(purpose) ? purpose : 'current';
  try {
    if (purpose !== verificationPurpose) throw new Error();
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error();
    const bytes = await fs.readFile(manifestPath);
    if (bytes.length > 4 * 1024 * 1024) throw new Error();
    return { bytes, manifest: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') reason = 'manifest_missing';
    const diagnostic = { stage: 'manifest', reason, artifact: 'native-bundle.json', purpose: verificationPurpose };
    console.warn('[runtime-bundle] artifact verification failed', diagnostic);
    throw Object.assign(new Error('native_runtime_artifacts_unverified'), { code: 'native_runtime_artifacts_unverified', status: 503, diagnostic });
  }
}

/** Portable output verification never requires the build checkout or node_modules. */
export async function verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher, purpose = 'current' }) {
  let stage = 'manifest', artifact = 'native-bundle.json';
  const timings = { artifact_hashing: 0, artifact_signatures: 0 };
  const timed = async (phase, operation) => {
    const startedAt = performance.now();
    try { return await operation(); } finally { timings[phase] += performance.now() - startedAt; }
  };
  const fail = (reason = ({ manifest: 'manifest_invalid', inventory: 'manifest_invalid', payload: 'payload_invalid',
    signature: 'signature_failure', reviewed_asset: 'reviewed_asset_mismatch', launcher: 'launcher_rejected' })[stage]) =>
    Object.assign(new Error('native_runtime_artifacts_unverified'), { code: 'native_runtime_artifacts_unverified', status: 503,
      diagnostic: { stage, reason, purpose: ['current', 'bundle-source', 'bundle-rollback'].includes(purpose) ? purpose : 'current',
        ...(/^(?:native-bundle\.json|DevRyan-[A-Za-z0-9._-]{1,128})$/.test(artifact) ? { artifact } : {}) } });
  let outcome = 'failed';
  try {
  if (!['current', 'bundle-source', 'bundle-rollback'].includes(purpose)) throw fail();
  if (!path.isAbsolute(manifestPath ?? '') || !digestPattern.test(manifestSha256) || !path.isAbsolute(launcher ?? '')) throw fail();
  const { bytes, manifest } = await readNativeRuntimeManifest(manifestPath, purpose);
  if (createHash('sha256').update(bytes).digest('hex') !== manifestSha256) throw fail('digest_mismatch');
  if (manifest.target !== `bun-${process.platform}-${process.arch}`) throw fail('unsupported_platform');
  if (manifest.admission === false || manifest.status === 'unqualified' || manifest.schema !== 1 || !digestPattern.test(manifest.buildId) || !isNativeOpenCodeVersion(manifest.opencodeVersion)
    || manifest.bunVersion !== '1.3.14' || manifest.target !== `bun-${process.platform}-${process.arch}`
    || !digestPattern.test(manifest.inputs?.coreDigest) || !digestPattern.test(manifest.inputs?.lockSha256)
    || !Array.isArray(manifest.inputs.reviewedPlugins) || !Array.isArray(manifest.inputs.nativeRegistrations) || !manifest.inputs.nativeRegistrations.length
    || [...manifest.inputs.nativeRegistrations, ...manifest.inputs.reviewedPlugins].some(origin => !origin || typeof origin.id !== 'string' || !origin.id
      || !digestPattern.test(origin.manifestDigest) || !Array.isArray(origin.capabilities)
      || origin.capabilities.some(capability => !['read','write','process','network','managed-task','control','provider'].includes(capability)))
    || manifest.compiledContracts !== undefined && (!Array.isArray(manifest.compiledContracts) || manifest.compiledContracts.length > 32
      || new Set(manifest.compiledContracts).size !== manifest.compiledContracts.length || manifest.compiledContracts.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(value)))
    || !Array.isArray(manifest.files)
    || manifest.files.length < 2 || manifest.files.length > nativeArtifactInventoryLimit(manifest,process.platform,process.arch)) throw fail();
  stage = 'inventory';
  if(process.platform==='win32')verifyWindowsGitMetadata(manifest.windowsGit,process.arch);
  const directory = await fs.realpath(path.dirname(manifestPath)), files = new Map();
  const foldedPaths=new Set();
  let controller, writer, reviewedAst, reviewedConfiguration, reviewedClaudeCredentials, windowsLibsqlEvidence;
  const reviewedClaude={};
  for (const file of manifest.files) {
    stage = 'inventory'; artifact = 'native-bundle.json';
    if (!file || !['controller','writer','asset'].includes(file.role) || typeof file.path !== 'string'
      || !file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
      || /[\u0000-\u001f]/.test(file.path) || files.has(file.path) || !digestPattern.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || !['unsigned','adhoc','release'].includes(file.signing?.mode)) throw fail();
    if(process.platform==='win32'){
      const folded=file.path.toLowerCase();
      if(!validWindowsArtifactPath(file.path)||foldedPaths.has(folded))throw fail();foldedPaths.add(folded);
    }
    stage = 'payload'; artifact = path.basename(file.path);
    const target = path.join(directory, file.path), actual = await fs.lstat(target);
    if (!actual.isFile() || actual.isSymbolicLink() || await fs.realpath(target) !== target) throw fail();
    if (actual.size !== file.size) throw fail('digest_mismatch');
    if (process.platform !== 'win32' && (actual.mode & 0o777) !== file.mode) throw fail('mode_mismatch');
    if (await timed('artifact_hashing', () => hashFile(target)) !== file.sha256) throw fail('digest_mismatch');
    stage = 'reviewed_asset';
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
    let windowsAsset;
    if(process.platform==='win32'){
      try{windowsAsset=reviewedWindowsRuntimeAsset(file,process.arch);}catch{throw fail();}
      if(file.role==='controller'||file.role==='writer'||['ast','claude','libsql'].includes(windowsAsset)){
        const handle=await fs.open(target,'r');
        try{const header=Buffer.alloc(65536),{bytesRead}=await handle.read(header,0,header.length,0);assertWindowsBinaryArchitecture(header.subarray(0,bytesRead),process.arch);}
        catch{throw fail();}finally{await handle.close();}
      }
      if(windowsAsset==='evidence')windowsLibsqlEvidence={path:target,row:file};
    }
    const ast = process.platform==='win32'?windowsAsset==='ast':path.basename(file.path) === 'DevRyan-ast-grep-darwin-arm64';
    const claudeAsset=process.platform==='win32'
      ? ['claude','libsql'].includes(windowsAsset)?[windowsAsset,file]:undefined
      : Object.entries(REVIEWED_CLAUDE_ASSETS).find(([,asset])=>asset.path===file.path);
    if(claudeAsset){
      const [name,asset]=claudeAsset;if(reviewedClaude[name]||file.role!=='asset'||file.mode!==asset.mode
        ||file.sha256!==asset.sha256&&!(name==='claude'&&isReviewedPreviousClaudeAsset(file,purpose)))throw fail();
      reviewedClaude[name]=Object.freeze({path:target,sha256:file.sha256});
    }
    if (ast) {
      if (reviewedAst || file.role !== 'asset' || process.platform!=='win32' && file.sha256 !== REVIEWED_AST_ASSET_SHA256 || !(file.mode & 0o111)) throw fail();
      reviewedAst = Object.freeze({ path: target, sha256: file.sha256 });
    }
    if (file.role === 'controller' || file.role === 'writer') {
      if (!path.basename(file.path).startsWith(`DevRyan-native-${file.role}`) || !(file.mode & 0o111)) throw fail();
      if (file.role === 'controller') { if (controller) throw fail(); controller = target; }
      else { if (writer) throw fail(); writer = target; }
    }
    if (file.role === 'controller' || file.role === 'writer' || ast || claudeAsset) {
      if (process.platform === 'darwin') {
        stage = 'signature';
        if (file.signing.mode === 'unsigned' || file.signing.verified !== true || !/^[a-f0-9]{40,64}$/.test(file.signing.cdhash)) throw fail();
        await timed('artifact_signatures', () => exec('/usr/bin/codesign', ['--verify', '--strict', target], { timeout: 15_000, maxBuffer: 64 * 1024 }));
        const info = await timed('artifact_signatures', () => exec('/usr/bin/codesign', ['-d', '--verbose=4', target], { timeout: 15_000, maxBuffer: 64 * 1024 }));
        const cdhash = /^CDHash=(.+)$/m.exec(info.stderr)?.[1];
        const teamID = /^TeamIdentifier=(.+)$/m.exec(info.stderr)?.[1];
        if (file.signing.cdhash !== cdhash || (file.signing.mode === 'release' && (!file.signing.teamID || file.signing.teamID === 'not set' || file.signing.teamID !== teamID))) throw fail();
      }
    }
  }
  stage = 'inventory'; artifact = 'native-bundle.json';
  if (!controller || !writer || manifest.inputs.reviewedPlugins.some(origin => origin.id === 'devryan.slim') && !reviewedAst
    || manifest.inputs.reviewedPlugins.some(origin => ['devryan.slim','devryan.ponytail'].includes(origin.id)) && !reviewedConfiguration) throw fail();
  stage = 'launcher'; artifact = path.basename(launcher);
  if (!await verifySessionExecutionLauncher({ launcher })) throw fail();
  stage = 'reviewed_asset'; artifact = 'native-bundle.json';
  if(manifest.inputs.reviewedPlugins.some(origin=>origin.id==='devryan.provider-compat')&&(!reviewedClaude.claude||!reviewedClaude.libsql))throw fail();
  if(Object.keys(reviewedClaude).length===1)throw fail();
  if(manifest.compiledContracts?.some(value=>['devryan.bundle.credentials/1','devryan.bundle.credentials/2','devryan.claude-lifecycle/1'].includes(value)) && reviewedClaude.claude && !reviewedClaudeCredentials)throw fail();
  if(process.platform==='win32'&&reviewedClaude.libsql){
    if(!windowsLibsqlEvidence)throw fail();
    try{
      const evidence=await readWindowsLibsqlEvidence(windowsLibsqlEvidence.path,windowsLibsqlEvidence.row,process.arch);
      if(evidence.sha256!==reviewedClaude.libsql.sha256||files.get(evidence.binary)!==reviewedClaude.libsql.path)throw fail();
    }catch{throw fail();}
  }
  const reviewedGit=process.platform==='win32'?await verifyWindowsGitInventory({manifest,directory,arch:process.arch}):undefined;
  outcome = 'completed';
  return Object.freeze({ manifest, manifestPath, manifestSha256, directory, controller, writer, launcher, reviewedAst, reviewedConfiguration, reviewedClaudeCredentials,
    ...(reviewedGit?{reviewedGit}:{}),
    ...(reviewedClaude.claude?{reviewedClaude:Object.freeze(reviewedClaude)}:{}) });
  } catch (error) {
    const failure = artifactDiagnostic(error) ? error : fail(error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? stage === 'manifest' ? 'manifest_missing' : stage === 'payload' ? 'payload_missing' : undefined : undefined);
    // Early boot may precede journal construction. Never log raw OS errors or paths.
    console.warn('[runtime-bundle] artifact verification failed', failure.diagnostic);
    throw failure;
  } finally {
    for (const [phase, elapsedMs] of Object.entries(timings)) if (elapsedMs > 0)
      console.info('[runtime-bundle] startup phase', JSON.stringify({ phase, outcome, elapsedMs }));
  }
}
