import { describe, expect, test } from 'bun:test';
import {
  appendVoiceTranscript,
  applyVoiceTranscriptUpdate,
  isBrowserServiceRecoveryError,
  isRecoverableVoiceSilenceError,
  resolveCommittedVoiceInputDraft,
  resolveVoiceInputDraft,
  type VoiceTranscriptDraftState,
} from './useBrowserVoice';

describe('voice input draft helpers', () => {
  test('appends transcript inline with a trailing space', () => {
    expect(appendVoiceTranscript('', 'hello')).toBe('hello ');
    expect(appendVoiceTranscript('Ask Ryan', 'about tests')).toBe('Ask Ryan about tests ');
    expect(appendVoiceTranscript('Ask Ryan ', 'about tests')).toBe('Ask Ryan about tests ');
  });

  test('replaces partial transcript against the original base text', () => {
    const partial = resolveVoiceInputDraft({
      baseText: 'Draft',
      currentText: 'Draft',
      lastAppliedText: 'Draft',
      transcript: 'hello',
    });

    expect(partial).toBe('Draft hello ');
    expect(resolveVoiceInputDraft({
      baseText: 'Draft',
      currentText: partial,
      lastAppliedText: partial,
      transcript: 'hello world',
    })).toBe('Draft hello world ');
  });

  test('preserves user edits made after a partial transcript', () => {
    expect(resolveVoiceInputDraft({
      baseText: 'Draft',
      currentText: 'Draft manual edit',
      lastAppliedText: 'Draft hello ',
      transcript: 'hello world',
    })).toBe('Draft manual edit hello world ');
  });

  test('uses only incremental transcript when user edits after interim dictation', () => {
    expect(resolveVoiceInputDraft({
      baseText: 'Draft',
      currentText: 'Draft manual',
      lastAppliedText: 'Draft hello ',
      transcript: 'hello world',
      previousTranscript: 'hello',
      isRecentUserEdit: true,
    })).toBe('Draft manual world ');
  });

  test('does not restore deleted text while an active selection is being edited', () => {
    expect(resolveVoiceInputDraft({
      baseText: 'Draft hello ',
      currentText: 'Draft ',
      lastAppliedText: 'Draft hello ',
      transcript: 'hello world',
      previousTranscript: 'hello',
      hasActiveSelection: true,
    })).toBe('Draft world ');
  });

  test('keeps final transcript state ready for the next utterance', () => {
    const first = resolveCommittedVoiceInputDraft({
      baseText: 'Draft',
      currentText: 'Draft hello ',
      lastAppliedText: 'Draft hello ',
      transcript: 'hello',
    });

    expect(first.nextText).toBe('Draft hello ');
    expect(first.nextBaseText).toBe('Draft hello ');
    expect(first.nextLastAppliedText).toBe('Draft hello ');

    const second = resolveCommittedVoiceInputDraft({
      baseText: first.nextBaseText,
      currentText: first.nextText,
      lastAppliedText: first.nextLastAppliedText,
      transcript: 'world',
    });

    expect(second.nextText).toBe('Draft hello world ');
    expect(second.nextBaseText).toBe('Draft hello world ');
    expect(second.nextLastAppliedText).toBe('Draft hello world ');
  });

  test('allows identical separate final utterances to be appended', () => {
    const first = resolveCommittedVoiceInputDraft({
      baseText: '',
      currentText: 'hello ',
      lastAppliedText: 'hello ',
      transcript: 'hello',
    });
    const second = resolveCommittedVoiceInputDraft({
      baseText: first.nextBaseText,
      currentText: first.nextText,
      lastAppliedText: first.nextLastAppliedText,
      transcript: 'hello',
    });

    expect(second.nextText).toBe('hello hello ');
  });
});

