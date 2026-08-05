export type WasmModelStatus =
  | { state: 'unloaded' }
  | { state: 'downloading'; progress: number }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; error: string };

export type WasmModelInfo = {
  id: string;
  name: string;
  size: string;
  languages: string;
  description: string;
};

export const DEFAULT_WASM_STT_MODEL = 'Xenova/whisper-tiny';

export const WASM_MODELS: WasmModelInfo[] = [
  {
    id: DEFAULT_WASM_STT_MODEL,
    name: 'Whisper Tiny',
    size: '~40 MB',
    languages: 'Multilingual',
    description: 'Fast multilingual model. Default for local voice input.',
  },
  {
    id: 'Xenova/whisper-tiny.en',
    name: 'Whisper Tiny (EN)',
    size: '~39 MB',
    languages: 'English',
    description: 'Fastest local model. Good for quick dictation.',
  },
  {
    id: 'Xenova/whisper-base.en',
    name: 'Whisper Base (EN)',
    size: '~73 MB',
    languages: 'English',
    description: 'Balanced speed and accuracy for English dictation.',
  },
  {
    id: 'Xenova/whisper-small.en',
    name: 'Whisper Small (EN)',
    size: '~166 MB',
    languages: 'English',
    description: 'Higher accuracy, slower. Better for noisy environments.',
  },
];

export type SpeechResultCallback = (text: string, isFinal: boolean) => void;
export type ErrorCallback = (error: string) => void;
export type AudioLevelCallback = (level: number) => void;

type WasmSttConfig = {
  deviceId?: string;
  silenceThresholdDb?: number;
  silenceHoldMs?: number;
};

type WorkerMessage =
  | { type: 'progress'; progress?: number }
  | { type: 'loaded' }
  | { type: 'result'; transcript?: string }
  | { type: 'error'; error?: string };

const VAD_POLL_MS = 80;
const MIN_UTTERANCE_MS = 300;
const WHISPER_SAMPLE_RATE = 16000;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

class WasmSttService {
  private worker: Worker | null = null;
  private modelStatus: WasmModelStatus = { state: 'unloaded' };
  private currentModelId: string | null = null;
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private recordingStartMs = 0;
  private isActive = false;
  private isSpeaking = false;
  private silenceSince: number | null = null;
  private onResult: SpeechResultCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onAudioLevel: AudioLevelCallback | null = null;
  private finishResolver: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private modelStatusListeners = new Set<(status: WasmModelStatus) => void>();
  private language = 'en';
  private config: Required<WasmSttConfig> = {
    deviceId: '',
    silenceThresholdDb: -45,
    silenceHoldMs: 1500,
  };

  configure(config: WasmSttConfig): void {
    this.config = { ...this.config, ...config };
  }

  isSupported(): boolean {
    return typeof window !== 'undefined'
      && typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getUserMedia === 'function'
      && typeof window.Worker !== 'undefined'
      && typeof window.MediaRecorder !== 'undefined'
      && typeof window.AudioContext !== 'undefined';
  }

  getModelStatus(): WasmModelStatus {
    return this.modelStatus;
  }

  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  subscribeModelStatus(listener: (status: WasmModelStatus) => void): () => void {
    this.modelStatusListeners.add(listener);
    listener(this.modelStatus);
    return () => {
      this.modelStatusListeners.delete(listener);
    };
  }

