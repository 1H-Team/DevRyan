import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const distRoots = [
  new URL("../../web/dist/", import.meta.url),
  new URL("../resources/web-dist/", import.meta.url),
  new URL("../node_modules/@devryan/web/dist/", import.meta.url),
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

test("agents sidebar does not expose the create-agent plus button", () => {
  const sidebar = readFileSync(
    new URL("../../ui/src/components/sections/agents/AgentsSidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(sidebar, /handleCreateNew/);
  assert.doesNotMatch(sidebar, /RiAddLine/);
});

test("agents empty state does not mention a removed create button", () => {
  const messages = readFileSync(
    new URL("../../ui/src/lib/i18n/messages/en.settings.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    messages,
    /'settings\.agents\.sidebar\.empty\.description': 'Use the \+ button above to create one'/,
  );
  assert.doesNotMatch(
    messages,
    /'settings\.agents\.page\.empty\.description': 'or create a new one'/,
  );
  assert.match(messages, /'settings\.agents\.sidebar\.empty\.description': 'Packaged and project agents will appear here'/);
  assert.match(messages, /'settings\.agents\.page\.empty\.description': 'Choose an existing packaged or project agent'/);
});

test("built web assets do not include the removed agents create affordance", () => {
  for (const distRoot of distRoots) {
    const dist = readDistText(distRoot);
    assert.ok(dist.length > 0, `${distRoot.pathname} must contain built assets`);
    assert.doesNotMatch(dist, /settings\.agents\.sidebar\.empty\.description['"]:\s*['"]Use the \+ button above to create one/);
    assert.doesNotMatch(dist, /settings\.agents\.page\.empty\.description['"]:\s*['"]or create a new one/);
    assert.doesNotMatch(dist, /new-agent/);
  }
});
