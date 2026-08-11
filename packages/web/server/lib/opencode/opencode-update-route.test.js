import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeUpdateCheckHandler } from './routes.js';

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: null,
    status: vi.fn((statusCode) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: vi.fn((body) => {
      response.body = body;
      return response;
    }),
  };
  return response;
};

describe('OpenCode update-check route', () => {
  it.each([
    ['managed', '1.18.16'],
    ['external', '1.18.10'],
  ])('uses the active %s runtime version from the resolution snapshot', async (_mode, version) => {
    const checkForOpenCodeUpdates = vi.fn(async ({ currentVersion, supportedVersion }) => ({
      currentVersion,
      latestVersion: '1.18.16',
      supportedVersion,
      updateAvailable: true,
      supportStatus: currentVersion === supportedVersion ? 'supported' : 'older',
    }));
    const handler = createOpenCodeUpdateCheckHandler({
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({
        detectedVersion: version,
        targetVersion: '1.18.16',
      })),
      checkForOpenCodeUpdates,
    });
    const response = createResponse();

    await handler({}, response);

    expect(checkForOpenCodeUpdates).toHaveBeenCalledWith({
      currentVersion: version,
      supportedVersion: '1.18.16',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      currentVersion: version,
      latestVersion: '1.18.16',
    });
  });

  it('returns a non-2xx safe error response when the upstream check fails', async () => {
    const handler = createOpenCodeUpdateCheckHandler({
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({
        detectedVersion: '1.18.16',
        targetVersion: '1.18.16',
      })),
      checkForOpenCodeUpdates: vi.fn(async () => {
        throw new Error('OpenCode release check failed with 429');
      }),
    });
    const response = createResponse();

    await handler({}, response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({ error: 'OpenCode release check failed with 429' });
  });
});
