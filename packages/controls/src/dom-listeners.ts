import type { CameraPort } from './camera-port.js';
import type { GestureContext } from './gesture-context.js';
import type { KeyboardInput } from './keyboard.js';
import type { MouseGestures } from './mouse-gestures.js';
import type { TouchGestures } from './touch-gestures.js';
import type { WheelInput } from './wheel-input.js';
import type { ZoomBox } from './zoom-box.js';

/** The recognizers the DOM handlers feed. */
export interface Recognizers {
  readonly mouse: MouseGestures;
  readonly touch: TouchGestures;
  readonly wheel: WheelInput;
  readonly keyboard: KeyboardInput;
  readonly box: ZoomBox;
}

/** A listener to add on attach and remove on destroy. */
export type Listener = readonly [EventTarget, string, EventListener];

/** Safari's trackpad gesture event. */
interface GestureEventLike extends Event {
  readonly scale?: number;
  readonly rotation?: number;
  readonly clientX?: number;
  readonly clientY?: number;
}

/** The DOM handlers: they record input and ask for a frame, nothing more (ADR 0009 §3). */
export function domListeners(
  element: HTMLElement,
  port: CameraPort,
  context: GestureContext,
  r: Recognizers,
): Listener[] {
  return [...pointerListeners(element, port, r), ...otherListeners(element, port, context, r)];
}

function localPoint(element: HTMLElement, event: MouseEvent): { xPx: number; yPx: number } {
  const rect = element.getBoundingClientRect();
  return { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
}

function pointerListeners(element: HTMLElement, port: CameraPort, r: Recognizers): Listener[] {
  const request = (needed: boolean): void => {
    if (needed) port.requestUpdate();
  };
  const onDown = (event: PointerEvent): void => {
    const { xPx, yPx } = localPoint(element, event);
    const accepted =
      event.pointerType === 'touch'
        ? r.touch.down(event.pointerId, xPx, yPx, event.timeStamp)
        : r.mouse.press(event.pointerId, {
            xPx,
            yPx,
            timeMs: event.timeStamp,
            button: event.button,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
          });
    if (!accepted) return;
    element.setPointerCapture(event.pointerId);
    element.focus({ preventScroll: true });
    event.preventDefault();
  };
  const onMove = (event: PointerEvent): void => {
    const { xPx, yPx } = localPoint(element, event);
    if (event.pointerType === 'touch') request(r.touch.move(event.pointerId, xPx, yPx, event.timeStamp));
    else if (event.pointerId === r.mouse.pointerId) request(r.mouse.move(xPx, yPx, event.timeStamp, event.ctrlKey));
  };
  const onUp = (event: PointerEvent): void => {
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    const cancelled = event.type === 'pointercancel';
    if (event.pointerType === 'touch') return request(r.touch.up(event.pointerId, event.timeStamp, cancelled));
    if (event.pointerId !== r.mouse.pointerId) return;
    if (cancelled) return r.mouse.cancel();
    const { xPx, yPx } = localPoint(element, event);
    request(r.mouse.up(xPx, yPx, event.timeStamp));
  };
  const onWheel = (event: WheelEvent): void => {
    // Only over the map: the page keeps scrolling elsewhere, and a pinch never zooms the page here (F189).
    event.preventDefault();
    const { xPx, yPx } = localPoint(element, event);
    const input = { xPx, yPx, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey };
    request(r.wheel.wheel(input, element.clientHeight));
  };
  return [
    [element, 'pointerdown', onDown as EventListener],
    [element, 'pointermove', onMove as EventListener],
    [element, 'pointerup', onUp as EventListener],
    [element, 'pointercancel', onUp as EventListener],
    [element, 'wheel', onWheel as EventListener],
  ];
}

function otherListeners(element: HTMLElement, port: CameraPort, context: GestureContext, r: Recognizers): Listener[] {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (r.keyboard.keyDown(event)) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => r.keyboard.keyUp(event);
  const onBlur = (): void => {
    r.keyboard.releaseAll();
    element.style.outline = '';
  };
  // A visible focus ring when the map is reached with the keyboard (F213).
  const onFocus = (): void => {
    if (element.matches(':focus-visible')) element.style.outline = '3px solid #4c9ffe';
  };
  const onDocKey = (event: KeyboardEvent): void => {
    if (event.key === 'Control') r.wheel.ctrlHeld = event.type === 'keydown';
    if (event.key === 'Escape' && event.type === 'keydown' && r.box.drawing) r.mouse.cancel();
  };
  const onGesture = (event: GestureEventLike): void => {
    event.preventDefault();
    if (event.type === 'gesturestart') return r.wheel.gestureStart();
    // iOS and iPadOS Safari send these for a two-finger touch too, which the touch gestures already apply (KB-152).
    if (event.type !== 'gesturechange' || r.touch.active) return;
    const rect = element.getBoundingClientRect();
    const xPx = (event.clientX ?? rect.left + element.clientWidth / 2) - rect.left;
    const yPx = (event.clientY ?? rect.top + element.clientHeight / 2) - rect.top;
    if (r.wheel.gestureChange(event.scale ?? 1, event.rotation ?? 0, xPx, yPx)) port.requestUpdate();
  };
  const onContextMenu = (event: Event): void => {
    if (context.options.gestures.dragRotate) event.preventDefault();
  };
  // A Ctrl released elsewhere (Ctrl+L, Ctrl+Tab) sends its keyup there: forgotten when the window loses focus (KB-151).
  const onWindowBlur = (): void => void (r.wheel.ctrlHeld = false);
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  return [
    ...(view ? ([[view, 'blur', onWindowBlur]] as Listener[]) : []),
    [element, 'keydown', onKeyDown as EventListener],
    [element, 'keyup', onKeyUp as EventListener],
    [element, 'blur', onBlur],
    [element, 'focus', onFocus],
    [element, 'contextmenu', onContextMenu],
    [element, 'gesturestart', onGesture],
    [element, 'gesturechange', onGesture],
    [element, 'gestureend', onGesture],
    [doc, 'keydown', onDocKey as EventListener],
    [doc, 'keyup', onDocKey as EventListener],
  ];
}
