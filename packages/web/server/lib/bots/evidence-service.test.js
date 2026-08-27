import { describe, expect, it, vi } from 'vitest';

import {
  createBotEvidenceService,
  sanitizeBotEvidencePng,
} from './evidence-service.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'd0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'e0000000-0000-4000-8000-000000000001';
const OBJECT_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Bot selective action evidence', () => {
  it('crops and redacts a bounded PNG target without retaining the source frame', () => {
    const sanitized = sanitizeBotEvidencePng({
      bytes: PNG_1X1,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      redactions: [{ x: 0, y: 0, width: 1, height: 1 }],
    });

    expect(sanitized).toMatchObject({ width: 1, height: 1, redactedPixelCount: 1 });
    expect(sanitized.bytes.equals(PNG_1X1)).toBe(false);
    expect(() => sanitizeBotEvidencePng({
      bytes: PNG_1X1,
      bounds: { x: 0, y: 0, width: 2, height: 1 },
      redactions: [],
    })).toThrow(/outside/i);
  });

  it('retains only policy-selected before/after captures with an expiry', async () => {
    const uploaded = [];
    const browserService = { capturePng: vi.fn(async () => PNG_1X1) };
    const blobStore = {
      uploadPrivate: vi.fn(async (input) => {
        uploaded.push(input);
        return {
          id: OBJECT_ID,
          bot_id: BOT_ID,
          content_type: 'image/png',
          ciphertext_size: input.bytes.byteLength,
          provenance: input.provenance,
          expires_at: input.expiresAt,
          created_at: '2026-08-23T12:00:00.000Z',
        };
      }),
      downloadAuthorized: vi.fn(),
    };
    const authorization = { requireManager: vi.fn() };
    const service = createBotEvidenceService({
      store: { repositories: { bot_action_attempts: { get: vi.fn() } } },
      blobStore,
      authorization,
      browserService,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    });
    const input = {
      principal: { id: USER_ID },
      actionAttemptId: ACTION_ID,
      run: { id: RUN_ID },
      bot: { id: BOT_ID },
      channel: { id: CHANNEL_ID, owner_user_id: USER_ID },
      target: {
        evidence: {
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          redactions: [{ x: 0, y: 0, width: 1, height: 1 }],
        },
      },
    };

    await expect(service.capture({ ...input, retain: false, phase: 'before' })).resolves.toBeNull();
    expect(browserService.capturePng).not.toHaveBeenCalled();
    await expect(service.capture({ ...input, retain: true, phase: 'before' })).resolves.toMatchObject({
      id: OBJECT_ID,
      actionAttemptId: ACTION_ID,
      phase: 'before',
      expiresAt: '2026-08-24T12:00:00.000Z',
    });
    expect(uploaded[0].provenance.actionEvidence).toMatchObject({
      actionAttemptId: ACTION_ID,
      redactedPixelCount: 1,
    });
    expect(uploaded[0].bytes.equals(PNG_1X1)).toBe(false);
  });

  it('requires Manager access and an exact action/object evidence binding', async () => {
    const row = {
      id: OBJECT_ID,
      bot_id: BOT_ID,
      content_type: 'image/png',
      ciphertext_size: 80,
      provenance: { actionEvidence: { actionAttemptId: ACTION_ID, phase: 'after' } },
      expires_at: '2026-08-24T12:00:00.000Z',
      created_at: '2026-08-23T12:00:00.000Z',
    };
    const authorization = { requireManager: vi.fn(async () => ({ membership: { role: 'manager' } })) };
    const blobStore = {
      uploadPrivate: vi.fn(),
      downloadAuthorized: vi.fn(async () => ({ object: row, bytes: PNG_1X1 })),
    };
    const service = createBotEvidenceService({
      store: {
        repositories: {
          bot_action_attempts: { get: vi.fn(async () => ({ id: ACTION_ID, bot_id: BOT_ID })) },
        },
      },
      blobStore,
      authorization,
      browserService: { capturePng: vi.fn() },
    });
    const principal = { id: USER_ID };

    await expect(service.download({
      principal,
      botId: BOT_ID,
      actionAttemptId: ACTION_ID,
      objectId: OBJECT_ID,
    })).resolves.toMatchObject({ bytes: PNG_1X1 });
    expect(authorization.requireManager).toHaveBeenCalledWith(principal, BOT_ID);

    row.provenance.actionEvidence.actionAttemptId = RUN_ID;
    await expect(service.download({
      principal,
      botId: BOT_ID,
      actionAttemptId: ACTION_ID,
      objectId: OBJECT_ID,
    })).rejects.toMatchObject({ code: 'bot_evidence_not_found' });
  });
});
