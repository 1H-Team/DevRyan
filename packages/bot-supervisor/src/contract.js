// The Bot engine contract shared by the supervisor, its engine-proxy client and
// the engine proxy that owns Docker. A dependency-free leaf: the engine-proxy
// image copies this one file, and Electron's limit parity test reads it.

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export const BOT_RESOURCE_LIMITS = Object.freeze({
  reasoning: Object.freeze({
    memoryBytes: 2 * GIB,
    nanoCpus: 2_000_000_000,
    pids: 256,
    shmBytes: 64 * MIB,
  }),
  computer: Object.freeze({
    memoryBytes: 3 * GIB,
    nanoCpus: 2_000_000_000,
    pids: 512,
    shmBytes: GIB,
  }),
});

/** The fixed engine protocol: every operation the supervisor may ask the engine for. */
export const BOT_ENGINE_OPERATIONS = Object.freeze([
  'ensureReasoning',
  'ensureComputer',
  'status',
  'stop',
  'reset',
  'writeWorkspace',
  'importSharedFile',
  'exportWorkspaceImage',
  'listWorkspace',
  'listFilesystem',
  'listOwned',
]);

// The class keeps its historical name: error names and codes cross the
// supervisor, engine-proxy and web host boundaries unchanged.
export class BotDockerError extends Error {
  constructor(message, code, { statusCode = 500, dockerStatusCode = null, cause } = {}) {
    super(message, { cause });
    this.name = 'BotDockerError';
    this.code = code;
    this.statusCode = statusCode;
    this.dockerStatusCode = dockerStatusCode;
  }
}
