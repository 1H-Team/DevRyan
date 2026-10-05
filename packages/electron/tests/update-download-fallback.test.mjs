import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveUpdateDownloadFallbackUrl } from "../update-download-fallback.mjs";

const repositoryUrl = "https://github.com/1H-Team/DevRyan";
const dmgUrl = `${repositoryUrl}/releases/download/v2.0.2/DevRyan-2.0.2-arm64.dmg`;
const htmlUrl = `${repositoryUrl}/releases/tag/v2.0.2`;
const resolve = (payload, version = "2.0.2") => resolveUpdateDownloadFallbackUrl({ payload, version, repositoryUrl });
const asset = (name, url) => ({ name, browser_download_url: url });

test("opens the single verified arm64 DMG from the release payload", () => {
  assert.equal(resolve({
    html_url: htmlUrl,
    assets: [asset("DevRyan-2.0.2-arm64.zip", dmgUrl.replace(".dmg", ".zip")), asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)],
  }), dmgUrl);
});

test("falls back to the repository release page when the DMG asset is unverifiable", () => {
  for (const assets of [
    [],
    [asset("DevRyan-2.0.2-arm64.dmg", "https://evil.example/DevRyan-2.0.2-arm64.dmg")],
    [asset("DevRyan-2.0.2-arm64.dmg", `${repositoryUrl}/releases/download/v2.0.1/DevRyan-2.0.2-arm64.dmg`)],
    [asset("DevRyan-2.0.2-arm64.dmg", dmgUrl), asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)],
    [asset("DevRyan-2.0.1-arm64.dmg", dmgUrl)],
  ]) {
    assert.equal(resolve({ html_url: htmlUrl, assets }), htmlUrl);
  }
});

test("refuses release pages outside this repository's releases", () => {
  for (const html_url of [
    "https://github.com/someone/DevRyan/releases/tag/v2.0.2",
    "https://github.com/1H-Team/DevRyanEvil/releases/tag/v2.0.2",
    "http://github.com/1H-Team/DevRyan/releases/tag/v2.0.2",
    `${repositoryUrl}/releases/../../../evil`,
    `${repositoryUrl}/releases/tag/v2.0.2?redirect=https://evil.example`,
    `${repositoryUrl}/issues`,
    undefined,
  ]) {
    assert.equal(resolve({ html_url, assets: [] }), null, String(html_url));
  }
  assert.equal(resolve(null), null);
  assert.equal(resolve({ html_url: htmlUrl, assets: [asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)] }, ""), null);
});

test("main opens the fallback only when electron-updater metadata is absent", () => {
  const source = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("case 'desktop_download_and_install_update':");
  const body = source.slice(start, source.indexOf("case 'desktop_restart':", start));
  assert.match(body, /if \(!state\.pendingUpdate\.electronUpdate\) \{[\s\S]*?repositoryUrl: GITHUB_REPOSITORY_URL[\s\S]*?await shell\.openExternal\(url\);[\s\S]*?return \{ openedExternally: true \};/);
  assert.doesNotMatch(body, /Electron updater metadata is not available/);
  assert.ok(body.indexOf("autoUpdater.downloadUpdate()") > body.indexOf("return { openedExternally: true };"));
});
