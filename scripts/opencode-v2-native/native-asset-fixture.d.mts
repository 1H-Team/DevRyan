import type {BuildArtifact, BunPlugin} from 'bun';

export function createNativeAssetFixturePlugin(repository: string): Promise<BunPlugin>;
export function writeNativeFixtureOutputs(outputs: readonly BuildArtifact[]): Promise<void>;
