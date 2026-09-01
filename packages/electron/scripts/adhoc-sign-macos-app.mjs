import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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

  console.log(`[adhoc-sign] Cleaning ${appPath}`)
  removeDsStoreFiles(appPath)

  console.log(`[adhoc-sign] Ad-hoc signing ${runtimeServiceBridgePath}`)
  run("codesign", ["--force", "--sign", "-", runtimeServiceBridgePath])

  console.log(`[adhoc-sign] Ad-hoc signing ${appPath}`)
  run("codesign", ["--force", "--deep", "--sign", "-", appPath])

  console.log(`[adhoc-sign] Verifying ${appPath}`)
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])

  console.log(`[adhoc-sign] Running optional Gatekeeper assessment for ${appPath}`)
  runOptional("spctl", ["--assess", "--type", "execute", "--verbose", appPath])
}