describe('range-based voice transcript updates', () => {
  test('interim transcript replaces only the current voice-owned range', () => {
    const first = applyVoiceTranscriptUpdate({
      state: null,
      currentText: 'Draft ',
      selectionStart: 6,
      selectionEnd: 6,
      transcript: 'hello',
      isFinal: false,
    });

    expect(first.nextText).toBe('Draft hello ');
    expect(first.selection).toEqual({ start: 12, end: 12 });

    const second = applyVoiceTranscriptUpdate({
      state: first.nextState,
      currentText: 'Draft hello ',
      selectionStart: 12,
      selectionEnd: 12,
      transcript: 'hello world',
      isFinal: false,
    });

    expect(second.nextText).toBe('Draft hello world ');
    expect(second.selection).toEqual({ start: 18, end: 18 });
  });

  test('preserves user edits made after interim dictation', () => {
    const state: VoiceTranscriptDraftState = {
      insertionStart: 6,
      insertionEnd: 12,
      interimRange: { start: 6, end: 12 },
      ownedText: 'hello ',
      lastTranscript: 'hello',
    };

    const result = applyVoiceTranscriptUpdate({
      state,
      currentText: 'Draft hello manual',
      selectionStart: 18,
      selectionEnd: 18,
      transcript: 'hello world',
      isFinal: false,
    });

    expect(result.nextText).toBe('Draft hello world manual');
    expect(result.selection).toEqual({ start: 18, end: 18 });
  });

  test('does not restore deleted voice text after user edits the owned range', () => {
    const state: VoiceTranscriptDraftState = {
      insertionStart: 6,
      insertionEnd: 12,
      interimRange: { start: 6, end: 12 },
      ownedText: 'hello ',
      lastTranscript: 'hello',
    };

    const result = applyVoiceTranscriptUpdate({
      state,
      currentText: 'Draft ',
      selectionStart: 6,
      selectionEnd: 6,
      transcript: 'hello world',
      isFinal: false,
    });

    expect(result.nextText).toBe('Draft world ');
    expect(result.selection).toEqual({ start: 12, end: 12 });
  });

  test('blocks interim insertion while a selection is active', () => {
    const state: VoiceTranscriptDraftState = {
      insertionStart: 6,
      insertionEnd: 6,
      interimRange: null,
      ownedText: '',
      lastTranscript: null,
    };

    const result = applyVoiceTranscriptUpdate({
      state,
      currentText: 'Draft selected',
      selectionStart: 6,
      selectionEnd: 14,
      transcript: 'hello',
      isFinal: false,
    });

    expect(result.nextText).toBe('Draft selected');
    expect(result.selection).toEqual({ start: 6, end: 14 });
    expect(result.nextState.interimRange).toBeNull();
  });

  test('final transcript commits the range and the next utterance appends after it', () => {
    const interim = applyVoiceTranscriptUpdate({
      state: null,
      currentText: '',
      selectionStart: 0,
      selectionEnd: 0,
      transcript: 'hello',
      isFinal: false,
    });

    const final = applyVoiceTranscriptUpdate({
      state: interim.nextState,
      currentText: interim.nextText,
      selectionStart: interim.selection.start,
      selectionEnd: interim.selection.end,
      transcript: 'hello',
      isFinal: true,
    });

    const next = applyVoiceTranscriptUpdate({
      state: final.nextState,
      currentText: final.nextText,
      selectionStart: final.selection.start,
      selectionEnd: final.selection.end,
      transcript: 'world',
      isFinal: true,
    });

    expect(final.nextText).toBe('hello ');
    expect(final.nextState.interimRange).toBeNull();
    expect(next.nextText).toBe('hello world ');
  });

  test('allows identical separate final utterances to be appended', () => {
    const first = applyVoiceTranscriptUpdate({
      state: null,
      currentText: '',
      selectionStart: 0,
      selectionEnd: 0,
      transcript: 'hello',
      isFinal: true,
    });
    const second = applyVoiceTranscriptUpdate({
      state: first.nextState,
      currentText: first.nextText,
      selectionStart: first.selection.start,
      selectionEnd: first.selection.end,
      transcript: 'hello',
      isFinal: true,
    });

    expect(second.nextText).toBe('hello hello ');
  });
});

describe('isRecoverableVoiceSilenceError', () => {
  test('classifies no-speech and no-input variants as recoverable', () => {
    expect(isRecoverableVoiceSilenceError('no-speech')).toBe(true);
    expect(isRecoverableVoiceSilenceError('No input detected')).toBe(true);
    expect(isRecoverableVoiceSilenceError('No speech detected')).toBe(true);
    expect(isRecoverableVoiceSilenceError('No input')).toBe(true);
  });

  test('does not classify permission, network, or microphone errors as recoverable', () => {
    expect(isRecoverableVoiceSilenceError('Permission denied')).toBe(false);
    expect(isRecoverableVoiceSilenceError('Network error')).toBe(false);
    expect(isRecoverableVoiceSilenceError('No microphone found')).toBe(false);
  });
});

describe('isBrowserServiceRecoveryError', () => {
  test('offers Local recovery only for browser service failures', () => {
    expect(isBrowserServiceRecoveryError('network')).toBe(true);
    expect(isBrowserServiceRecoveryError('service-not-allowed')).toBe(true);
    expect(isBrowserServiceRecoveryError('not-allowed')).toBe(false);
    expect(isBrowserServiceRecoveryError('audio-capture')).toBe(false);
    expect(isBrowserServiceRecoveryError('no-speech')).toBe(false);
  });
});
