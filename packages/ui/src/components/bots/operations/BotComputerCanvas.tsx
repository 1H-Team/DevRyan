import React from 'react';

import type {
  BotComputerViewSession,
  BotHumanInputEvent,
  BotHumanInputModifier,
} from '@/lib/botsApi';
import { pointInFrame, type FrameGeometry } from './botComputerCoordinates';
import { queueBotHumanInputEvent } from './botHumanInputBuffer';
import { BotMjpegParser, botMjpegBoundary, type BotMjpegFrame } from './mjpegStream';

type BotComputerCanvasProps = {
  view: BotComputerViewSession;
  alt: string;
  inputEnabled: boolean;
  onFirstFrame(viewId: string): void;
  onFailure(viewId: string): void;
  onInput(viewId: string, events: readonly BotHumanInputEvent[], signal: AbortSignal): Promise<void>;
  onInputFailure(): void;
};

export type BotComputerCanvasHandle = {
  drainPendingInput(): Promise<void>;
  cancelPendingInput(): void;
};

const INPUT_BATCH_LIMIT = 32;
const INPUT_BACKLOG_LIMIT = 256;
const CONTINUOUS_INPUT_FLUSH_MS = 32;
const INPUT_DRAIN_TIMEOUT_MS = 250;

const pointerButton = (button: number): 'none' | 'left' | 'middle' | 'right' => {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
};

const keyboardModifiers = (event: React.KeyboardEvent): readonly BotHumanInputModifier[] => [
  ...(event.altKey ? ['Alt' as const] : []),
  ...(event.ctrlKey ? ['Control' as const] : []),
  ...(event.metaKey ? ['Meta' as const] : []),
  ...(event.shiftKey ? ['Shift' as const] : []),
];

