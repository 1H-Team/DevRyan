import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WASM_STT_MODEL,
  WASM_MODELS,
  WasmSttService,
  type WasmModelStatus,
} from './wasmSttService';

describe('WasmSttService model contract', () => {
  test('uses a multilingual model as the local fallback default', () => {
    const model = WASM_MODELS.find((candidate) => candidate.id === DEFAULT_WASM_STT_MODEL);

    expect(model?.languages).toBe('Multilingual');
  });

  test('supports multiple status subscribers with independent cleanup', () => {
    const service = new WasmSttService();
    const first: WasmModelStatus[] = [];
    const second: WasmModelStatus[] = [];
    const unsubscribeFirst = service.subscribeModelStatus((status) => first.push(status));
    service.subscribeModelStatus((status) => second.push(status));

    service.unloadModel();
    unsubscribeFirst();
    service.unloadModel();

    expect(first.map((status) => status.state)).toEqual(['unloaded', 'unloaded']);
    expect(second.map((status) => status.state)).toEqual(['unloaded', 'unloaded', 'unloaded']);
  });
});
