import { describe, expect, test } from 'bun:test';
import { dict } from './en';

describe('reasoning settings copy', () => {
  test('describes the setting as a visibility control for provider-supplied reasoning', () => {
    expect(dict['settings.openchamber.visual.field.showReasoningTraces']).toBe('Show Available Reasoning');
    expect(dict['settings.openchamber.visual.field.showReasoningTracesAria']).toBe('Show Available Reasoning');

    const tooltip = dict['settings.openchamber.visual.field.showReasoningTracesTooltip'];
    expect(tooltip).toContain('supplied by the provider');
    expect(tooltip).toContain('does not enable reasoning or change reasoning effort');
    expect(tooltip).toContain('Hosted OpenAI models provide summaries, not raw internal thoughts');
    expect(tooltip).toContain('Response Style does not affect reasoning availability');
  });
});
