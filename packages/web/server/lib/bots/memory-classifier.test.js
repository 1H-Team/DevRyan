import { describe, expect, it } from 'vitest';

import {
  BOT_MEMORY_EXTRACTION_SCHEMA,
  buildBotMemoryExtractionPrompt,
  classifyBotMemoryCandidates,
} from './memory-classifier.js';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const CHANNEL_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

const candidate = (overrides = {}) => ({
  statement: 'Production deployments use the reviewed European region.',
  logicalKey: 'deployment.region',
  scope: 'shared',
  subjectUserId: null,
  sensitivity: 'normal',
  confidence: 0.94,
  transcriptQuote: false,
  provenance: { channelId: CHANNEL_ID, runId: RUN_ID, messageIds: [MESSAGE_ID] },
  ...overrides,
});

const classify = (candidates, transcript = 'A short completed private conversation.') => (
  classifyBotMemoryCandidates({
    output: { candidates },
    botId: BOT_ID,
    channelId: CHANNEL_ID,
    runId: RUN_ID,
    ownerUserId: OWNER_ID,
    messageIds: [MESSAGE_ID],
    transcript,
  })
);

describe('Bot memory classifier', () => {
  it('publishes a strict no-extra-fields extraction schema and prompt', () => {
    expect(BOT_MEMORY_EXTRACTION_SCHEMA.additionalProperties).toBe(false);
    expect(BOT_MEMORY_EXTRACTION_SCHEMA.properties.candidates.items.additionalProperties).toBe(false);
    const prompt = buildBotMemoryExtractionPrompt({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      ownerUserId: OWNER_ID,
      userText: 'Which region?',
      assistantText: 'The reviewed European region.',
    });
    expect(prompt).toContain('Do not call tools');
    expect(prompt).toContain('shared with every Bot member');
    expect(prompt).toContain('thread_only');
  });

  it('accepts an automatic reusable shared fact', () => {
    const result = classify([candidate()]);
    expect(result.accepted).toEqual([
      expect.objectContaining({ scope: 'shared', subjectUserId: null, logicalKey: 'deployment.region' }),
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('keeps confidential and user-specific facts in the one shared memory but flags them', () => {
    const result = classify([candidate({
      statement: 'The user prefers invoices sent to their private email.',
      logicalKey: 'user.invoice.delivery',
      sensitivity: 'confidential',
    })]);
    expect(result.accepted[0]).toMatchObject({
      scope: 'shared',
      subjectUserId: null,
      sensitivity: 'confidential',
    });
  });

  it('escalates sensitivity for a personal fact a model marked normal', () => {
    const result = classify([candidate({
      statement: 'The user prefers invoices sent to their personal email address.',
      logicalKey: 'user.invoice.delivery',
      sensitivity: 'normal',
      scope: 'user_private',
      subjectUserId: OWNER_ID,
    })]);
    expect(result.accepted[0]).toMatchObject({
      scope: 'shared',
      subjectUserId: null,
      sensitivity: 'confidential',
    });
  });

  it('rejects a model attempt to write another user private layer', () => {
    const result = classify([candidate({ scope: 'user_private', subjectUserId: OTHER_ID })]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, code: 'cross_user_scope_rejected' }]);
  });

  it('rejects raw transcript quotes, secrets, and invalid provenance', () => {
    const quote = 'This is an intentionally long verbatim transcript passage that must never become a reusable shared memory record for any member.';
    const result = classify([
      candidate({ statement: quote }),
      candidate({ statement: 'The password = extremely-secret-value belongs to production.' }),
      candidate({ provenance: { channelId: CHANNEL_ID, runId: RUN_ID, messageIds: [OTHER_ID] } }),
    ], `Prefix ${quote} suffix`);
    expect(result.rejected.map((entry) => entry.code)).toEqual([
      'transcript_quote_rejected',
      'secret_rejected',
      'provenance_invalid',
    ]);
  });

  it('rejects unsupported output scope through the strict boundary', () => {
    const result = classify([candidate({ scope: 'organization' })]);
    expect(result.rejected).toEqual([{ index: 0, code: 'schema_invalid' }]);
  });
});

describe('Bot memory classifier leniency', () => {
  it('fills optional fields for a sparse candidate and defaults provenance to the run', () => {
    const result = classify([{
      statement: 'Production deployments use the reviewed European region.',
      logicalKey: 'deployment.region',
    }]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      scope: 'shared',
      subjectUserId: null,
      sensitivity: 'normal',
      confidence: 0.6,
      provenance: { channelId: CHANNEL_ID, runId: RUN_ID, messageIds: [MESSAGE_ID] },
    });
  });

  it('normalizes loosely written logical keys and accepts the snake-case alias', () => {
    const result = classify([
      candidate({ logicalKey: '  User.Timezone ' }),
      { ...candidate(), logicalKey: undefined, logical_key: 'Deployment Region' },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((entry) => entry.logicalKey)).toEqual([
      'user.timezone',
      'deployment-region',
    ]);
  });

  it('parses numeric-string confidence, clamps out-of-range values, and rejects nonsense', () => {
    const result = classify([
      candidate({ confidence: '0.8' }),
      candidate({ logicalKey: 'deployment.window', confidence: 1.5 }),
      candidate({ logicalKey: 'deployment.owner', confidence: 'high' }),
    ]);
    expect(result.accepted.map((entry) => entry.confidence)).toEqual([0.8, 1]);
    expect(result.rejected).toEqual([{ index: 2, code: 'schema_invalid' }]);
  });

  it('reports why a statement or key was unusable', () => {
    const result = classify([
      candidate({ statement: '   ' }),
      candidate({ logicalKey: '!!!' }),
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.code)).toEqual([
      'schema_statement_invalid',
      'schema_key_invalid',
    ]);
  });

  it('asks the model for people-fact key prefixes so pinning works', () => {
    const prompt = buildBotMemoryExtractionPrompt({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      ownerUserId: OWNER_ID,
      userText: 'Call me Zed.',
      assistantText: 'Will do, Zed.',
    });
    expect(prompt).toContain('user.name');
    expect(prompt).toContain('preference.');
    expect(prompt).toContain('identity.');
  });
});
