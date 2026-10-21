// Page side of the F065 experiment (`?experiment=offscreen&render=main|worker`): the same instrumentation for rendering
// on the main thread and in a worker. It records when each input event happened and when each frame was submitted,
// keeps a DOM overlay framing the scene's marker, and can add synthetic main-thread load (ADR 0011 criteria).
import type { BackendName, Globe, ViewInit } from '@vibeglobe/core';
import type { BackendChoice } from '@vibeglobe/renderer';
import { markerShape } from './marker.js';
import { MARKER, type FromWorker, type ToWorker } from './protocol.js';

/** A recorded frame: submission time (ms since the epoch) and the last input event it includes. */
interface FrameRecord {
  readonly timeMs: number;
  readonly seq: number;
}

/** What the measurement script reads from the page (`window.vibeglobeRenderExperiment`). */
interface RenderExperiment {
  readonly mode: 'main' | 'worker';
  readonly ready: Promise<BackendName | undefined>;
  readonly frames: FrameRecord[];
  /** Input events: sequence number and the time the browser received the event (ms since the epoch). */
  readonly inputs: { readonly seq: number; readonly timeMs: number }[];
  /** Turns the synthetic main-thread load (a 30 ms task every 100 ms) on or off. */
  setLoad(on: boolean): void;
  /** Clears the records. */
  reset(): void;
}

declare global {
  interface Window {
    vibeglobeRenderExperiment?: RenderExperiment;
  }
}

const OVERLAY_SIZE_PX = 28;
const WHEEL_PIXELS_PER_LEVEL = 300;
const LOAD_TASK_MS = 30;
const LOAD_PERIOD_MS = 100;

/** Records input events and drives the overlay; shared by both modes. */
function instrument(app: HTMLElement, mode: 'main' | 'worker', ready: Promise<BackendName | undefined>) {
  const frames: FrameRecord[] = [];
  const inputs: { seq: number; timeMs: number }[] = [];
  let seq = 0;
  const record = (event: Event): void => {
    seq++;
    inputs.push({ seq, timeMs: performance.timeOrigin + event.timeStamp });
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
    window.addEventListener(type, record, { capture: true, passive: true });
  }
  const overlay = document.createElement('div');
  overlay.id = 'marker-overlay';
  overlay.style.cssText = `position:absolute;left:0;top:0;width:${OVERLAY_SIZE_PX}px;height:${OVERLAY_SIZE_PX}px;box-sizing:border-box;border:3px solid #00ff00;pointer-events:none;`;
  app.append(overlay);
  let load: number | undefined;
  const experiment: RenderExperiment = {
    mode,
    ready,
    frames,
    inputs,
    setLoad(on) {
      if (load !== undefined) clearInterval(load);
      load = on
        ? window.setInterval(() => {
            const end = performance.now() + LOAD_TASK_MS;
            while (performance.now() < end) {
              // Busy main thread, as a heavy host application would be.
            }
          }, LOAD_PERIOD_MS)
        : undefined;
    },
    reset() {
      frames.length = 0;
      inputs.length = 0;
    },
  };
  window.vibeglobeRenderExperiment = experiment;
  return {
    currentSeq: () => seq,
    frame(timeMs: number, frameSeq: number, marker: { xPx: number; yPx: number } | undefined): void {
      frames.push({ timeMs, seq: frameSeq });
      overlay.style.visibility = marker ? 'visible' : 'hidden';
      if (marker) {
        const half = OVERLAY_SIZE_PX / 2;
        overlay.style.transform = `translate(${marker.xPx - half}px, ${marker.yPx - half}px)`;
      }
    },
  };
}

/** Main-thread rendering: the playground's own globe, instrumented. */
export function instrumentMainThread(globe: Globe, app: HTMLElement): void {
  const probe = instrument(
    app,
    'main',
    globe.ready.then(() => globe.backend),
  );
  void globe.ready.then(() => globe.setDebugShapes([markerShape(MARKER)]));
  globe.on('frame', () => {
    // The overlay moves in the same task as the frame, so both reach the screen together.
    probe.frame(performance.timeOrigin + performance.now(), probe.currentSeq(), globe.geoToScreen(MARKER));
  });
}

/** Worker rendering: the canvas goes to a worker, and the page forwards size and input. */
export function startWorkerRendering(
  app: HTMLElement,
  canvas: HTMLCanvasElement,
  options: { backend: BackendChoice; view: ViewInit; imageryUrl: string },
): void {
  let resolveReady: (backend: BackendName | undefined) => void = () => undefined;
  const probe = instrument(app, 'worker', new Promise((resolve) => (resolveReady = resolve)));
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'vibeglobe-render' });
  const post = (message: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(message, transfer);
  worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
    if (data.type === 'frame') probe.frame(data.timeMs, data.seq, data.marker);
    else if (data.type === 'ready') resolveReady(data.backend);
    else console.error(`Rendering worker: ${data.message}`);
  };
  const offscreen = canvas.transferControlToOffscreen();
  post(
    {
      type: 'start',
      canvas: offscreen,
      widthPx: canvas.clientWidth,
      heightPx: canvas.clientHeight,
      pixelRatio: devicePixelRatio,
      backend: options.backend,
      view: options.view,
      imageryUrl: new URL(options.imageryUrl, location.href).href,
      marker: MARKER,
    },
    [offscreen],
  );
  new ResizeObserver(() =>
    post({ type: 'resize', widthPx: canvas.clientWidth, heightPx: canvas.clientHeight, pixelRatio: devicePixelRatio }),
  ).observe(canvas);
  const local = (event: MouseEvent): { xPx: number; yPx: number } => {
    const rect = canvas.getBoundingClientRect();
    return { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
  };
  const forward = (kind: 'down' | 'move' | 'up') => (event: PointerEvent) => {
    if (kind === 'down' && event.button !== 0) return;
    if (kind === 'down') canvas.setPointerCapture(event.pointerId);
    post({ type: 'pointer', kind, ...local(event), seq: probe.currentSeq() });
  };
  canvas.addEventListener('pointerdown', forward('down'));
  canvas.addEventListener('pointermove', forward('move'));
  canvas.addEventListener('pointerup', forward('up'));
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      post({
        type: 'wheel',
        ...local(event),
        deltaZoom: -event.deltaY / WHEEL_PIXELS_PER_LEVEL,
        seq: probe.currentSeq(),
      });
    },
    { passive: false },
  );
}
