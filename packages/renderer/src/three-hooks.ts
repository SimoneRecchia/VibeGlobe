import type { Mesh, WebGPURenderer } from 'three/webgpu';

/**
 * three.js 0.186 starts its own requestAnimationFrame loop in init() and keeps it running forever, which defeats
 * render on demand and allocates every display frame. The engine owns the frame loop, so this stops the internal loop
 * and returns its bookkeeping, to run at the start of each engine render: the counter reset, and the node frame's id,
 * which nodes updated once per frame key on. The node frame's clock (`time`, `deltaTime`) is not advanced: no engine
 * material reads it, and updating it stores three doubles, three heap numbers per frame (ADR 0018). These are private
 * members of the pinned version (ADR 0010).
 */
export function stopInternalLoop(renderer: WebGPURenderer): () => void {
  const internals = renderer as unknown as {
    _animation?: { stop(): void };
    _nodes?: { nodeFrame: { frameId: number } };
  };
  internals._animation?.stop();
  return () => {
    if (renderer.info.autoReset) renderer.info.reset();
    const nodeFrame = internals._nodes?.nodeFrame;
    if (nodeFrame) nodeFrame.frameId++;
  };
}

/** Counts any automatic matrix update three.js performs on a mesh; the engine expects none (F052). */
export function countMatrixUpdates(mesh: Mesh, onUpdate: () => void): void {
  const updateMatrix = mesh.updateMatrix.bind(mesh);
  const updateMatrixWorld = mesh.updateMatrixWorld.bind(mesh);
  mesh.updateMatrix = () => {
    onUpdate();
    updateMatrix();
  };
  mesh.updateMatrixWorld = (force?: boolean) => {
    onUpdate();
    updateMatrixWorld(force);
  };
}

/**
 * Counts how often the drawn render pipeline changes within a frame (F103). The backend's `draw` is wrapped with its
 * two fixed arguments, so counting allocates nothing per draw (F064).
 */
export class PipelineSwitches {
  /** Changes since the last {@link PipelineSwitches.begin}: the last frame's once it is drawn. */
  count = 0;
  private last: unknown;

  constructor(backend: unknown) {
    const target = backend as { draw?: (renderObject: { pipeline: unknown }, info: unknown) => unknown };
    const draw = target.draw;
    if (typeof draw !== 'function') return;
    target.draw = (renderObject, info) => {
      if (renderObject.pipeline !== this.last) {
        this.count++;
        this.last = renderObject.pipeline;
      }
      return draw.call(backend, renderObject, info);
    };
  }

  /** Starts counting a frame. */
  begin(): void {
    this.count = 0;
    this.last = undefined;
  }
}

/** Counts the calls of an object's method, if it has one. */
export function countCalls(object: unknown, name: string, onCall: () => void): void {
  const target = object as Record<string, unknown>;
  const method = target[name];
  if (typeof method !== 'function') return;
  target[name] = (...args: unknown[]): unknown => {
    onCall();
    return (method as (...args: unknown[]) => unknown).apply(object, args);
  };
}

/** A fresh canvas filling its container, carrying over the identity and accessibility attributes of `previous`. */
export function createCanvas(document: Document, previous: HTMLCanvasElement | undefined): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  for (const name of ['id', 'class', 'aria-label', 'role']) {
    const value = previous?.getAttribute(name);
    if (value) canvas.setAttribute(name, value);
  }
  fillContainer(canvas);
  canvas.style.touchAction = 'none';
  canvas.tabIndex = 0;
  return canvas;
}

/**
 * Makes a canvas fill its container's content box, which is the engine's viewport (KB-048): without a CSS size a canvas
 * is shown at its backing size, the viewport times the pixel ratio (KB-055).
 */
export function fillContainer(canvas: HTMLCanvasElement): void {
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}

/**
 * Reads back the GPU time of the frames rendered so far (timestamp queries resolve a few frames late) and passes the
 * last frame's to `store`; allocates promises, so only for benchmarks. Devices without timestamp queries report nothing.
 */
export function readGpuTime(renderer: WebGPURenderer, store: (ms: number) => void): void {
  void renderer.resolveTimestampsAsync('render').then((ms) => {
    if (typeof ms === 'number' && ms > 0) store(ms);
  });
}
