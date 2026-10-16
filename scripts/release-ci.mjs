// Fixed CI operations; reusable validation lives in release-artifacts/image modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseAssetName } from '../packages/electron/release-assets.mjs';
import { describeDirectoryAssets } from './verify-release-assets.mjs';
import { BOT_RUNTIME_IMAGE_DEFINITIONS, assembleBotRuntimeImages, createBotRuntimeImageBuildPlan, signBotRuntimeImage } from './build-bot-runtime-images.mjs';
import { readBotRuntimeImageInputs, resolveBotRuntimeImages, tagBotRuntimeImageInputs } from './bot-runtime-image-inputs.mjs';
import { describeWebArtifact, verifyWebArtifact, stageWebArtifact, hash, releaseIdentity, verifyPreparedMetadata, assertBotInputPreparation } from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const identity = await releaseIdentity(root, env.GITHUB_SHA);
if (env.RELEASE_CANDIDATE === 'true' && env.RELEASE_DRY_RUN !== 'true') throw new Error('Candidate runs must be read only');
const botInputsOnly = assertBotInputPreparation(env, identity.release);
if (botInputsOnly && !['image-plan', 'image-resolve', 'image-sign', 'image-assemble'].includes(env.RELEASE_OPERATION)) {
  throw new Error('Bot input preparation prohibits application release operations');
}
const output = path.resolve(env.RELEASE_ARTIFACT_DIR || path.join(root, 'artifacts'));
const write = async (name, value) => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
};
const read = async (name) => JSON.parse(await fs.readFile(path.join(output, name), 'utf8'));
const run = (args) => {
  const result = spawnSync('tar', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Prepared artifact archive operation failed');
};
const preparedArchive = 'prepared.tar.zst';
const botIdentity = { version: identity.release, revision: identity.revision, repositoryPrefix: `ghcr.io/${env.GITHUB_REPOSITORY_OWNER?.toLowerCase()}` };
if (![undefined, 'true', 'false'].includes(env.RELEASE_DRY_RUN)) throw new Error('Invalid RELEASE_DRY_RUN');
switch (env.RELEASE_OPERATION) {
  case 'history-read': {
    const { githubReleaseHistoryClient, readReleaseGateHistory, readReleaseGateReceipts, selectRollingReleaseGateRuns, countUnexplainedReleaseGateFailures } = await import('./release-publication.mjs');
    const client = githubReleaseHistoryClient(env);
    const summary = { protocol: 'devryan.release-history-diagnostic/1', source: identity.revision, version: identity.release,
      complete: false, failureTallyComplete: false, requestLimit: 120, requestCount: 0, runs: [], unexplainedGateFailures: 0 };
    try {
      const allRuns = await client.pages('/actions/workflows/release.yml/runs', 'workflow_runs');
      const history = await readReleaseGateHistory(root, client, allRuns, env.GITHUB_RUN_ID, { source: identity.revision, version: identity.release });
      for (const run of selectRollingReleaseGateRuns(history.runs)) {
        const failures = countUnexplainedReleaseGateFailures(history.jobsByRun.get(run.id), await readReleaseGateReceipts(root, client, run.id), run);
        summary.runs.push({ id: run.id, source: run.head_sha, version: run.releaseVersion, unexplainedGateFailures: failures });
        summary.unexplainedGateFailures += failures;
      }
      summary.complete = true; summary.failureTallyComplete = true;
    } catch (error) {
      summary.error = error.code === 'release_history_incomplete' ? error.code : 'release_history_evidence_unavailable';
      const reason = error.message?.split('\n')[0];
      if (['Historical source has no stable version', 'Historical release workflow changed', 'Historical release repository changed',
        'Historical release event unavailable', 'Historical release identity proof unavailable or expired',
        'Historical admission belongs to another source', 'Historical admission identities conflict',
        'Historical frozen stable identity required', 'Historical inventory belongs to another source'].includes(reason)) summary.reason = reason;
      const httpStatus = /\bHTTP ([1-5][0-9]{2})\b/.exec(error.stderr ?? '');
      if (httpStatus) summary.httpStatus = Number(httpStatus[1]);
      process.exitCode = 1;
    }
    summary.requestCount = client.requestCount;
    summary.stoppedAt = client.lastRequest;
    await write('history-classification.json', summary);
    console.log(JSON.stringify(summary));
    break;
  }
  case 'source-admit': {
    const { admitRelease, githubReleaseClient, selectRollingReleaseGateRuns, assertReleaseSourceHistory, readReleaseGateReceipts, readReleaseGateHistory, countUnexplainedReleaseGateFailures, isExplainedReleaseGuiFailure, isExecutedReleaseGateJob, requireReleaseGateWriteAdmission, resolveQualifiedReleaseCandidate, assertCurrentReleaseGateAttempt, hasRetainedRunAdmission } = await import('./release-publication.mjs');
    const { assertUniversalNativeReleaseAvailable } = await import('./verify-revert-runtime-artifacts.mjs');
    if (env.RELEASE_SCOPE === 'full') assertUniversalNativeReleaseAvailable();
    const client = githubReleaseClient(env);
    const admissionInput = { source: identity.revision, version: identity.release, scope: env.RELEASE_SCOPE,
      notes: await fs.readFile(env.RELEASE_NOTES_PATH, 'utf8'), candidate: env.RELEASE_CANDIDATE === 'true', client };
    const readOnlyAdmission = await admitRelease({ ...admissionInput, environment: { ...env, RELEASE_DRY_RUN: 'true' } });
    if (readOnlyAdmission.publishedNoop === true) {
      const retained = await hasRetainedRunAdmission({ root, client, admission: readOnlyAdmission, runID: env.GITHUB_RUN_ID });
      if (!retained) await write('admission.json', readOnlyAdmission);
      await fs.appendFile(env.GITHUB_OUTPUT, `id=${readOnlyAdmission.releaseID}\nsource=${readOnlyAdmission.source}\npublished_noop=true\nadmission_retained=${retained}\ncandidate_run=\n`);
      break;
    }
    await assertCurrentReleaseGateAttempt({ root, client, identity: { source: identity.revision, version: identity.release, lockfile: identity.lockfile },
      currentRunID: env.GITHUB_RUN_ID, currentRunAttempt: env.GITHUB_RUN_ATTEMPT });
    let history, runs;
    try {
      const allRuns = await client.pages('/actions/workflows/release.yml/runs', 'workflow_runs');
      history = await readReleaseGateHistory(root, client, allRuns, env.GITHUB_RUN_ID, { source: identity.revision, version: identity.release });
      runs = selectRollingReleaseGateRuns(history.runs);
      const { jobsByRun } = history;
      for (const run of history.runs.filter(run => runs.includes(run) || run.releaseVersion === identity.release || run.head_sha === identity.revision)) {
        const jobs = jobsByRun.get(run.id);
        if (!jobs.some(job => ['failure', 'timed_out', 'cancelled'].includes(job.conclusion))) continue;
        const receipts = await readReleaseGateReceipts(root, client, run.id);
        const failed = jobs.filter(job => isExecutedReleaseGateJob(job, receipts) && ['failure', 'timed_out', 'cancelled'].includes(job.conclusion));
        if (!failed.length) continue;
        run.unexplainedGateFailures = countUnexplainedReleaseGateFailures(jobs, receipts, run);
        if (run.unexplainedGateFailures > 0) {
          const times = failed.filter(job => !isExplainedReleaseGuiFailure(job, receipts, run)).map(job => Date.parse(job.completed_at));
          if (!times.every(Number.isFinite)) throw new Error('Failure chronology proof required');
          run.unexplainedGateCompletedAt = Math.max(...times);
        }
        if (run.head_sha === identity.revision && run.id !== Number(env.GITHUB_RUN_ID) && (run.unexplainedGateFailures > 0 || run.conclusion !== 'success')) {
          throw new Error('Earlier gate failure requires investigation; a GUI-only retry must stay in the original retained run');
        }
      }
      assertReleaseSourceHistory(history.runs, jobsByRun, { source: identity.revision, version: identity.release });
      await write('history-classification.json', { complete: true, requestCount: client.requestCount });
    } catch (error) {
      await write('history-classification.json', { complete: false, requestCount: client.requestCount });
      throw error;
    }
    let repaired = await requireReleaseGateWriteAdmission({ root, client, runs,
      candidate: env.RELEASE_CANDIDATE === 'true' || env.RELEASE_DRY_RUN === 'true' || readOnlyAdmission.publishedNoop === true,
      identity: { source: identity.revision, version: identity.release, lockfile: identity.lockfile }, currentRunID: env.GITHUB_RUN_ID });
    if (env.RELEASE_CANDIDATE !== 'true') repaired ??= await resolveQualifiedReleaseCandidate({ root, client,
      identity: { source: identity.revision, version: identity.release, lockfile: identity.lockfile }, currentRunID: env.GITHUB_RUN_ID });
    const admission = await admitRelease({ ...admissionInput, environment: env });
    await write('admission.json', { ...admission, history: history.inventory, historyClassification: { complete: history.complete, requestCount: client.requestCount } });
    if (env.RELEASE_CANDIDATE === 'true' && !admission.publishedNoop) {
      const { selectReleaseStartupBaselines } = await import('./qa/release-startup-contract.mjs');
      const baseline = selectReleaseStartupBaselines(await client.pages('/releases'), identity.release)[0];
      const sourceCommit = await client.tagSource(baseline.version);
      await write('baseline.json', { protocol: 'devryan.release-baseline/1', version: baseline.version, sourceCommit, dmgSha256: baseline.sha256 });
    }
    await fs.appendFile(env.GITHUB_OUTPUT, `id=${admission.releaseID ?? ''}\nsource=${admission.source}\npublished_noop=${admission.publishedNoop === true}\nadmission_retained=false\ncandidate_run=${repaired?.run.id ?? ''}\ncandidate_attempt=${repaired?.run.run_attempt ?? ''}\n`);
    break;
  }
  case 'candidate-budget':
  case 'candidate-resolve': {
    const { githubReleaseClient, resolveQualifiedReleaseCandidate } = await import('./release-publication.mjs');
    const client = githubReleaseClient(env);
    const { run: candidate, samples: selected, limits } = await resolveQualifiedReleaseCandidate({ root, client,
      identity: { source: identity.revision, version: identity.release, lockfile: identity.lockfile },
      currentRunID: env.GITHUB_RUN_ID, candidateRunID: env.RELEASE_OPERATION === 'candidate-budget' ? env.GITHUB_RUN_ID : env.RELEASE_CANDIDATE_RUN,
      candidateCompletion: env.RELEASE_OPERATION === 'candidate-budget' });
    if (env.RELEASE_OPERATION === 'candidate-budget') await write('smoke-limits.json', limits);
    await fs.appendFile(env.GITHUB_OUTPUT, `run=${candidate.id}\nattempt=${candidate.run_attempt}\n${selected.map((job, index) => `sample${index + 1}_attempt=${job.run_attempt}\n`).join('')}`);
    break;
  }
  case 'candidate-verify': {
    const { verifyRetainedCandidateMetadata } = await import('./release-artifacts.mjs');
    const metadata = JSON.parse(await fs.readFile(env.RELEASE_CANDIDATE_METADATA, 'utf8'));
    const name = releaseAssetName('macos-arm64', identity.release);
    const assets = await describeDirectoryAssets(env.RELEASE_ASSET_DIRECTORY);
    if (assets.length !== 1 || assets[0].name !== name) throw new Error('Exact retained candidate installer required; rebuilding is forbidden');
    verifyRetainedCandidateMetadata(metadata, identity, assets[0].digest.slice(7));
    break;
  }
  case 'smoke-budget': {
    const { freezeReleaseSmokeBudget, readReleaseSmokeReceipt } = await import('./qa/release-startup-smoke-contract.mjs');
    const receipts = await Promise.all([1, 2, 3].map(sample => readReleaseSmokeReceipt(path.join(env.RELEASE_CANDIDATE_RECEIPTS, `candidate-startup-${sample}.json`))));
    const upgrade = JSON.parse(await fs.readFile(path.join(env.RELEASE_CANDIDATE_RECEIPTS, 'upgrade-rollback.json'), 'utf8'));
    const { assertReleaseUpgradeRollbackReceipt } = await import('./qa/release-startup-upgrade-rollback.mjs');
    assertReleaseUpgradeRollbackReceipt(upgrade, { sourceCommit: identity.revision, version: identity.release, dmgSha256: receipts[0].dmgSha256 });
    await write('smoke-limits.json', freezeReleaseSmokeBudget(receipts, { sourceCommit: identity.revision, version: identity.release }));
    const { sourceCommit, version, dmgSha256, manifestSha256, appSha256 } = receipts[0];
    await write('smoke-identity.json', { sourceCommit, version, dmgSha256, manifestSha256, appSha256 });
    break;
  }
  case 'release-noop': {
    const { githubReleaseClient, verifyPublishedFinalization } = await import('./release-publication.mjs');
    const client = githubReleaseClient(env);
    await client.frozenTag(identity.release, identity.revision);
    const release = await client.request(`/releases/${env.RELEASE_ID}`);
    const proof = await verifyPublishedFinalization(release, { source: identity.revision, version: identity.release, scope: env.RELEASE_SCOPE, releaseID: env.RELEASE_ID }, client);
    const { verifyReleaseAssets } = await import('./verify-release-assets.mjs');
    const failures = verifyReleaseAssets(await client.pages(`/releases/${env.RELEASE_ID}/assets`), { version: identity.release, scope: env.RELEASE_SCOPE, digests: new Map(Object.entries(proof.digests)) });
    if (failures.length) throw new Error(failures.join('\n'));
    break;
  }
  case 'release-prepublish':
  case 'release-finalize': {
    const { finalizeRelease, verifyReleasePrepublish } = await import('./release-publication.mjs');
    const verifyPrepublish = () => verifyReleasePrepublish({ receiptPath: env.RELEASE_SMOKE_RECEIPT, identityPath: env.RELEASE_SMOKE_IDENTITY,
      limitsPath: env.RELEASE_SMOKE_LIMITS, directory: env.RELEASE_ASSET_DIRECTORY,
      identity: { source: identity.revision, version: identity.release, scope: env.RELEASE_SCOPE,
        dmgSha256: env.RELEASE_SHA256_MACOS_ARM64, webSha256: env.RELEASE_SHA256_WEB },
      runID: env.GITHUB_RUN_ID, runAttempt: env.RELEASE_SMOKE_ATTEMPT });
    await verifyPrepublish();
    if (env.RELEASE_OPERATION === 'release-prepublish') break;
    const publicationIdentity = { source: identity.revision, version: identity.release, scope: env.RELEASE_SCOPE, releaseID: Number(env.RELEASE_ID) };
    const result = await finalizeRelease({ identity: publicationIdentity, directory: env.RELEASE_ASSET_DIRECTORY,
      deploymentVerified: env.RELEASE_DEPLOYMENT_VERIFIED === 'true', environment: env, beforePromote: verifyPrepublish,
      retainFinalization: result => write('finalization.json', { protocol: 'devryan.release-finalization/1', identity: publicationIdentity, ...result }) });
    if (result.status === 'published') await write('finalization.json', { protocol: 'devryan.release-finalization/1', identity: publicationIdentity, ...result, updaterDiscovery: 'verified' });
    break;
  }
  case 'asset-describe': {
    const name = releaseAssetName(env.RELEASE_ASSET_PLATFORM, identity.release);
    const directory = path.resolve(env.RELEASE_ASSET_DIRECTORY ?? '');
    if (!directory.startsWith(root + path.sep) || await fs.realpath(directory) !== directory) throw new Error('Owned release asset directory required');
    const assets = await describeDirectoryAssets(directory), asset = assets.find(asset => asset.name === name);
    if (!asset || asset.state !== 'uploaded' || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Packaged release asset missing or invalid');
    await fs.appendFile(env.GITHUB_OUTPUT, `sha256=${asset.digest.slice(7)}\n`);
    await write(`${env.RELEASE_ASSET_PLATFORM}-asset.json`, { protocol: 'devryan.release-asset/1',
      source: identity.revision, version: identity.release, platform: env.RELEASE_ASSET_PLATFORM,
      name: asset.name, size: asset.size, sha256: asset.digest.slice(7) });
    if (env.RELEASE_ASSET_PLATFORM === 'macos-arm64') await write('candidate.json', { protocol: 'devryan.release-candidate/1', sourceCommit: identity.revision, version: identity.release, dmgSha256: asset.digest.slice(7), lockfile: identity.lockfile });
    break;
  }
  case 'image-plan': {
    const plan = createBotRuntimeImageBuildPlan({ ...botIdentity, root });
    const build = plan.builds.find((entry) => entry.key === env.IMAGE_KEY);
    if (!build) throw new Error('Unknown image');
    const tags = [...(botInputsOnly ? [] : [`${build.repository}:${identity.release}`]), `${build.repository}:sha-${identity.revision.slice(0, 12)}`];
    await fs.appendFile(env.GITHUB_OUTPUT, `dockerfile=${BOT_RUNTIME_IMAGE_DEFINITIONS[build.key].dockerfile}\nrepository=${build.repository}\ntags=${tags.join(',')}\n`);
    break;
  }
  case 'image-resolve': {
    // An image whose inputs match a verified signed :in-<digest> image is reused; the rest are built.
    if (!['true', 'false', undefined].includes(env.REBUILD_BOT_IMAGES)) throw new Error('Invalid REBUILD_BOT_IMAGES');
    const resolution = await resolveBotRuntimeImages({ ...botIdentity, root, workflowRepository: env.GITHUB_REPOSITORY,
      keys: env.IMAGE_KEY ? [env.IMAGE_KEY] : undefined, rebuild: env.REBUILD_BOT_IMAGES === 'true' });
    for (const result of resolution.reused) {
      await write(`${result.key}.json`, result);
      console.log(`[bots] ${result.key}: reusing ${result.image.repository}@${result.image.indexDigest}`);
    }
    for (const key of resolution.build) console.log(`[bots] ${key}: building (${resolution.reasons[key]})`);
    if (env.RELEASE_DRY_RUN === 'true' && resolution.build.length) {
      throw new Error('Dry run cannot publish new Bot images. Qualification requires verified signed images for the changed inputs: ' + resolution.build.join(', '));
    }
    await fs.appendFile(env.GITHUB_OUTPUT, `build=${JSON.stringify(resolution.build)}\n`);
    await write('resolution.txt', { build: resolution.build });
    break;
  }
  case 'image-sign': {
    const result = await signBotRuntimeImage({ ...botIdentity, key: env.IMAGE_KEY, indexDigest: env.IMAGE_DIGEST, root });
    const { digest } = await readBotRuntimeImageInputs({ key: env.IMAGE_KEY, root });
    const tagged = await tagBotRuntimeImageInputs({ repository: result.image.repository, indexDigest: result.image.indexDigest, inputDigest: digest, environment: env });
    console.log(tagged ? `[bots] ${env.IMAGE_KEY}: tagged ${tagged}` : `[bots] ${env.IMAGE_KEY}: input tag skipped outside tag-triggered release.yml runs`);
    await write(`${env.IMAGE_KEY}.json`, result);
    break;
  }
  case 'image-assemble': {
    const entries = await fs.readdir(output);
    const results = await Promise.all(entries.filter((name) => name.endsWith('.json')).map(read));
    await write(`DevRyan-bot-runtime-images-${identity.release}.json`, await assembleBotRuntimeImages({ ...botIdentity, results, root }));
    break;
  }
  case 'web-pack': {
    const { packWebRelease } = await import('./pack-web-release.mjs');
    const { restoreRevertRuntimeExecutableModes, assertUniversalNativeReleaseAvailable, SUPPORTED_NATIVE_RUNTIME_TARGETS } = await import('./verify-revert-runtime-artifacts.mjs');
    assertUniversalNativeReleaseAvailable();
    await verifyWebArtifact(path.join(root, 'packages/web/dist'), await read('web.json'), identity);
    for (const target of SUPPORTED_NATIVE_RUNTIME_TARGETS) {
      const [platform, arch] = target.split('-');
      await restoreRevertRuntimeExecutableModes({ platform, arch });
    }
    await packWebRelease({ root, destination: path.join(root, 'packages/web') });
    break;
  }
  case 'web-describe':
    await write('web.json', await describeWebArtifact(path.join(output, 'web'), identity));
    break;
  case 'web-stage':
    await stageWebArtifact({ source: path.join(output, 'web'), metadata: await read('web.json'), identity,
      destination: path.join(root, env.RELEASE_WEB_TARGET === 'electron' ? 'packages/electron/resources/web-dist' : 'packages/web/dist') });
    break;
  case 'prepare-export': {
    const { verifyRevertRuntimeArtifacts, SUPPORTED_NATIVE_RUNTIME_TARGETS } = await import('./verify-revert-runtime-artifacts.mjs');
    const arch = env.ELECTRON_BUILDER_ARCH;
    if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid prepared architecture');
    await fs.mkdir(output, { recursive: true });
    const nativeTarget = `${process.platform}-${arch}`;
    if (!SUPPORTED_NATIVE_RUNTIME_TARGETS.includes(nativeTarget)) throw new Error(`Native prepared artifact verification unavailable for ${nativeTarget}`);
    await verifyRevertRuntimeArtifacts({ platform: process.platform, arch });
    const files = ['node_modules', 'packages/electron/dist-bundle', 'packages/electron/resources/native', 'packages/electron/resources/runtime-service', `packages/web/runtime/${nativeTarget}`];
    for (const entry of await fs.readdir(path.join(root, 'packages'))) {
      const relative = `packages/${entry}/node_modules`;
      if (await fs.lstat(path.join(root, relative)).then(() => true, () => false)) files.push(relative);
    }
    // Multithreaded zstd: single-threaded gzip of the dependency tree dominated this step.
    run(['--use-compress-program', 'zstd -T0 -3', '-cf', path.join(output, preparedArchive), ...files]);
    await write('prepared.json', { version: 1, kind: 'electron-prepared', ...identity, arch, archiveHash: hash(await fs.readFile(path.join(output, preparedArchive))) });
    break;
  }
  case 'prepare-import':
    verifyPreparedMetadata(await read('prepared.json'), identity, env.ELECTRON_BUILDER_ARCH,
      hash(await fs.readFile(path.join(output, preparedArchive))));
    run(['--use-compress-program', 'zstd -d -T0', '-xf', path.join(output, preparedArchive)]);
    break;
  default: throw new Error('Unknown release CI operation');
}
