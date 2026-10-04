import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import type { ReviewedRemoteMcpServer } from './remote-mcp.js';
export function reviewedMcpConfiguration(snapshot: NativeConfigurationSnapshot | undefined,
  directories: readonly string[]): ReadonlyMap<string, ReadonlyMap<string, ReviewedRemoteMcpServer>>;
