import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { registerBotRoutes } from './routes.js';

// The workstation owner acts as its local identity, or as an imported Bot's
// verified source owner. Routes derive the Bot from the URL or the stored
// resource and hand the scoped principal to the domain services; multi-Bot
// reads keep the authenticated viewer and annotate each Bot with the identity
// the viewer acts as.

const OWNER_ID = 'a0000000-0000-4000-8000-00000000000a';
const SOURCE_OWNER_ID = 'a0000000-0000-4000-8000-00000000000b';
const MEMBER_ID = 'a0000000-0000-4000-8000-00000000000c';
const LOCAL_BOT = 'b0000000-0000-4000-8000-000000000001';
const IMPORTED_BOT = 'b0000000-0000-4000-8000-000000000002';
const IMPORTED_CHANNEL = 'c0000000-0000-4000-8000-000000000002';

const ownerPrincipal = Object.freeze({ id: OWNER_ID, scope: 'bot-owner', botOwner: true, role: 'admin' });
const memberPrincipal = Object.freeze({ id: MEMBER_ID, scope: 'managed', role: 'developer' });

const mappings = new Map([[IMPORTED_BOT, SOURCE_OWNER_ID]]);
const actsAsOwner = (principal) => principal?.scope === 'bot-owner' || principal?.scope === 'tunnel-bot';
const identity = Object.freeze({
  defaultPrincipal: (principal) => principal,
  scopePrincipal: (principal, botId) => (actsAsOwner(principal)
    ? { ...principal, id: mappings.get(botId) || OWNER_ID }
    : principal),
  needsBotLookup: (principal) => actsAsOwner(principal),
  resolveResourceBotId: vi.fn(async (kind, id) => (kind === 'channel' && id === IMPORTED_CHANNEL ? IMPORTED_BOT : null)),
  forEachIdentity: async (principal, operation) => {
    const ids = actsAsOwner(principal) ? [OWNER_ID, SOURCE_OWNER_ID] : [principal.id];
    const bots = [];
    for (const id of ids) bots.push(...(await operation({ ...principal, id })).bots);
    return { bots };
  },
  withViewerIds: (principal, value) => ({
    ...value,
    ...(value.bots ? { bots: value.bots.map((bot) => ({
      ...bot,
      viewerUserId: actsAsOwner(principal) ? (mappings.get(bot.id) || OWNER_ID) : principal.id,
    })) } : {}),
    ...(value.bot ? { bot: {
      ...value.bot,
      viewerUserId: actsAsOwner(principal) ? (mappings.get(value.bot.id) || OWNER_ID) : principal.id,
    } } : {}),
  }),
  mirror: async () => {},
});

const createApp = (principal) => {
  const seen = { detail: [], messages: [], catalog: [] };
  const management = {
    listCatalog: vi.fn(async (scoped) => {
      seen.catalog.push(scoped.id);
      return { bots: scoped.id === SOURCE_OWNER_ID ? [{ id: IMPORTED_BOT }] : [{ id: LOCAL_BOT }] };
    }),
    getDetail: vi.fn(async (scoped, botId) => {
      seen.detail.push(scoped.id);
      return { bot: { id: botId }, canManage: true, revisions: [], memberships: [], credentials: [] };
    }),
  };
  const channels = {
    listMessages: vi.fn(async ({ principal: scoped }) => {
      seen.messages.push(scoped.id);
      return { messages: [], nextCursor: null };
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = principal;
    next();
  });
  registerBotRoutes(app, {
    store: { available: true },
    management,
    channels,
    botHost: { owner: 'electron', getStatus: async () => ({ state: 'healthy' }) },
    encryption: { getKey: () => Buffer.alloc(32) },
    identity,
  });
  return { app, seen };
};

describe('Bot route identity scoping', () => {
  it('acts as the verified source owner only for an imported Bot', async () => {
    const { app, seen } = createApp(ownerPrincipal);

    const imported = await request(app).get(`/api/bots/${IMPORTED_BOT}`).expect(200);
    expect(seen.detail).toEqual([SOURCE_OWNER_ID]);
    expect(imported.body.bot.viewerUserId).toBe(SOURCE_OWNER_ID);

    const local = await request(app).get(`/api/bots/${LOCAL_BOT}`).expect(200);
    expect(seen.detail).toEqual([SOURCE_OWNER_ID, OWNER_ID]);
    expect(local.body.bot.viewerUserId).toBe(OWNER_ID);
  });

  it('derives the Bot from a stored channel before scoping', async () => {
    const { app, seen } = createApp(ownerPrincipal);
    await request(app).get(`/api/bot-channels/${IMPORTED_CHANNEL}/messages`).expect(200);
    expect(identity.resolveResourceBotId).toHaveBeenCalledWith('channel', IMPORTED_CHANNEL);
    expect(seen.messages).toEqual([SOURCE_OWNER_ID]);
  });

  it('merges multi-Bot reads across every identity the owner acts as', async () => {
    const { app, seen } = createApp(ownerPrincipal);
    const response = await request(app).get('/api/bots').expect(200);
    expect(seen.catalog).toEqual([OWNER_ID, SOURCE_OWNER_ID]);
    expect(response.body.bots).toEqual([
      { id: LOCAL_BOT, viewerUserId: OWNER_ID },
      { id: IMPORTED_BOT, viewerUserId: SOURCE_OWNER_ID },
    ]);
  });

  it('never re-scopes a managed member', async () => {
    const { app, seen } = createApp(memberPrincipal);
    const response = await request(app).get(`/api/bots/${IMPORTED_BOT}`).expect(200);
    expect(seen.detail).toEqual([MEMBER_ID]);
    expect(response.body.bot.viewerUserId).toBe(MEMBER_ID);
    identity.resolveResourceBotId.mockClear();
    await request(app).get(`/api/bot-channels/${IMPORTED_CHANNEL}/messages`).expect(200);
    expect(identity.resolveResourceBotId).not.toHaveBeenCalled();
    expect(seen.messages).toEqual([MEMBER_ID]);
  });
});
