import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

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
