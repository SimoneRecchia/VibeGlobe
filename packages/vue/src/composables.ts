import type { CameraState, Globe } from '@vibeglobe/core';
import {
  inject,
  onScopeDispose,
  readonly,
  shallowReactive,
  shallowRef,
  watch,
  type DeepReadonly,
  type Ref,
  type ShallowRef,
} from 'vue';
import { GLOBE_KEY } from './context.js';

/**
 * The engine of the enclosing globe component: undefined on the server, before the engine starts and after it
 * unmounts. Call it in a component rendered inside the globe component's default slot.
 */
export function useGlobe(): Readonly<ShallowRef<Globe | undefined>> {
  return inject(GLOBE_KEY, shallowRef(undefined));
}

/**
 * Calls `subscribe` with each engine the ref takes, and the function it returns when the engine changes or the
 * calling scope ends.
 */
function onEachGlobe(globe: Readonly<Ref<Globe | undefined>>, subscribe: (engine: Globe) => () => void): void {
  let stop: (() => void) | undefined;
  watch(
    globe,
    (engine) => {
      stop?.();
      stop = engine ? subscribe(engine) : undefined;
    },
    { immediate: true },
  );
  onScopeDispose(() => stop?.());
}

/**
 * The camera of a globe as a reactive object that follows every move, including the user's navigation. The engine
 * reports the camera at most once per frame and the object is updated in place, so following it allocates nothing.
 * @param globe - the engine; by default that of the enclosing globe component ({@link useGlobe})
 */
export function useCamera(globe: Readonly<Ref<Globe | undefined>> = useGlobe()): DeepReadonly<CameraState> {
  const camera = shallowReactive({
    longitudeDeg: 0,
    latitudeDeg: 0,
    zoom: 0,
    altitudeMeters: 0,
    headingDeg: 0,
    tiltDeg: 0,
    rollDeg: 0,
    rangeMeters: 0,
  });
  const copy = (from: CameraState): void => {
    camera.longitudeDeg = from.longitudeDeg;
    camera.latitudeDeg = from.latitudeDeg;
    camera.zoom = from.zoom;
    camera.altitudeMeters = from.altitudeMeters;
    camera.headingDeg = from.headingDeg;
    camera.tiltDeg = from.tiltDeg;
    camera.rollDeg = from.rollDeg;
    camera.rangeMeters = from.rangeMeters;
  };
  onEachGlobe(globe, (engine) => {
    copy(engine.camera);
    return engine.on('camera-change', copy);
  });
  return readonly(camera);
}

/**
 * Whether the globe is still loading its view: true from the start and after each camera move, false once the engine
 * has drawn everything the view needs and gone idle.
 * @param globe - the engine; by default that of the enclosing globe component ({@link useGlobe})
 */
export function useLoading(globe: Readonly<Ref<Globe | undefined>> = useGlobe()): Readonly<Ref<boolean>> {
  const loading = shallowRef(true);
  onEachGlobe(globe, (engine) => {
    loading.value = true;
    const stops = [
      engine.on('camera-change', () => (loading.value = true)),
      engine.on('idle', () => (loading.value = false)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  });
  return readonly(loading);
}

/** The view modes of PLAN.md: the automatic choice by zoom, the flat map and the globe. */
export type ViewMode = 'auto' | '2d' | '3d';

/**
 * The globe's view mode. Stub until the engine has view modes (F161, M5; docs/parallel-tracks.md): it is always
 * `'3d'`, the only mode the engine draws today.
 * @param globe - the engine; by default that of the enclosing globe component ({@link useGlobe})
 */
export function useViewMode(globe: Readonly<Ref<Globe | undefined>> = useGlobe()): Readonly<Ref<ViewMode>> {
  void globe;
  return readonly(shallowRef<ViewMode>('3d'));
}
