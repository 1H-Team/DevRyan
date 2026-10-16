import type { NativeConfigurationLocation } from './native-configuration-snapshot.js';
export function nativeCompactionReserve(location: Pick<NativeConfigurationLocation, 'configuration' | 'compatibility'> | undefined): number | undefined;
