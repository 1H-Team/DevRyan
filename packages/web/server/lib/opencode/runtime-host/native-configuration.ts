import { Config } from '@opencode/schema/config';
import { Schema } from 'effect';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';

/** Strict SDK decode is shared by snapshot qualification and per-location boot. */
export function decodeNativeConfigurationSnapshot(snapshot: NativeConfigurationSnapshot) {
  return snapshot.locations.map(location => ({ ...location,
    configuration: Schema.decodeUnknownSync(Config.Info)(location.configuration, { onExcessProperty: 'error' }),
  }));
}
