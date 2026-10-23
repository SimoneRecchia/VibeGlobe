import { createControls } from '@vibeglobe/controls';
import {
  createGlobe,
  type CameraState,
  type Globe,
  type GlobeError,
  type GlobeEvents,
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
import { GLOBE_KEY } from './context.js';
import {
  changedView,
  globeOptions,
  watchClicks,
  type GlobeClickEvent,
  type GlobeConfig,
  type GlobeExtraOptions,
} from './globe-config.js';

const FILL = 'position:absolute;inset:0';

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
    watch(view, (next) => {
      const changed = changedView(engine.camera, next);
      if (changed) engine.jumpTo(changed);
    }),
  ];
}

/**
 * The globe component. On the server and before mount it renders only its `placeholder` slot; the engine starts in
 * `onMounted`, so importing and server-rendering it never touches the browser or the GPU. Camera props update the
 * running engine in place (`jumpTo`), and so does `viewMode` (`setViewMode`); the other props configure the engine when it starts. The default slot renders
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
    expose({ globe });
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
      stops = startGlobe(element, { ...props, view: view() }, globe, ready, emit, view, () => props.viewMode);
    });

    onBeforeUnmount(() => {
      for (const stop of stops) stop();
      stops = [];
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
