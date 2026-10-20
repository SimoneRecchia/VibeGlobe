import type { ControlsFactory, GeoPosition, NavigationApi } from '@vibeglobe/core';

/** Wheel pixels per zoom level (ADR 0009: Δzoom = −Δy / 300). */
const WHEEL_PIXELS_PER_LEVEL = 300;
const LINE_HEIGHT_PX = 16;

/**
 * Creates basic mouse and touch navigation (M2): drag the globe keeping the grabbed point under the pointer, and zoom
 * with the wheel anchored at the cursor. DOM handlers only record input; the engine does the camera math.
 */
export function createControls(): ControlsFactory {
  return (element, navigation) => attach(element as HTMLElement, navigation);
}

function attach(element: HTMLElement, navigation: NavigationApi): { destroy(): void } {
  let anchor: GeoPosition | undefined;
  let pointerId: number | undefined;
  const local = (event: MouseEvent): { xPx: number; yPx: number } => {
    const rect = element.getBoundingClientRect();
    return { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
  };
  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pointerId !== undefined) return;
    anchor = navigation.grab(local(event));
    if (!anchor) return;
    pointerId = event.pointerId;
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId || !anchor) return;
    navigation.dragTo(anchor, local(event));
  };
  const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pointerId = undefined;
    anchor = undefined;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? element.clientHeight : 1;
    navigation.zoomAt(local(event), (-event.deltaY * scale) / WHEEL_PIXELS_PER_LEVEL);
  };
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('wheel', onWheel);
    },
  };
}
