import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import request from '../../test-supertest.js';
import { registerGlobalAgentsMdRoutes } from './global-agents-md-routes.js';

const createApp = (runtime) => {
  const app = express();
  app.use(express.json());
  registerGlobalAgentsMdRoutes(app, { runtime });
  return app;
};

describe('global AGENTS.md routes', () => {
  it('returns the runtime read contract', async () => {
    const read = vi.fn(async () => ({ content: '', exists: false, editable: true }));
    const app = createApp({ read, save: vi.fn() });

    await request(app)
      .get('/api/behavior/agents-md')
      .expect(200)
      .expect({ content: '', exists: false, editable: true });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('returns the canonical saved content and runtime application state', async () => {
    const save = vi.fn(async () => ({
      success: true,
      content: '# Rule\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
      warning: 'restart failed',
    }));
    const app = createApp({ read: vi.fn(), save });

    await request(app)
      .put('/api/behavior/agents-md')
      .send({ content: '# Rule' })
      .expect(200)
      .expect({
        success: true,
        content: '# Rule\n',
        exists: true,
        editable: true,
        runtimeApplied: false,
        warning: 'restart failed',
      });
    expect(save).toHaveBeenCalledWith('# Rule');
  });

  it('preserves runtime status codes for policy and size errors', async () => {
    const save = vi.fn(async () => {
      throw Object.assign(new Error('read only'), { statusCode: 409 });
    });
    const app = createApp({ read: vi.fn(), save });

    await request(app)
      .put('/api/behavior/agents-md')
      .send({ content: '# Rule' })
      .expect(409)
      .expect({ error: 'read only' });
  });
});
