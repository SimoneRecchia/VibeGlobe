import type { GeoPosition, NavigationApi, ScreenPoint } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createControls } from './create-controls.js';

/** A stand-in for the canvas: records listeners and pointer capture; the rectangle starts at (10, 20). */
function fakeElement() {
  const listeners = new Map<string, (event: object) => void>();
  return {
    listeners,
    style: { touchAction: 'auto' },
    clientHeight: 600,
    addEventListener: (type: string, listener: (event: object) => void) => void listeners.set(type, listener),
    removeEventListener: (type: string) => void listeners.delete(type),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => true,
    releasePointerCapture: () => undefined,
    fire(type: string, event: object) {
      listeners.get(type)?.({ preventDefault: () => undefined, pointerId: 1, button: 0, deltaMode: 0, ...event });
    },
  };
}

function recordingNavigation() {
  const calls: string[] = [];
  const anchor: GeoPosition = { longitudeDeg: 1, latitudeDeg: 2 };
  const navigation: NavigationApi = {
    grab: (point: ScreenPoint) => (calls.push(`grab ${point.xPx},${point.yPx}`), anchor),
    dragTo: (_anchor, point) => void calls.push(`drag ${point.xPx},${point.yPx}`),
    zoomAt: (point, deltaZoom) => void calls.push(`zoom ${point.xPx},${point.yPx} ${deltaZoom}`),
    requestUpdate: () => void calls.push('request'),
  };
  return { calls, navigation };
}

describe('createControls (ADR 0009 §3–4)', () => {
  it('records input in the DOM handlers and turns it into intents once per frame', () => {
    const element = fakeElement();
    const { calls, navigation } = recordingNavigation();
    const controls = createControls()(element, navigation);
    element.fire('pointerdown', { clientX: 110, clientY: 120 });
    element.fire('pointermove', { clientX: 120, clientY: 125 });
    element.fire('pointermove', { clientX: 130, clientY: 130 });
    // Handlers only ask for a frame when the pointer moves: no camera math yet.
    expect(calls).toEqual(['request', 'request']);
    calls.length = 0;
    controls.update?.();
    expect(calls).toEqual(['grab 100,100', 'drag 120,110']);
    calls.length = 0;
    controls.update?.();
    expect(calls).toEqual([]);
    element.fire('pointermove', { clientX: 140, clientY: 130 });
    element.fire('pointerup', { clientX: 140, clientY: 130 });
    calls.length = 0;
    // The last position before the release still applies; later moves do not drag.
    controls.update?.();
    element.fire('pointermove', { clientX: 200, clientY: 200 });
    controls.update?.();
    expect(calls).toEqual(['drag 130,110']);
  });

  it('costs no frame for a click without motion', () => {
    const element = fakeElement();
    const { calls, navigation } = recordingNavigation();
    const controls = createControls()(element, navigation);
    element.fire('pointerdown', { clientX: 110, clientY: 120 });
    element.fire('pointerup', { clientX: 110, clientY: 120 });
    controls.update?.();
    expect(calls).toEqual([]);
  });

  it('sums wheel deltas between frames into one zoom at the latest cursor position', () => {
    const element = fakeElement();
    const { calls, navigation } = recordingNavigation();
    const controls = createControls()(element, navigation);
    element.fire('wheel', { clientX: 60, clientY: 70, deltaY: -150 });
    element.fire('wheel', { clientX: 70, clientY: 80, deltaY: -150 });
    element.fire('wheel', { clientX: 70, clientY: 80, deltaY: -3, deltaMode: 1 });
    calls.length = 0;
    controls.update?.();
    expect(calls).toEqual([`zoom 60,60 ${1 + 48 / 300}`]);
  });

  it('ignores other buttons, owns touch gestures while attached and removes its listeners on destroy', () => {
    const element = fakeElement();
    const { calls, navigation } = recordingNavigation();
    const controls = createControls()(element, navigation);
    expect(element.style.touchAction).toBe('none');
    element.fire('pointerdown', { clientX: 110, clientY: 120, button: 2 });
    controls.update?.();
    expect(calls).toEqual([]);
    controls.destroy();
    expect(element.listeners.size).toBe(0);
    expect(element.style.touchAction).toBe('auto');
  });
});
