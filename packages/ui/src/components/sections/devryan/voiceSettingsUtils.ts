export type VoiceInputProvider = 'browser' | 'server' | 'macos' | 'wasm';
export type SelectableVoiceInputProvider = VoiceInputProvider;

export const getVoiceInputSourceMode = (provider: VoiceInputProvider): 'fixed-default' | 'media-device' | 'native-device' => {
  if (provider === 'browser') return 'fixed-default';
  if (provider === 'macos') return 'native-device';
  return 'media-device';
};

export const getSelectableVoiceInputProviders = (
  isMacosSpeechAvailable: boolean,
  isLocalSpeechAvailable = true,
): SelectableVoiceInputProvider[] => {
  const portableProviders: SelectableVoiceInputProvider[] = isLocalSpeechAvailable
    ? ['browser', 'wasm', 'server']
    : ['browser', 'server'];
  return isMacosSpeechAvailable ? ['macos', ...portableProviders] : portableProviders;
};

export const normalizeVoiceInputProvider = (
  provider: VoiceInputProvider,
  isMacosSpeechAvailable: boolean,
  isLocalSpeechAvailable = true,
): SelectableVoiceInputProvider => {
  if (provider === 'wasm' && !isLocalSpeechAvailable) {
    return 'browser';
  }
  if (provider === 'macos' && !isMacosSpeechAvailable) {
    return 'browser';
  }
  return provider;
};
