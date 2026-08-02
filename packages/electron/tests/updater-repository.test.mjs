import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("Electron update checks and publish metadata target the DevRyan repository", () => {
  assert.match(mainSource, /const GITHUB_REPOSITORY_OWNER = 'zoubenr';/);
  assert.match(mainSource, /const GITHUB_REPOSITORY_NAME = 'DevRyan';/);
  assert.match(
    mainSource,
    /https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY_OWNER\}\/\$\{GITHUB_REPOSITORY_NAME\}/,
  );
  assert.match(mainSource, /const UPDATE_METADATA_URL = `\$\{GITHUB_REPOSITORY_API_URL\}\/releases\/latest`;/);
  assert.doesNotMatch(mainSource, /github\.com\/btriapitsyn\/openchamber/);
  assert.deepEqual(packageJson.build?.publish, {
    provider: "github",
    owner: "zoubenr",
    repo: "DevRyan",
  });
});
