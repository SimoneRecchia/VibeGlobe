import { createControls } from '@vibeglobe/controls';
import {
  createGlobe,
  type CameraState,
  type Globe,
  type GlobeError,
  type GlobeEvents,
  type ImageryLayerChanges,
  type ImagerySource,
  type ViewInit,
  type WorkerEndpointFactory,
} from '@vibeglobe/core';
import type { BackendChoice } from '@vibeglobe/renderer';
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  provide,
  shallowRef,
  watch,
  type PropType,
  type SlotsType,
  type ShallowRef,
  type VNode,
} from 'vue';
import { EXTRAS_KEY, GLOBE_KEY } from './context.js';
import { globeExtras } from './extras.js';
import {
  changedView,
  globeOptions,
  watchClicks,
  type GlobeClickEvent,
  type GlobeConfig,
  type GlobeExtraOptions,
} from './globe-config.js';
import { watchQualityPreset, type QualityPresetChoice } from './quality.js';

const FILL = 'position:absolute;inset:0';

/** The look of one imagery layer, by id, as the `layers` prop takes it; the array's order is the layers' order. */
export interface LayerLook extends ImageryLayerChanges {
  readonly id: string;
}

/** The network modes of `@vibeglobe/offline` (F271). */
export type NetworkMode = 'online' | 'offline' | 'hybrid';

/** The part of an offline engine (`createOffline()` of `@vibeglobe/offline`) the `networkMode` prop drives. */
export interface NetworkModeTarget {
  readonly mode: NetworkMode;
  setMode(mode: NetworkMode): void;
}

/** Applies layer looks and order to the engine's imagery layers; unknown ids are skipped. */
function applyLayers(engine: Globe, looks: readonly LayerLook[] | undefined): void {
  if (looks === undefined) return;
  const known = new Set(engine.imageryLayers.list().map((layer) => layer.id));
  const present = looks.filter((look) => known.has(look.id));
  for (const [index, { id, ...changes }] of present.entries()) {
    engine.imageryLayers.set(id, changes);
    const now = engine.imageryLayers.list().findIndex((layer) => layer.id === id);
    if (now !== index) engine.imageryLayers.move(id, index);
  }
}

/** The choices of the 2D / 3D / Auto toggle, as `Globe.setViewMode` takes them. */
export type ToggleMode = Parameters<Globe['setViewMode']>[0];

/** The component's events, as `emit` takes them. */
interface GlobeEmit {
  (event: 'ready', payload: GlobeEvents['ready']): void;
  (event: 'load', payload: GlobeEvents['idle']): void;
  (event: 'camera-change', camera: CameraState): void;
  (event: 'globe-click', click: GlobeClickEvent): void;
  (event: 'error', error: GlobeError): void;
}

/** Starts the engine in the element and forwards its events; returns the functions that stop the forwarding. */
function startGlobe(
  element: HTMLElement,
  config: GlobeConfig,
  globe: ShallowRef<Globe | undefined>,
  ready: ShallowRef<boolean>,
  emit: GlobeEmit,
  view: () => ViewInit,
  viewMode: () => ToggleMode | undefined,
  live: {
    layers: () => readonly LayerLook[] | undefined;
    network: () => readonly [NetworkModeTarget | undefined, NetworkMode | undefined];
    quality: () => QualityPresetChoice | undefined;
  },
): (() => void)[] {
  const controls = config.controls ? createControls() : undefined;
  const engine = createGlobe(globeOptions(element, config, controls));
  // Rotation, tilt and the engine clock of the controls need the globe (the M6 input track's hook 5).
  controls?.connect(engine);
  globe.value = engine;
  const applyMode = (mode: ToggleMode | undefined): void => {
    if (mode && engine.viewMode !== (mode === '3d' ? 'manual' : mode)) engine.setViewMode(mode);
  };
  applyMode(viewMode());
  // The engine lists its imagery layers once its renderer has started.
  void engine.ready.then(() => applyLayers(engine, live.layers())).catch(() => undefined);
  const applyNetwork = ([offline, mode]: readonly [NetworkModeTarget | undefined, NetworkMode | undefined]): void => {
    if (offline && mode && offline.mode !== mode) offline.setMode(mode);
  };
  applyNetwork(live.network());
  let loaded = false;
  // A failed start is reported through the `error` event; the promise must not reject unhandled.
  engine.ready.catch(() => undefined);
  return [
    engine.on('ready', (payload) => {
      ready.value = true;
      emit('ready', payload);
    }),
    engine.on('idle', (payload) => {
      if (loaded || !ready.value) return;
      loaded = true;
      emit('load', payload);
    }),
    engine.on('camera-change', (camera) => emit('camera-change', camera)),
    engine.on('error', (error) => emit('error', error)),
    watchClicks(element, engine, (click) => emit('globe-click', click)),
    watch(viewMode, applyMode),
    watch(live.layers, (looks) => applyLayers(engine, looks), { deep: true }),
    watch(live.network, applyNetwork),
    watchQualityPreset(engine, live.quality),
    watch(view, (next) => {
      const changed = changedView(engine.camera, next);
      if (changed) engine.jumpTo(changed);
    }),
  ];
}

