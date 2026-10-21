// The engine in a dedicated worker, drawing into an OffscreenCanvas (F065 experiment, ADR 0011): the page forwards
// size and input, and the worker reports every frame for the measurements.
import { createGlobe, type GeoPosition, type Globe, type RenderHost } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { markerShape } from './marker.js';
import type { FromWorker, ToWorker } from './protocol.js';

/** The worker's global scope, typed for the members used here (the playground compiles against the DOM library). */
const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame(callback: (timeMs: number) => void): number;
  cancelAnimationFrame(id: number): void;
};

let globe: Globe | undefined;
let size = { widthPx: 1, heightPx: 1 };
let pixelRatio = 1;
let notifySize: (() => void) | undefined;
let anchor: GeoPosition | undefined;
let lastSeq = 0;

const host: RenderHost = {
  requestFrame: (callback) => scope.requestAnimationFrame(callback),
  cancelFrame: (id) => scope.cancelAnimationFrame(id),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as number),
  observeSize(callback) {
    notifySize = callback;
    return () => (notifySize = undefined);
  },
  observeVisibility: () => () => undefined,
  containerSize: () => size,
  pixelRatio: () => pixelRatio,
};

function start(message: Extract<ToWorker, { type: 'start' }>): void {
  size = { widthPx: message.widthPx, heightPx: message.heightPx };
  pixelRatio = message.pixelRatio;
  const created = createGlobe({
    container: {},
    renderer: createRenderer({ backend: message.backend, canvas: message.canvas, host }),
    baseImageryUrl: message.imageryUrl,
    view: message.view,
  });
  globe = created;
  created.on('frame', () => {
    const marker = created.geoToScreen(message.marker);
    scope.postMessage({ type: 'frame', timeMs: performance.timeOrigin + performance.now(), seq: lastSeq, marker });
  });
  created.ready.then(
    () => {
      created.setDebugShapes([markerShape(message.marker)]);
      scope.postMessage({ type: 'ready', backend: created.backend });
    },
    (error: unknown) => scope.postMessage({ type: 'error', message: String(error) }),
  );
}

scope.onmessage = ({ data }) => {
  if (data.type === 'start') {
    start(data);
    return;
  }
  if (data.type === 'resize') {
    size = { widthPx: data.widthPx, heightPx: data.heightPx };
    pixelRatio = data.pixelRatio;
    notifySize?.();
    return;
  }
  if (!globe) return;
  lastSeq = data.seq;
  const point = { xPx: data.xPx, yPx: data.yPx };
  // The same navigation as @vibeglobe/controls: drag keeps the grabbed point under the pointer, the wheel zooms at it.
  if (data.type === 'wheel') globe.navigation.zoomAt(point, data.deltaZoom);
  else if (data.kind === 'down') anchor = globe.navigation.grab(point);
  else if (data.kind === 'up') anchor = undefined;
  else if (anchor) globe.navigation.dragTo(anchor, point);
};
