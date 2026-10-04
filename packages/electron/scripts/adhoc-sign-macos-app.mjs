import { rename } from 'node:fs/promises'
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { restoreRevertRuntimeExecutableModes, refreshSignedRevertDigests } from "../../../scripts/verify-revert-runtime-artifacts.mjs"
import { verifyPackagedNativeArtifacts } from "./packaged-native-modules.mjs"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) {
    console.warn(`[adhoc-sign] ${command} failed to start: ${result.error.message}`)
  }
}

function removeDsStoreFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      removeDsStoreFiles(path)
      continue
    }

    if (entry.name === ".DS_Store") {
      rmSync(path, { force: true })
    }
  }
}

export default async function adhocSignMacosApp(context) {
  if (context.electronPlatformName !== "darwin") {
    return
  }

  if (process.platform !== "darwin") {
    throw new Error("macOS app signing must run on macOS")
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  const runtimeServiceBridgePath = join(
    appPath,
    "Contents",
    "Resources",
    "native",
    "DevRyanRuntimeServiceControl.node",
  )

  console.log(`[adhoc-sign] Verifying packaged native artifacts in ${appPath}`)
  verifyPackagedNativeArtifacts(appPath, context.arch)

  const revert = await restoreRevertRuntimeExecutableModes({ directory: join(appPath, "Contents", "Resources", "revert-runtime"),
    arch: typeof context.arch === "string" ? context.arch : context.arch === 3 ? "arm64" : "x64" })

  console.log(`[adhoc-sign] Cleaning ${appPath}`)
  removeDsStoreFiles(appPath)

  console.log(`[adhoc-sign] Ad-hoc signing ${runtimeServiceBridgePath}`)
  run("codesign", ["--force", "--sign", "-", runtimeServiceBridgePath])

  // The reviewed vendor executables have immutable hashes and signatures.
  // Sign the Electron tree while this already verified payload is outside it,
  // then restore it before sealing the app resources.
  const runtimeRoot = join(appPath, "Contents", "Resources", "revert-runtime")
  const signingHold = join(context.appOutDir, `.${appName}-native-signing-${process.pid}`)
  await rename(runtimeRoot, signingHold)
  try {
    console.log(`[adhoc-sign] Ad-hoc signing ${appPath}`)
    run("codesign", ["--force", "--deep", "--sign", "-", appPath])
  } finally {
    await rename(signingHold, runtimeRoot)
  }
  const preserved = new Set([revert.native.reviewedAst?.path,
    ...Object.values(revert.native.reviewedClaude ?? {}).map(asset => asset.path)])
  for (const file of revert.manifest.files) {
    const target = join(revert.location, file.path)
    if ((file.mode & 0o111) && !preserved.has(target)) run("codesign", ["--force", "--sign", "-", target])
  }

  await refreshSignedRevertDigests(revert)
  // Updating signed executable digests changes resources; reseal the app only.
  run("codesign", ["--force", "--sign", "-", appPath])

  console.log(`[adhoc-sign] Verifying ${appPath}`)
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])

  console.log(`[adhoc-sign] Running optional Gatekeeper assessment for ${appPath}`)
  runOptional("spctl", ["--assess", "--type", "execute", "--verbose", appPath])
}
