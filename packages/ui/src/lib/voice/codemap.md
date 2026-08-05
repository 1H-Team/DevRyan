# packages/ui/src/lib/voice/

## Responsibility
Voice-service client helpers for speech features and playback controls.

## Design
Adapter layer abstracts browser/media APIs and server voice endpoints. Browser recognition errors retain their machine code so the UI can offer the existing worker-backed Local Whisper provider when a browser-owned speech service is unavailable. Local model status uses subscriptions so settings and chat controls can observe one shared download safely.

## Flow
Voice UI triggers capture/playback requests; helpers return status/data for components. `voicePreferences.ts` owns the explicit opt-in default for voice mode, while `wasmSttService.ts` owns Local model discovery, download, capture, and transcription.

## Integration
Used by voice components and chat input integrations.