/**
 * The globe component. On the server and before mount it renders only its `placeholder` slot; the engine starts in
 * `onMounted`, so importing and server-rendering it never touches the browser or the GPU. Camera props update the
 * running engine in place (`jumpTo`), and so do `viewMode` (`setViewMode`), `layers`, `networkMode` and `qualityPreset`; the other props configure the engine when it starts. The default slot renders
 * once the engine exists, with the engine available to its components through {@link useGlobe}.
 *
 * Events: `ready` (the engine drew its first frame, with the backend), `load` (the first view finished loading),
 * `camera-change`, `globe-click` (a click with its position on the globe) and `error`.
 */
export const VibeGlobe = defineComponent({
  name: 'VibeGlobe',
  props: {
    /** URL of the base image draped on the whole globe before any tile arrives. */
    baseImageryUrl: { type: String, required: true },
    /** Imagery sources, bottom first. Read when the engine starts. */
    imagery: { type: Array as PropType<readonly ImagerySource[]>, default: undefined },
    /** 'auto' (WebGPU, falling back to WebGL2), 'webgpu' or 'webgl2'. Read when the engine starts. */
    backend: { type: String as PropType<BackendChoice>, default: 'auto' },
    /** Mouse, touch and keyboard navigation. Read when the engine starts. */
    controls: { type: Boolean, default: true },
    /** The workers that decode tiles; by default the engine's bundled workers when imagery is set. */
    workers: { type: Object as PropType<WorkerEndpointFactory>, default: undefined },
    /** Further engine options (resolution scale, memory budgets, logging). Read when the engine starts. */
    options: { type: Object as PropType<GlobeExtraOptions>, default: undefined },
    longitudeDeg: { type: Number, default: undefined },
    latitudeDeg: { type: Number, default: undefined },
    zoom: { type: Number, default: undefined },
    headingDeg: { type: Number, default: undefined },
    tiltDeg: { type: Number, default: undefined },
    /** The 2D / 3D / Auto toggle (F163): changes the running engine's view mode in place; unset keeps the engine's. */
    viewMode: { type: String as PropType<ToggleMode>, default: undefined },
    /**
     * Opacity, visibility, blend mode and order of the imagery layers, by id (F243–F245): changes apply to the running
     * engine in place, keeping every tile already loaded.
     */
    layers: { type: Array as PropType<readonly LayerLook[]>, default: undefined },
    /** The offline engine whose sources the `imagery` prop uses (`createOffline().source(…)`), for `networkMode`. */
    offline: { type: Object as PropType<NetworkModeTarget>, default: undefined },
    /** The network mode of `offline` (F271), changed at runtime with no reload of the engine. */
    networkMode: { type: String as PropType<NetworkMode>, default: undefined },
    /**
     * The quality preset (`@vibeglobe/quality`, F399), with adaptive quality: 'low', 'medium', 'high', 'ultra' or
     * 'auto' (chosen from the device). Changes switch the running engine's preset in place; unset keeps the engine's
     * own settings, and `@vibeglobe/quality` is then never loaded.
     */
    qualityPreset: { type: String as PropType<QualityPresetChoice | undefined>, default: undefined },
  },
  emits: {
    ready: (payload: GlobeEvents['ready']) => typeof payload === 'object',
    load: (payload: GlobeEvents['idle']) => typeof payload === 'object',
    'camera-change': (camera: CameraState) => typeof camera === 'object',
    'globe-click': (event: GlobeClickEvent) => typeof event === 'object',
    error: (error: GlobeError) => typeof error === 'object',
  },
  slots: Object as SlotsType<{ default?: () => VNode[]; placeholder?: () => VNode[] }>,
  setup(props, { emit, slots, expose }) {
    const container = shallowRef<HTMLElement>();
    const globe = shallowRef<Globe>();
    const ready = shallowRef(false);
    provide(GLOBE_KEY, globe);
    const extras = globeExtras(
      () => globe.value,
      () => container.value,
    );
    provide(EXTRAS_KEY, extras);
    expose({ globe, extras });
    const view = (): ViewInit => {
      const fields: Record<string, number> = {};
      for (const key of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const) {
        const value = props[key];
        if (value !== undefined) fields[key] = value;
      }
      return fields;
    };
    let stops: (() => void)[] = [];

    onMounted(() => {
      const element = container.value;
      if (!element) return;
      stops = startGlobe(element, { ...props, view: view() }, globe, ready, emit, view, () => props.viewMode, {
        layers: () => props.layers,
        network: () => [props.offline, props.networkMode] as const,
        quality: () => props.qualityPreset,
      });
    });

    onBeforeUnmount(() => {
      for (const stop of stops) stop();
      stops = [];
      extras.release();
      globe.value?.destroy();
      globe.value = undefined;
    });

    return () =>
      h('div', { class: 'vibeglobe', style: 'position:relative;width:100%;height:100%;overflow:hidden' }, [
        h('div', { ref: container, class: 'vibeglobe-engine', style: FILL }),
        ready.value
          ? null
          : h(
              'div',
              { class: 'vibeglobe-placeholder', 'data-vibeglobe-placeholder': '', style: FILL },
              slots.placeholder?.(),
            ),
        globe.value ? slots.default?.() : null,
      ]);
  },
});
