// Packaged macOS app content and size limits, enforced by check-packaged-app.mjs
// from electron-builder's afterPack hook and by `bun run app:check`.
export default {
  schemaVersion: 1,
  // Resources-relative paths. app.asar entries are checked as `app.asar/<path>`;
  // entries marked unpacked are checked where they live, under app.asar.unpacked.
  forbidden: [
    { id: 'source-map', pattern: /\.map$/ },
    { id: 'test-file', pattern: /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[^/]+|__tests__\/.*)$/ },
    // Electron's Node refuses type stripping under node_modules and Bun cannot read
    // inside app.asar; the runtime-host sources are compiled into revert-runtime.
    { id: 'typescript-source', pattern: /\.(?:ts|tsx|mts|cts)$/ },
    // Native modules load their compiled .node; sources and objects only build it.
    { id: 'native-build-leftover', pattern: /(?:\.(?:c|cc|cpp|h|hpp)|\/build\/Release\/obj\/.*)$/ },
    // Rust sources never ship: the ledger core runs as its built WebAssembly
    // module (harness-runtime/lib/native/ledger-core.wasm), its crate stays out.
    { id: 'rust-source', pattern: /(?:\.rs|(?:^|\/)(?:Cargo\.toml|Cargo\.lock|rust-toolchain(?:\.toml)?))$/ },
    // The ledger-core crate folder, or a Cargo build directory (a `target/` holding a
    // profile or a target triple) under a first-party package. A source folder that is
    // merely named `target` is not one.
    { id: 'rust-build-leftover', pattern: /\/node_modules\/@devryan\/(?:harness-runtime\/native\/ledger-core\/|[^/]+\/(?:.*\/)?target\/(?:release|debug|wasm32-[^/]+|[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_-]+)\/)/ },
    // npm's lifecycle runner (@opencode/util → @npmcli/arborist) depends on node-gyp,
    // but the app never builds addons and gyp's Python cannot read inside app.asar.
    { id: 'build-tool', pattern: /\/node_modules\/node-gyp\// },
    { id: 'linux-prebuild', pattern: /\/prebuilds\/linux-/ },
    // A function rule gets the app's arch. build.files keeps only the target's own
    // platform packages and prebuilds; Windows ones stay for the Windows preview.
    { id: 'foreign-native', pattern: ({ arch }) => new RegExp(
      `(?:/node_modules/(?:@[^/]+/)?(?:[^/]*-)?|/(?:prebuilds|bin)/)(?:darwin-${arch === 'arm64' ? 'x64' : 'arm64'}(?:-[^/]*)?|win32-[^/]+)/`) },
    // Only the listed shell files are packed; a platform `files` list makes
    // electron-builder pack the whole packages/electron directory instead.
    { id: 'shell-source-tree', pattern: /^app\.asar\/(?:resources|scripts|tests)\// },
    // main.mjs serves Resources/web-dist (DEVRYAN_DIST_DIR) only.
    { id: 'duplicate-web-dist', pattern: /^app\.asar(?:\.unpacked)?\/node_modules\/@devryan\/web\/dist\// },
    // The server runs executables from Resources/revert-runtime only; runtime/ holds
    // the platform builds and their reviewed build inputs.
    { id: 'duplicate-native-runtime', pattern: /^app\.asar(?:\.unpacked)?\/node_modules\/@devryan\/web\/runtime\// },
  ],
  // Apparent bytes of the local 2.1.10 arm64 build, before the content cleanup.
  // Frozen: a ceiling may never exceed it.
  baseline: {
    resourcesBytes: 1_128_986_428,
    asarBytes: 321_006_160,
    unpackedBytes: 225_272_180,
  },
  // Lower these when the app shrinks; never raise them. Measured 795,714,816 /
  // 157,426,094 / 55,580,490 on the 2.1.11 build without other targets' natives;
  // each carries under 5% headroom.
  ceiling: {
    resourcesBytes: 835_000_000,
    asarBytes: 160_000_000,
    unpackedBytes: 58_000_000,
  },
};