const BotComputerCanvasComponent = React.forwardRef<BotComputerCanvasHandle, BotComputerCanvasProps>(({
  view,
  alt,
  inputEnabled,
  onFirstFrame,
  onFailure,
  onInput,
  onInputFailure,
}, forwardedRef) => {
  const [keyboardNavigationReleased, setKeyboardNavigationReleased] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = React.useRef<HTMLTextAreaElement | null>(null);
  const geometryRef = React.useRef<FrameGeometry | null>(null);
  const lastPointerPointRef = React.useRef<{ x: number; y: number } | null>(null);
  const pressedPointerButtonRef = React.useRef<'left' | 'middle' | 'right' | null>(null);
  const batchRef = React.useRef<BotHumanInputEvent[]>([]);
  const batchTimerRef = React.useRef<number | null>(null);
  const inputDispatchingRef = React.useRef(false);
  const inputDispatchPromiseRef = React.useRef<Promise<void> | null>(null);
  const inputControllerRef = React.useRef<AbortController | null>(null);
  const inputGenerationRef = React.useRef(0);
  const inputEnabledRef = React.useRef(inputEnabled);
  const inputAcceptingRef = React.useRef(inputEnabled);
  const composingRef = React.useRef(false);
  const keyboardHadFocusRef = React.useRef(false);
  const keyboardNavigationReleasedRef = React.useRef(false);
  const onInputRef = React.useRef(onInput);
  const onInputFailureRef = React.useRef(onInputFailure);
  onInputRef.current = onInput;
  onInputFailureRef.current = onInputFailure;

  const cancelPendingInput = React.useCallback(() => {
    inputGenerationRef.current += 1;
    inputEnabledRef.current = false;
    inputAcceptingRef.current = false;
    batchRef.current = [];
    if (batchTimerRef.current !== null) window.clearTimeout(batchTimerRef.current);
    batchTimerRef.current = null;
    inputControllerRef.current?.abort();
    inputControllerRef.current = null;
    inputDispatchPromiseRef.current = null;
    inputDispatchingRef.current = false;
    keyboardHadFocusRef.current = keyboardRef.current !== null
      && document.activeElement === keyboardRef.current;
    keyboardRef.current?.blur();
    lastPointerPointRef.current = null;
    pressedPointerButtonRef.current = null;
  }, []);

  const flushInput = React.useCallback(() => {
    if (batchTimerRef.current !== null) {
      window.clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (inputDispatchingRef.current || !inputEnabledRef.current) return;
    const events = batchRef.current.splice(0, INPUT_BATCH_LIMIT);
    if (events.length === 0) return;
    inputDispatchingRef.current = true;
    const controller = new AbortController();
    inputControllerRef.current = controller;
    const operation = onInputRef.current(view.id, events, controller.signal);
    inputDispatchPromiseRef.current = operation;
    void operation
      .catch(() => {
        if (controller.signal.aborted || inputDispatchPromiseRef.current !== operation) return;
        batchRef.current = [];
        onInputFailureRef.current();
      })
      .finally(() => {
        if (inputDispatchPromiseRef.current !== operation) return;
        inputDispatchPromiseRef.current = null;
        inputControllerRef.current = null;
        inputDispatchingRef.current = false;
        if (inputEnabledRef.current && batchRef.current.length > 0) {
          window.queueMicrotask(flushInput);
        }
      });
  }, [view.id]);

  const queueInput = React.useCallback((event: BotHumanInputEvent, immediate = false) => {
    if (!inputEnabledRef.current || !inputAcceptingRef.current) return;
    const batch = batchRef.current;
    if (!queueBotHumanInputEvent(batch, event, INPUT_BACKLOG_LIMIT)) {
      onInputFailureRef.current();
      return;
    }
    if (immediate) {
      flushInput();
    } else if (batchTimerRef.current === null) {
      batchTimerRef.current = window.setTimeout(flushInput, CONTINUOUS_INPUT_FLUSH_MS);
    }
  }, [flushInput]);

  const drainPendingInput = React.useCallback(async () => {
    const generation = inputGenerationRef.current;
    inputAcceptingRef.current = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      if (batchTimerRef.current !== null) {
        window.clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      while (generation === inputGenerationRef.current) {
        const active = inputDispatchPromiseRef.current;
        if (active) {
          await active.catch(() => undefined);
          continue;
        }
        if (batchRef.current.length === 0 || !inputEnabledRef.current) return;
        flushInput();
      }
    };
    try {
      await Promise.race([drain(), new Promise<void>((resolve) => {
        timeout = setTimeout(() => { cancelPendingInput(); resolve(); }, INPUT_DRAIN_TIMEOUT_MS);
      })]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }, [cancelPendingInput, flushInput]);

  React.useImperativeHandle(forwardedRef, () => ({ drainPendingInput, cancelPendingInput }), [drainPendingInput, cancelPendingInput]);

  React.useLayoutEffect(() => {
    inputEnabledRef.current = inputEnabled;
    inputAcceptingRef.current = inputEnabled;
    if (!inputEnabled) {
      cancelPendingInput();
    } else {
      // A lease renewal re-runs this effect and its cleanup blurred the
      // keyboard textarea; hand focus back so typing keeps working.
      if (keyboardHadFocusRef.current && !keyboardNavigationReleasedRef.current) {
        keyboardRef.current?.focus({ preventScroll: true });
      }
      keyboardHadFocusRef.current = false;
    }
    return cancelPendingInput;
  }, [cancelPendingInput, inputEnabled, view.id]);

  React.useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let failed = false;
    let drawing = false;
    let pendingFrame: BotMjpegFrame | null = null;
    let firstFrameDrawn = false;

    const failStream = () => {
      if (disposed || failed) return;
      failed = true;
      controller.abort();
      onFailure(view.id);
    };

    const drawNewest = async () => {
      if (drawing || disposed) return;
      drawing = true;
      try {
        while (!disposed && pendingFrame) {
          const frame = pendingFrame;
          pendingFrame = null;
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/jpeg' }));
            if (disposed) return;
            if (pendingFrame) continue;
            const canvas = canvasRef.current;
            const context = canvas?.getContext('2d', { alpha: false });
            if (!canvas || !context || bitmap.width !== frame.width || bitmap.height !== frame.height
              || frame.deviceScaleFactor !== 1) {
              throw new Error('Decoded screen frame metadata does not match the viewport');
            }
            if (canvas.width !== frame.width) canvas.width = frame.width;
            if (canvas.height !== frame.height) canvas.height = frame.height;
            context.drawImage(bitmap, 0, 0, frame.width, frame.height);
            geometryRef.current = frame;
            if (!firstFrameDrawn) {
              firstFrameDrawn = true;
              try {
                performance.mark('bot.screen.first-frame-drawn', {
                  detail: { viewId: view.id, width: frame.width, height: frame.height },
                });
              } catch {
                // Diagnostics must not affect screen viewing.
              }
              onFirstFrame(view.id);
            }
          } finally {
            bitmap?.close();
          }
        }
      } catch {
        failStream();
      } finally {
        drawing = false;
        if (!disposed && pendingFrame && !failed) void drawNewest();
      }
    };

    void (async () => {
      try {
        const response = await fetch(view.streamUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Screen stream is unavailable');
        const parser = new BotMjpegParser(botMjpegBoundary(response.headers.get('content-type')));
        const reader = response.body.getReader();
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          const frames = parser.push(value);
          if (frames.length > 0) {
            pendingFrame = frames[frames.length - 1];
            void drawNewest();
          }
        }
        if (!controller.signal.aborted) failStream();
      } catch {
        if (!controller.signal.aborted) failStream();
      }
    })();

    return () => {
      disposed = true;
      pendingFrame = null;
      geometryRef.current = null;
      controller.abort();
    };
  }, [onFailure, onFirstFrame, view.id, view.streamUrl]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !inputEnabled) return;
    const wheel = (event: WheelEvent) => {
      const geometry = geometryRef.current;
      if (!geometry) return;
      const point = pointInFrame(canvas, geometry, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? geometry.height : 1;
      queueInput({
        type: 'wheel',
        ...point,
        deltaX: Math.max(-100_000, Math.min(100_000, event.deltaX * unit)),
        deltaY: Math.max(-100_000, Math.min(100_000, event.deltaY * unit)),
      });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [inputEnabled, queueInput]);

  const pointerEvent = React.useCallback((
    event: React.PointerEvent<HTMLCanvasElement>,
    phase: 'move' | 'down' | 'up',
  ) => {
    if (!inputEnabled) return;
    const geometry = geometryRef.current;
    let point = geometry ? pointInFrame(event.currentTarget, geometry, event.clientX, event.clientY) : null;
    if (phase === 'down') {
      if (!point) return;
      // Cancel the default focus change, which would blur the keyboard
      // textarea to <body> right after the focus() below.
      event.preventDefault();
      setKeyboardNavigationReleased(false);
      keyboardNavigationReleasedRef.current = false;
      keyboardRef.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      lastPointerPointRef.current = point;
      const pressedButton = pointerButton(event.button);
      pressedPointerButtonRef.current = pressedButton === 'none' ? null : pressedButton;
    } else if (phase === 'move') {
      if (!point) return;
      lastPointerPointRef.current = point;
    }
    if (phase === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (phase === 'up' && !point) point = lastPointerPointRef.current;
    if (!point) return;
    const button = phase === 'move'
      ? 'none'
      : phase === 'up'
        ? pressedPointerButtonRef.current || pointerButton(event.button)
        : pointerButton(event.button);
    queueInput({
      type: 'pointer',
      phase,
      ...point,
      button,
      buttons: event.buttons,
      clickCount: phase === 'move' ? 0 : Math.max(1, Math.min(3, event.detail || 1)),
    }, phase !== 'move');
    if (phase === 'up') {
      lastPointerPointRef.current = null;
      pressedPointerButtonRef.current = null;
    }
  }, [inputEnabled, queueInput]);

  const keyboardEvent = React.useCallback((
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    phase: 'down' | 'up',
  ) => {
    if (!inputEnabled || event.nativeEvent.isComposing || composingRef.current) return;
    if (event.ctrlKey && event.altKey && event.key === 'Escape') {
      event.preventDefault();
      setKeyboardNavigationReleased(true);
      keyboardNavigationReleasedRef.current = true;
      event.currentTarget.blur();
      return;
    }
    const pasteShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v';
    if (pasteShortcut) return;
    event.preventDefault();
    queueInput({
      type: 'key',
      phase,
      key: event.key,
      code: event.code,
      modifiers: keyboardModifiers(event),
      location: event.location,
      repeat: event.repeat,
    }, true);
  }, [inputEnabled, queueInput]);

  return (
    <div className={`relative h-full w-full ${
      inputEnabled ? 'focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary' : ''
    }`}>
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        aria-label={alt}
        data-bot-computer-canvas="true"
        data-bot-computer-input={inputEnabled ? 'enabled' : 'disabled'}
        className={`h-full w-full object-contain outline-none ${inputEnabled ? 'cursor-default' : ''}`}
        onContextMenu={(event) => {
          if (inputEnabled) event.preventDefault();
        }}
        onMouseDown={(event) => {
          // Safari fires the focus-stealing default on mousedown even when
          // the preceding pointerdown was canceled.
          if (inputEnabled) event.preventDefault();
        }}
        onPointerMove={(event) => pointerEvent(event, 'move')}
        onPointerDown={(event) => pointerEvent(event, 'down')}
        onPointerUp={(event) => pointerEvent(event, 'up')}
        onPointerCancel={(event) => pointerEvent(event, 'up')}
      />
      <textarea
        ref={keyboardRef}
        tabIndex={inputEnabled && !keyboardNavigationReleased ? 0 : -1}
        aria-label={alt}
        data-bot-computer-keyboard="true"
        data-bot-computer-keyboard-released={keyboardNavigationReleased ? 'true' : 'false'}
        className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none opacity-0"
        onKeyDown={(event) => keyboardEvent(event, 'down')}
        onKeyUp={(event) => keyboardEvent(event, 'up')}
        onPaste={(event) => {
          if (!inputEnabled) return;
          const text = event.clipboardData.getData('text/plain');
          if (!text) return;
          event.preventDefault();
          queueInput({ type: 'text', text: text.slice(0, 32 * 1024) }, true);
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          event.currentTarget.value = '';
          if (inputEnabled && event.data) {
            queueInput({ type: 'text', text: event.data.slice(0, 32 * 1024) }, true);
          }
        }}
      />
    </div>
  );
});

BotComputerCanvasComponent.displayName = 'BotComputerCanvas';
export const BotComputerCanvas = React.memo(BotComputerCanvasComponent);
