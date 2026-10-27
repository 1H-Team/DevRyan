// Built web assets (the build job's output; CI portable lanes download it) do
// not ship the removed agents create affordance. Moved from the Electron suite so
// the macOS lanes need no web build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const distRoots = [
  new URL("../packages/web/dist/", import.meta.url),
  new URL("../packages/electron/resources/web-dist/", import.meta.url),
  new URL("../packages/electron/node_modules/@devryan/web/dist/", import.meta.url),
];

const readDistText = (rootUrl) => {
  if (!existsSync(rootUrl)) return "";

  const chunks = [];
  const visit = (url) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) {
        visit(entryUrl);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) {
        chunks.push(readFileSync(entryUrl, "utf8"));
      }
    }
  };

  visit(rootUrl);
  return chunks.join("\n");
};

test("built web assets do not include the removed agents create affordance", () => {
  for (const distRoot of distRoots) {
    const dist = readDistText(distRoot);
    assert.ok(dist.length > 0, `${distRoot.pathname} must contain built assets`);
    assert.doesNotMatch(dist, /settings\.agents\.sidebar\.empty\.description['"]:\s*['"]Use the \+ button above to create one/);
    assert.doesNotMatch(dist, /settings\.agents\.page\.empty\.description['"]:\s*['"]or create a new one/);
    assert.doesNotMatch(dist, /new-agent/);
  }
});
