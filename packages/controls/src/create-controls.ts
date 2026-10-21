import type { Controls, ControlsFactory, GeoPosition, NavigationApi } from '@vibeglobe/core';

/** Wheel pixels per zoom level (ADR 0009: Δzoom = −Δy / 300). */
const WHEEL_PIXELS_PER_LEVEL = 300;
const LINE_HEIGHT_PX = 16;

/**
 * Creates basic mouse and touch navigation (M2): drag the globe keeping the grabbed point under the pointer, and zoom
 * with the wheel anchored at the cursor. DOM handlers only record input; once per frame the engine calls `update`,
 * which turns it into at most one grab, one drag and one zoom (ADR 0009 §3–4).
 */
export function createControls(): ControlsFactory {
  return (element, navigation) => attach(element as HTMLElement, navigation);
}

/** A screen point overwritten in place. */
interface MutablePoint {
  xPx: number;
  yPx: number;
}

/** Input recorded by the DOM handlers between two frames, applied by {@link RecordedInput.apply}. */
class RecordedInput {
  pointerId: number | undefined;
  private anchor: GeoPosition | undefined;
  private grabPending = false;
  private movePending = false;
  private releasePending = false;
  private wheelLevels = 0;
  readonly downAt: MutablePoint = { xPx: 0, yPx: 0 };
  readonly pointer: MutablePoint = { xPx: 0, yPx: 0 };
  readonly wheelAt: MutablePoint = { xPx: 0, yPx: 0 };

  press(pointerId: number): void {
    this.pointerId = pointerId;
    this.grabPending = true;
    this.movePending = false;
    this.releasePending = false;
  }

  move(): void {
    this.movePending = true;
  }

  /** Ends the drag; returns whether a frame is needed to apply a position recorded before the release. */
  release(): boolean {
    this.pointerId = undefined;
    if (this.movePending) {
      this.releasePending = true;
      return true;
    }
    this.grabPending = false;
    this.anchor = undefined;
    return false;
  }

  wheel(levels: number): void {
    this.wheelLevels += levels;
  }

  /**
   * Turns the recorded input into intents. The grab waits for the first move, so a click without motion costs no
   * frame; the last position before a release still applies.
   */
  apply(navigation: NavigationApi): void {
    if (this.movePending) {
      this.movePending = false;
      if (this.grabPending) {
        this.grabPending = false;
        this.anchor = navigation.grab(this.downAt);
      }
      if (this.anchor) navigation.dragTo(this.anchor, this.pointer);
    }
    if (this.releasePending) {
      this.releasePending = false;
      this.anchor = undefined;
    }
    if (this.wheelLevels !== 0) {
      const levels = this.wheelLevels;
      this.wheelLevels = 0;
      navigation.zoomAt(this.wheelAt, levels);
    }
  }
}

function attach(element: HTMLElement, navigation: NavigationApi): Controls {
  const input = new RecordedInput();
  const record = (event: MouseEvent, out: MutablePoint): void => {
    const rect = element.getBoundingClientRect();
    out.xPx = event.clientX - rect.left;
    out.yPx = event.clientY - rect.top;
  };
  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || input.pointerId !== undefined) return;
    record(event, input.downAt);
    record(event, input.pointer);
    input.press(event.pointerId);
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== input.pointerId) return;
    record(event, input.pointer);
    input.move();
    navigation.requestUpdate();
  };
  const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== input.pointerId) return;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (input.release()) navigation.requestUpdate();
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? element.clientHeight : 1;
    record(event, input.wheelAt);
    input.wheel((-event.deltaY * scale) / WHEEL_PIXELS_PER_LEVEL);
    navigation.requestUpdate();
  };
  const listeners = [
    ['pointerdown', onDown],
    ['pointermove', onMove],
    ['pointerup', onUp],
    ['pointercancel', onUp],
  ] as const;
  for (const [type, listener] of listeners) element.addEventListener(type, listener);
  element.addEventListener('wheel', onWheel, { passive: false });
  return {
    update: () => input.apply(navigation),
    destroy() {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      element.removeEventListener('wheel', onWheel);
    },
  };
}
