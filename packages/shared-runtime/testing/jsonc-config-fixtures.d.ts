export interface JsoncConfigFixture {
  name: string;
  source: string;
  valid: boolean;
  value?: Record<string, unknown>;
}

export const JSONC_CONFIG_FIXTURES: JsoncConfigFixture[];