  async loadModel(modelId: string): Promise<void> {
    if (this.currentModelId === modelId && this.modelStatus.state === 'ready') return;
    if (this.loadPromise) {
      if (this.currentModelId === modelId) {
        return this.loadPromise;
      }
      await this.loadPromise.catch(() => {});
      return this.loadModel(modelId);
    }

    this.terminateWorker();
    this.currentModelId = modelId;
    this.setModelStatus({ state: 'downloading', progress: 0 });

    this.loadPromise = (async () => {
      this.worker = new Worker(new URL('./wasmSttWorker.ts', import.meta.url), { type: 'module' });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Worker initialization timed out')), 10_000);

        this.worker!.onmessage = (event: MessageEvent<WorkerMessage>) => {
          if (event.data.type === 'progress') {
            this.setModelStatus({ state: 'downloading', progress: event.data.progress ?? 0 });
            return;
          }
          if (event.data.type === 'loaded') {
            window.clearTimeout(timer);
            resolve();
            return;
          }
          if (event.data.type === 'error') {
            window.clearTimeout(timer);
            reject(new Error(event.data.error ?? 'Worker load failed'));
          }
        };

        this.worker!.onerror = (error) => {
          window.clearTimeout(timer);
          reject(new Error(error.message || 'Worker error'));
        };

        this.worker!.postMessage({ type: 'load', modelId });
      });

      this.setModelStatus({ state: 'ready' });
    })();

    try {
      await this.loadPromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load Whisper model';
      this.terminateWorker();
      this.currentModelId = null;
      this.setModelStatus({ state: 'error', error: message });
      throw error;
    } finally {
      this.loadPromise = null;
    }
  }

  unloadModel(): void {
    this.terminateWorker();
    this.currentModelId = null;
    this.setModelStatus({ state: 'unloaded' });
  }

  async startListening(
    language: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback,
    onAudioLevel?: AudioLevelCallback,
  ): Promise<void> {
    if (this.isActive) this.stopListening();
    if (!this.worker || this.modelStatus.state !== 'ready') {
      onError?.('Whisper model is not loaded. Load a local model in Voice settings first.');
      return;
    }

    this.language = language;
    this.onResult = onResult;
    this.onError = onError ?? null;
    this.onAudioLevel = onAudioLevel ?? null;
    this.isActive = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.config.deviceId ? { deviceId: { exact: this.config.deviceId } } : true,
        video: false,
      });
    } catch (error) {
      this.isActive = false;
      onError?.(error instanceof Error ? error.message : 'Microphone access denied');
      return;
    }

    this.setupAudioContext();
    this.startRecorder();
    this.startVAD();
  }

  stopListening(): void {
    this.stopVAD();
    if (this.mediaRecorder?.state === 'recording') {
      try { this.mediaRecorder.stop(); } catch { /* ignore */ }
    }
    this.cleanupAfterStop(true);
  }

  async finishListening(): Promise<void> {
    if (!this.isActive) return;

    this.stopVAD();
    this.isSpeaking = false;
    this.silenceSince = null;

    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      this.cleanupAfterStop(true);
      return;
    }

    await new Promise<void>((resolve) => {
      this.finishResolver = resolve;
      this.finalizeUtterance(false);
    });

    this.cleanupAfterStop(false);
  }

  getIsListening(): boolean {
    return this.isActive;
  }

  private setModelStatus(status: WasmModelStatus): void {
    this.modelStatus = status;
    for (const listener of this.modelStatusListeners) {
      listener(status);
    }
  }

  private terminateWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private setupAudioContext(): void {
    if (!this.stream) return;
    this.audioContext = new window.AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
  }

  private startRecorder(): void {
    if (!this.stream) return;

    const mimeType = this.pickMimeType();
    const options: MediaRecorderOptions = {};
    if (mimeType && MediaRecorder.isTypeSupported(mimeType)) options.mimeType = mimeType;

    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.recordingStartMs = Date.now();

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.mediaRecorder.onstop = () => {
      const blobs = this.chunks.splice(0);
      const durationMs = Date.now() - this.recordingStartMs;
      if (blobs.length === 0 || durationMs < MIN_UTTERANCE_MS) {
        this.resolveFinish();
        return;
      }

      const blob = new Blob(blobs, { type: blobs[0]?.type || mimeType || 'audio/webm' });
      void this.transcribe(blob).finally(() => this.resolveFinish());
    };

    this.mediaRecorder.start(250);
  }

  private startVAD(): void {
    this.stopVAD();
    this.silenceSince = null;
    this.isSpeaking = false;

    this.vadTimer = setInterval(() => {
      if (!this.isActive || !this.analyser) return;
      const db = this.getRmsDb();
      const level = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 40));
      this.onAudioLevel?.(level);

      if (db >= this.config.silenceThresholdDb) {
        this.silenceSince = null;
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          if (this.mediaRecorder?.state === 'recording') this.recordingStartMs = Date.now();
        }
        return;
      }

      if (!this.isSpeaking) return;
      if (this.silenceSince === null) {
        this.silenceSince = Date.now();
        return;
      }
      if (Date.now() - this.silenceSince >= this.config.silenceHoldMs) {
        this.isSpeaking = false;
        this.silenceSince = null;
        this.finalizeUtterance(true);
      }
    }, VAD_POLL_MS);
  }

  private stopVAD(): void {
    if (this.vadTimer !== null) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
  }

  private finalizeUtterance(restart: boolean): void {
    if (!this.isActive) return;
    if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    if (!restart) return;

    window.setTimeout(() => {
      if (this.isActive && this.stream) this.startRecorder();
    }, 100);
  }

  private cleanupAfterStop(clearChunks: boolean): void {
    const resolver = this.finishResolver;
    this.finishResolver = null;
    this.isActive = false;
    this.mediaRecorder = null;
    try { void this.audioContext?.close(); } catch { /* ignore */ }
    this.audioContext = null;
    this.analyser = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (clearChunks) this.chunks = [];
    this.isSpeaking = false;
    this.silenceSince = null;
    this.onResult = null;
    this.onError = null;
    this.onAudioLevel = null;
    resolver?.();
  }

  private resolveFinish(): void {
    this.finishResolver?.();
    this.finishResolver = null;
  }

  private async transcribe(blob: Blob): Promise<void> {
    if (!this.worker || !this.onResult) return;

    try {
      const audioData = await this.decodeToFloat32(blob);
      if (!audioData || audioData.length === 0) {
        this.onError?.(`Failed to decode audio (${blob.size} bytes)`);
        return;
      }

      const transcript = await this.transcribeViaWorker(audioData, this.resolveLanguageHint());
      if (transcript) this.onResult(transcript, true);
    } catch (error) {
      if (!this.isActive) return;
      this.onError?.(error instanceof Error ? error.message : 'Local transcription failed');
    }
  }

  private transcribeViaWorker(audioData: Float32Array, language?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker unavailable'));
        return;
      }

      const timer = window.setTimeout(() => {
        this.worker?.removeEventListener('message', handleMessage);
        reject(new Error('Transcription timed out'));
      }, TRANSCRIPTION_TIMEOUT_MS);

      const handleMessage = (event: MessageEvent<WorkerMessage>) => {
        if (event.data.type === 'result') {
          window.clearTimeout(timer);
          this.worker?.removeEventListener('message', handleMessage);
          resolve(event.data.transcript ?? '');
          return;
        }
        if (event.data.type === 'error') {
          window.clearTimeout(timer);
          this.worker?.removeEventListener('message', handleMessage);
          reject(new Error(event.data.error ?? 'Transcription failed'));
        }
      };

      this.worker.addEventListener('message', handleMessage);
      this.worker.postMessage({ type: 'transcribe', audio: audioData.buffer, language }, [audioData.buffer]);
    });
  }

  private async decodeToFloat32(blob: Blob): Promise<Float32Array | null> {
    if (!this.audioContext) return null;

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.audioContext.decodeAudioData(await blob.arrayBuffer());
    } catch {
      return null;
    }

    const originalRate = audioBuffer.sampleRate;
    const originalData = audioBuffer.getChannelData(0);
    if (originalRate === WHISPER_SAMPLE_RATE) return new Float32Array(originalData);

    const ratio = originalRate / WHISPER_SAMPLE_RATE;
    const nextLength = Math.ceil(originalData.length / ratio);
    const result = new Float32Array(nextLength);
    for (let index = 0; index < nextLength; index += 1) {
      const originalIndex = index * ratio;
      const lowerIndex = Math.floor(originalIndex);
      const upperIndex = Math.min(lowerIndex + 1, originalData.length - 1);
      const fraction = originalIndex - lowerIndex;
      result[index] = originalData[lowerIndex] * (1 - fraction) + originalData[upperIndex] * fraction;
    }
    return result;
  }

  private getRmsDb(): number {
    if (!this.analyser) return -Infinity;
    const buffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (const sample of buffer) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / buffer.length);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms);
  }

  private resolveLanguageHint(): string | undefined {
    if (this.currentModelId?.endsWith('.en')) return 'en';
    const normalized = this.language.trim();
    if (!normalized || normalized === 'auto') return undefined;
    return normalized.split('-')[0];
  }

  private pickMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
  }
}

export const wasmSttService = new WasmSttService();
export { WasmSttService };
