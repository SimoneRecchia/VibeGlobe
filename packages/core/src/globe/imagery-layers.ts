import type { StackLayer } from '../imagery/imagery-draws.js';
import {
  applyChanges,
  sourceInfo,
  validStack,
  type ImageryLayerChanges,
  type ImageryLayerInput,
  type ImageryLayers,
  type ImageryLayerState,
} from '../imagery/imagery-stack.js';
import { GlobeError } from './errors.js';
import type { ImageryRuntime } from './imagery-runtime.js';

/** What holds a globe's imagery runtime (its `SurfaceFrame`). */
interface ImageryHolder {
  readonly imagery?: ImageryRuntime | undefined;
  /** The selection reads the layers' tile sizes and levels again (a layer was added or removed). */
  imageryChanged(): void;
}

/**
 * The controllers of the globes' imagery, kept outside the per-frame classes: a field more on those changes how V8 lays
 * them out, and their per-frame writes start to allocate (F064).
 */
const controllers = new WeakMap<ImageryHolder, ImageryLayersController>();

/** `Globe.imageryLayers` of the globe whose imagery `frame` holds. */
export function imageryLayersOf(frame: ImageryHolder): ImageryLayers {
  let controller = controllers.get(frame);
  if (!controller) {
    controller = new ImageryLayersController(frame);
    controllers.set(frame, controller);
  }
  return controller;
}

/**
 * `Globe.imageryLayers` (F243–F246): reads and changes the imagery stack in place; every change asks for a frame, which
 * shows it. Before the imagery starts (and without imagery) the stack is empty.
 */
class ImageryLayersController implements ImageryLayers {
  /** `frame` holds the imagery runtime once it starts. */
  constructor(private readonly frame: ImageryHolder) {}

  private stack(): StackLayer[] | undefined {
    return this.frame.imagery?.stack;
  }

  private changed(): void {
    this.frame.imagery?.stackChanged();
  }

  /** See {@link ImageryLayers.list}. */
  list(): readonly ImageryLayerState[] {
    return (this.stack() ?? []).map(({ entry }) => ({
      id: entry.id,
      opacity: entry.opacity,
      visible: entry.visible,
      blend: entry.blend,
      sources: entry.sources.map(sourceInfo),
    }));
  }

  /** See {@link ImageryLayers.set}. */
  set(id: string, changes: ImageryLayerChanges): void {
    const layer = this.find(id);
    try {
      applyChanges(layer.entry, changes);
    } catch (error) {
      throw new GlobeError('invalid-option', error instanceof Error ? error.message : String(error));
    }
    this.changed();
  }

  /** See {@link ImageryLayers.move}. */
  move(id: string, index: number): void {
    const stack = this.stack() ?? [];
    const layer = this.find(id);
    stack.splice(stack.indexOf(layer), 1);
    const to = Math.max(0, Math.min(stack.length, Math.round(index)));
    stack.splice(to, 0, layer);
    this.changed();
    this.frame.imagery?.layersChanged();
  }

  /** See {@link ImageryLayers.add}. */
  add(input: ImageryLayerInput, index?: number): void {
    const imagery = this.frame.imagery;
    if (!imagery)
      throw new GlobeError('invalid-option', 'Imagery layers can be added once the globe has started with workers');
    let problem = '';
    const [entry] = validStack([input], (message) => (problem = message));
    if (!entry) throw new GlobeError('invalid-option', problem || 'The imagery layer has no source');
    if (imagery.stack.some((layer) => layer.entry.id === entry.id))
      throw new GlobeError('invalid-option', `An imagery layer already has the id "${entry.id}"`);
    const taken = entry.sources.find((source) => imagery.layers.some((layer) => layer.source.id === source.id));
    if (taken) throw new GlobeError('invalid-option', `An imagery source already has the id "${taken.id}"`);
    const chain = entry.sources.map((source) => imagery.newLayer(source, imagery.nextIndex++, -1));
    imagery.layers.push(...chain);
    const at = Math.max(0, Math.min(imagery.stack.length, Math.round(index ?? imagery.stack.length)));
    imagery.stack.splice(at, 0, { entry, chain });
    this.restacked(imagery);
  }

  /** See {@link ImageryLayers.remove}. */
  remove(id: string): boolean {
    const imagery = this.frame.imagery;
    const layer = imagery?.stack.find((candidate) => candidate.entry.id === id);
    if (!imagery || !layer) return false;
    imagery.stack.splice(imagery.stack.indexOf(layer), 1);
    for (const source of layer.chain) imagery.dropLayer(source);
    this.restacked(imagery);
    return true;
  }

  /** After a layer was added or removed: the credits, tile sizes and levels again, and a frame. */
  private restacked(imagery: ImageryRuntime): void {
    imagery.credits = imagery.creditsOf();
    imagery.setPixelRatio(imagery.pixelRatio);
    this.frame.imageryChanged();
    this.changed();
    imagery.layersChanged();
  }

  private find(id: string): StackLayer {
    const layer = this.stack()?.find((candidate) => candidate.entry.id === id);
    if (!layer) throw new GlobeError('invalid-option', `No imagery layer has the id "${id}"`);
    return layer;
  }
}
