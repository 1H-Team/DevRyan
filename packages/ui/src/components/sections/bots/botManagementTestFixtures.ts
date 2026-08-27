import type {
  BotActivationHealth,
  BotManagementDetail,
  BotPurgePreview,
  BotRevisionDetail,
} from '@/lib/botsApi';
import { createDefaultBotRevisionContract } from './botManagementPresentation';

export const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
export const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
export const USER_ID = 'a0000000-0000-4000-8000-000000000001';
export const OTHER_USER_ID = 'a0000000-0000-4000-8000-000000000002';
export const CREATED_AT = '2026-08-23T00:00:00.000Z';

export const draftRevision = (): BotRevisionDetail => ({
  id: REVISION_ID,
  botId: BOT_ID,
  revisionNumber: 2,
  compiledHash: 'a'.repeat(64),
  createdBy: USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  activatedAt: null,
  retiredAt: null,
  contract: createDefaultBotRevisionContract('Research Desk'),
});

export const managementDetail = (): BotManagementDetail => ({
  bot: {
    id: BOT_ID,
    name: 'Research Desk',
    title: 'Research Desk',
    summary: 'Research support for assigned members.',
    avatarUrl: null,
    avatarFallback: '🤖',
    lifecycle: 'active',
    tenancy: 'team',
    activeRevisionId: 'c0000000-0000-4000-8000-000000000000',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    retiredAt: null,
  },
  canManage: true,
  revisions: [draftRevision()],
  memberships: [{
    botId: BOT_ID,
    userId: USER_ID,
    role: 'manager',
    assignedBy: USER_ID,
    activatedAt: CREATED_AT,
    revokedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }],
  credentials: [],
});

export const activationHealth = (ready = true): BotActivationHealth => ({
  ready,
  revision: draftRevision(),
  gates: [
    { id: 'schema', label: 'Control-plane schema', status: 'pass', detail: 'Ready.' },
    { id: 'images', label: 'Docker image digests', status: 'pass', detail: 'Verified.' },
    { id: 'models', label: 'Model catalog and credential', status: 'pass', detail: 'Available.' },
    { id: 'egress', label: 'Reviewed egress hosts', status: 'pass', detail: 'Bound.' },
    { id: 'tools', label: 'Tool manifest', status: 'pass', detail: 'Pinned.' },
    { id: 'policy', label: 'Policy coverage', status: 'pass', detail: 'Fail closed.' },
    { id: 'library', label: 'Library and index', status: 'pass', detail: 'Ready.' },
    { id: 'skills', label: 'Assigned skills', status: 'pass', detail: 'Ready.' },
    { id: 'mcp', label: 'Assigned MCP servers', status: ready ? 'pass' : 'fail', detail: ready ? 'Ready.' : 'Missing.' },
  ],
});

export const purgePreview = (): BotPurgePreview => ({
  bot: managementDetail().bot,
  requiresTypedName: 'Research Desk',
  irreversible: true,
  resumable: true,
  policy: 'Manager required.',
  resources: [
    { id: 'channels', label: 'Channels and transcripts', count: 2, disposition: 'delete' },
    { id: 'shared_memory', label: 'Shared memory', count: 4, disposition: 'delete' },
    { id: 'private_memory', label: 'Private memory', count: 3, disposition: 'delete' },
    { id: 'capability_bindings', label: 'Skill and MCP bindings', count: 2, disposition: 'delete' },
    { id: 'objects', label: 'Encrypted objects', count: 8, disposition: 'delete' },
    { id: 'credentials', label: 'Credential metadata and vault entries', count: 1, disposition: 'delete' },
    { id: 'browser_profiles', label: 'Browser profiles', count: 1, disposition: 'delete-local' },
    { id: 'workspaces', label: 'Scoped workspaces', count: 1, disposition: 'delete-local' },
    { id: 'indexes', label: 'Local retrieval indexes', count: 1, disposition: 'delete-local' },
    { id: 'audit', label: 'Security audit', count: null, disposition: 'retain-by-policy' },
  ],
});
