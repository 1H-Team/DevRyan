import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { releaseListsUpdaterChannel, resolveUpdateDownloadFallback } from "../update-download-fallback.mjs";

const repositoryUrl = "https://github.com/1H-Team/DevRyan";
const dmgUrl = `${repositoryUrl}/releases/download/v2.0.2/DevRyan-2.0.2-arm64.dmg`;
const htmlUrl = `${repositoryUrl}/releases/tag/v2.0.2`;
const resolve = (payload, version = "2.0.2") => resolveUpdateDownloadFallback({ payload, version, repositoryUrl });
const asset = (name, url) => ({ name, browser_download_url: url });
const source = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
const caseBody = (name, next) => {
  const start = source.indexOf(`case '${name}':`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf(`case '${next}':`, start));
};

test("opens the single verified arm64 DMG from the release payload", () => {
  assert.deepEqual(resolve({
    html_url: htmlUrl,
    assets: [asset("DevRyan-2.0.2-arm64.zip", dmgUrl.replace(".dmg", ".zip")), asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)],
  }), { url: dmgUrl, kind: "installer" });
});

test("falls back to the exact tag release page when the DMG asset is unverifiable", () => {
  for (const assets of [
    [],
    [asset("DevRyan-2.0.2-arm64.dmg", "https://evil.example/DevRyan-2.0.2-arm64.dmg")],
    [asset("DevRyan-2.0.2-arm64.dmg", `${repositoryUrl}/releases/download/v2.0.1/DevRyan-2.0.2-arm64.dmg`)],
    [asset("DevRyan-2.0.2-arm64.dmg", dmgUrl), asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)],
    [asset("DevRyan-2.0.1-arm64.dmg", dmgUrl)],
  ]) {
    assert.deepEqual(resolve({ html_url: htmlUrl, assets }), { url: htmlUrl, kind: "release-page" });
  }
});

test("refuses any release page other than this version's tag page", () => {
  for (const html_url of [
    "https://github.com/someone/DevRyan/releases/tag/v2.0.2",
    "https://github.com/1H-Team/DevRyanEvil/releases/tag/v2.0.2",
    "http://github.com/1H-Team/DevRyan/releases/tag/v2.0.2",
    `${repositoryUrl}/releases/../../../evil`,
    `${repositoryUrl}/releases/tag/v2.0.2?redirect=https://evil.example`,
    `${repositoryUrl}/releases/tag/v2.0.2#x`,
    `${repositoryUrl}/releases/tag/v2.0.2/`,
    `${repositoryUrl}/releases/tag/v2.0.1`,
    `${repositoryUrl}/releases/tag/2.0.2`,
    `${repositoryUrl}/releases/latest`,
    `${repositoryUrl}/releases`,
    `${repositoryUrl}/issues`,
    undefined,
  ]) {
    assert.equal(resolve({ html_url, assets: [] }), null, String(html_url));
  }
  assert.equal(resolve(null), null);
});

test("builds no URL unless the version is a plain x.y.z release", () => {
  for (const version of ["", "../../evil", "2.0.2/../../evil", "2.0.2-beta.1", "v2.0.2", "2.0", "2.0.2\n", " 2.0.2", "2.0.2?x", undefined]) {
    const name = `DevRyan-${version}-arm64.dmg`;
    const payload = {
      html_url: `${repositoryUrl}/releases/tag/v${version}`,
      assets: [asset(name, `${repositoryUrl}/releases/download/v${version}/${name}`)],
    };
    assert.equal(resolve(payload, version), null, String(version));
  }
});

test("the updater channel is checked only when the release lists latest-mac.yml", () => {
  assert.equal(releaseListsUpdaterChannel({ assets: [asset("DevRyan-2.0.2-arm64.dmg", dmgUrl), asset("latest-mac.yml", "x")] }), true);
  for (const payload of [
    null,
    undefined,
    "latest-mac.yml",
    {},
    { assets: "latest-mac.yml" },
    { assets: [] },
    { assets: [asset("DevRyan-2.0.2-arm64.dmg", dmgUrl)] },
    { assets: [asset("latest-mac.yml.blockmap", "x"), asset("latest.yml", "x"), null] },
    { message: "Not Found" },
  ]) {
    assert.equal(releaseListsUpdaterChannel(payload), false, JSON.stringify(payload));
  }
});

test("main consults electron-updater only for releases that publish its channel file", () => {
  const body = caseBody("desktop_check_for_updates", "desktop_download_and_install_update");
  assert.match(body, /if \(releaseListsUpdaterChannel\(payload\)\) \{\s*try \{\s*updateResult = await autoUpdater\.checkForUpdates\(\);/);
  assert.equal(body.match(/autoUpdater\.checkForUpdates\(/g)?.length, 1);
});

test("main opens the fallback only when electron-updater metadata is absent and returns its kind", () => {
  const body = caseBody("desktop_download_and_install_update", "desktop_restart");
  assert.match(body, /if \(!state\.pendingUpdate\.electronUpdate\) \{[\s\S]*?resolveUpdateDownloadFallback\(\{[\s\S]*?repositoryUrl: GITHUB_REPOSITORY_URL[\s\S]*?await shell\.openExternal\(fallback\.url\);[\s\S]*?return \{ openedExternally: true, kind: fallback\.kind \};/);
  assert.doesNotMatch(body, /Electron updater metadata is not available/);
  assert.ok(body.indexOf("autoUpdater.downloadUpdate()") > body.indexOf("return { openedExternally: true, kind: fallback.kind };"));
});
