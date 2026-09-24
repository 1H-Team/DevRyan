// Verified release profiles. Evidence: docs/audits/2026-09-24-companion-requalification/ (current)
// and docs/audits/2026-09-20-context-deduplication/live-acceptance.json (stale predecessor).
// Changing plugin bytes, native executable, model, effort or transport requires qualification.
const profiles = [
  {
    "id": "devryan-companion-2.0.0-openai-sol-medium",
    "runtimeVersion": "1.18.31",
    "runtimeHash": "dc0954bd4d85e298992971ce3822c40b0af80b180d4fc5248f973d11ce76681f",
    "providerID": "openai",
    "modelID": "gpt-5.6-sol",
    "variant": "medium",
    "providerHash": "4792784fe46997ae50e9f71f0183179101791d35b522e21c618ae7bc1ec8d4d8",
    "plugins": [
      {
        "name": "index.js",
        "contentHash": "fab88b553785d6b7ae53238c060f0ea3f003dfda2c88667284b5a35ca623488d"
      },
      {
        "name": "plugin-entry.js",
        "contentHash": "778514df215d2860e6b074f9569bbd5afb622f097a15edcec0e6a5246309e205"
      },
      {
        "name": "index.js",
        "contentHash": "b3a32d1f03047f68e39874725bc9ed40fc42b59a773acdb815e8c9b7b4025aad"
      },
      {
        "name": "index.js",
        "contentHash": "2a94eedd2be1e77fc2a3e50961d79a9a2695eeeb5866732a13f46948553156b4"
      },
      {
        "name": "devryan-oh-my-opencode-slim.mjs",
        "contentHash": "7dde3de974347911027abc4d1665cf3007b78013410dd6a94688eee57637023b"
      },
      {
        "name": "devryan-superpowers.mjs",
        "contentHash": "54e0fc722391a1a2399581c977654627d57ac3aadee6bfb529ee88632221de23"
      },
      {
        "name": "devryan-skill-context.mjs",
        "contentHash": "99929e135c01749b7e8303b35179240f386e53816b9a35ab57e0d3ad372d551c"
      },
      {
        "name": "devryan-document-reader.mjs",
        "contentHash": "bef4052f50aa08644dd0c2191ee07d6811c9e0cff57f0090afe9613895cf5de4"
      },
      {
        "name": "devryan-browser.mjs",
        "contentHash": "f8098613e62d7ea31a680bc63e60b417e688f908a20aa4043fe410a2a5224943"
      },
      {
        "name": "devryan-builder-todo-continuation.mjs",
        "contentHash": "4f6511bd4206f2e747c3205107cdfbb5b2217a81d988ddc74500d4b22e754748"
      },
      {
        "name": "devryan-file-write-metadata.mjs",
        "contentHash": "83e76ea73e6c42257ddf4c2aa48f2b5a512e64b9cc7afa7772fb14ddbe816988"
      },
      {
        "name": "devryan-harness-context.mjs",
        "contentHash": "c97893cda4f61c7fdc1f0cad44dd2484c87215fad2d06b38f1855e263d41f9c7"
      },
      {
        "name": "devryan-managed-orchestration.mjs",
        "contentHash": "61849c3b053d479f91ce1b6ee7ae0c8d74678b42251663740faf2584ea6f10e8"
      },
      {
        "name": "devryan-openai-oauth.mjs",
        "contentHash": "d57482f361d6f70c35c1e359573fe4810a5a3778c8f1e2e7c67c9bfe954eb739"
      },
      {
        "name": "devryan-primary-recovery.mjs",
        "contentHash": "68555821e2c5cd52155173e3e1ffb3ca796f05e7779d11efb6a03f6168c9b4d5"
      },
      {
        "name": "devryan-session-changes.mjs",
        "contentHash": "170dd8989e594ead72d4f4b13b7255bf8de3acf292e557d081f18c1e5156c4a8"
      },
      {
        "name": "devryan-tool-input-guard.mjs",
        "contentHash": "e485d28adb37b4052df0c3ea3c1556cbaab712690f15da86204ba8e1a1043ebb"
      },
      {
        "name": "github-copilot-models.mjs",
        "contentHash": "61270a274af4d13024a6014795ab57dc579b30fba508e706b692cbdf8f4750c4"
      },
      {
        "name": "openai-gpt-5-6-models.mjs",
        "contentHash": "0b918d8333abdf55e6feb42ddd03b538612d8e4af7ca672b33ca0940b5991dc9"
      },
      {
        "name": "openai-tool-schema-sanitizer.mjs",
        "contentHash": "e824ed4220bc0a26fda7eda34d52248a5320ef48fb866a60621c6db6b63d17ac"
      },
      {
        "name": "council-session.js",
        "contentHash": "e1ee08ab6945db37f7a4870d9a61406eddf360d43f4b308454e0791226f31bf6"
      }
    ],
    "providerScope": "selected-route",
    "transport": "openai-chatgpt-managed-responses-v1",
    "defaultEnabled": true,
    "evidence": {
      "reportHash": "35462b59b718e7796efb6113820a702085bfc794b210c945be56c0682b8fa197",
      "correctness": true,
      "finalRequests": true,
      "compactionLifecycle": true,
      "nonIncreasingRequests": true,
      "livePairs": 10,
      "skillPairs": 5,
      "managedPairs": 5,
      "incompleteTrials": 0,
      "criticalFailures": 0,
      "repeatedMutations": 0,
      "repeatCallDelta": 0
    }
  },
  {
    "id": "opencode-1.18.31-openai-sol-medium",
    "runtimeVersion": "1.18.31",
    "runtimeHash": "16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198",
    "providerID": "openai",
    "modelID": "gpt-5.6-sol",
    "variant": "medium",
    "providerHash": "4792784fe46997ae50e9f71f0183179101791d35b522e21c618ae7bc1ec8d4d8",
    "plugins": [
      {
        "name": "index.js",
        "contentHash": "fab88b553785d6b7ae53238c060f0ea3f003dfda2c88667284b5a35ca623488d"
      },
      {
        "name": "plugin-entry.js",
        "contentHash": "778514df215d2860e6b074f9569bbd5afb622f097a15edcec0e6a5246309e205"
      },
      {
        "name": "index.js",
        "contentHash": "b3a32d1f03047f68e39874725bc9ed40fc42b59a773acdb815e8c9b7b4025aad"
      },
      {
        "name": "index.js",
        "contentHash": "2a94eedd2be1e77fc2a3e50961d79a9a2695eeeb5866732a13f46948553156b4"
      },
      {
        "name": "plugin.js",
        "contentHash": "9d78619057e26ea3acb7c1b9a4df6c402c91be00432cd12817c8dde45d7e47dd"
      },
      {
        "name": "devryan-oh-my-opencode-slim.mjs",
        "contentHash": "8e7029b95b7fce832bc867d79d6acad0ff374cae6a4adcb968ab4a5a873e4e01"
      },
      {
        "name": "devryan-superpowers.mjs",
        "contentHash": "54e0fc722391a1a2399581c977654627d57ac3aadee6bfb529ee88632221de23"
      },
      {
        "name": "devryan-skill-context.mjs",
        "contentHash": "f3ea463d78c513fd1b1b41612b28f59c88a5320c7418a0b76652f140811447ef"
      },
      {
        "name": "devryan-document-reader.mjs",
        "contentHash": "0df5deda30bd3fd91070c91eaceaedbaac8ee21604d5fd01194a6ab7347be729"
      },
      {
        "name": "devryan-browser.mjs",
        "contentHash": "6cfd73228900e0499e026edeb050900ca8dfbac36b4c7271d055f4141eaae652"
      },
      {
        "name": "devryan-builder-todo-continuation.mjs",
        "contentHash": "4f6511bd4206f2e747c3205107cdfbb5b2217a81d988ddc74500d4b22e754748"
      },
      {
        "name": "devryan-file-write-metadata.mjs",
        "contentHash": "83e76ea73e6c42257ddf4c2aa48f2b5a512e64b9cc7afa7772fb14ddbe816988"
      },
      {
        "name": "devryan-harness-context.mjs",
        "contentHash": "e1a8eb08591ae80744270b0ba35ba4e51df01b093ce5c2e25c2289fec7925f6c"
      },
      {
        "name": "devryan-managed-orchestration.mjs",
        "contentHash": "d246b22cda13b6ddd056d2450c846f621919aa9805153553f5447d461e3bb1fa"
      },
      {
        "name": "devryan-openai-oauth.mjs",
        "contentHash": "d57482f361d6f70c35c1e359573fe4810a5a3778c8f1e2e7c67c9bfe954eb739"
      },
      {
        "name": "devryan-primary-recovery.mjs",
        "contentHash": "191ae517c6fd185b07b1e4d2aa428ab0270d9648c8465c84d5d7adfb8c243909"
      },
      {
        "name": "devryan-session-changes.mjs",
        "contentHash": "170dd8989e594ead72d4f4b13b7255bf8de3acf292e557d081f18c1e5156c4a8"
      },
      {
        "name": "devryan-tool-input-guard.mjs",
        "contentHash": "499ac58893f57ebd8f0fcb405dd8586be42c80291cef520f8f7a73300d151c67"
      },
      {
        "name": "github-copilot-models.mjs",
        "contentHash": "61270a274af4d13024a6014795ab57dc579b30fba508e706b692cbdf8f4750c4"
      },
      {
        "name": "openai-gpt-5-6-models.mjs",
        "contentHash": "0b918d8333abdf55e6feb42ddd03b538612d8e4af7ca672b33ca0940b5991dc9"
      },
      {
        "name": "openai-tool-schema-sanitizer.mjs",
        "contentHash": "e824ed4220bc0a26fda7eda34d52248a5320ef48fb866a60621c6db6b63d17ac"
      },
      {
        "name": "council-session.js",
        "contentHash": "e1ee08ab6945db37f7a4870d9a61406eddf360d43f4b308454e0791226f31bf6"
      }
    ],
    "providerScope": "selected-route",
    "transport": "openai-chatgpt-managed-responses-v1",
    "defaultEnabled": true,
    // A profile whose qualified bytes no longer ship stays on record with its
    // evidence but can never qualify. Requalify on the shipped runtime.
    "stale": {
      "reason": "devryan-browser.mjs gained confined-worker browser support and devryan-harness-context.mjs / devryan-managed-orchestration.mjs re-anchor and continue compaction (2026-09-23); the profile also pins the unpatched 1.18.31 executable, not the shipped companion runtime; devryan-document-reader.mjs, devryan-primary-recovery.mjs and devryan-tool-input-guard.mjs cache immutable per-part or per-call results instead of recomputing them on every request (2026-09-23); devryan-skill-context.mjs and devryan-tool-input-guard.mjs dropped their Context Mode tool hooks (2026-09-24); devryan-oh-my-opencode-slim.mjs drops Slim's per-turn phase reminder (2026-09-24)",
      "plugins": ["devryan-browser.mjs", "devryan-document-reader.mjs", "devryan-harness-context.mjs", "devryan-managed-orchestration.mjs", "devryan-oh-my-opencode-slim.mjs", "devryan-primary-recovery.mjs", "devryan-skill-context.mjs", "devryan-tool-input-guard.mjs"]
    },
    "evidence": {
      "reportHash": "45b1c7737f5b900c7246c2e768fd8ad676ae7fe78d8d11772e7c0368b31721b7",
      "correctness": true,
      "finalRequests": true,
      "compactionLifecycle": true,
      "nonIncreasingRequests": true,
      "livePairs": 10,
      "skillPairs": 5,
      "managedPairs": 5,
      "incompleteTrials": 0,
      "criticalFailures": 0,
      "repeatedMutations": 0,
      "repeatCallDelta": 0
    }
  }
];
for (const profile of profiles) { for (const plugin of profile.plugins) Object.freeze(plugin); Object.freeze(profile.plugins); Object.freeze(profile.evidence); if (profile.stale) { Object.freeze(profile.stale.plugins); Object.freeze(profile.stale); } Object.freeze(profile); }
export default Object.freeze(profiles);
