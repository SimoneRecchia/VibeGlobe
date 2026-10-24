// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
    eyeLongitudeDeg: 0,
    eyeLatitudeDeg: 0,
    groundHeightMeters: 0,
    viewMode: 'auto' as CameraState['viewMode'],
    chosenTiltDeg: 0,
    chosenHeadingDeg: 0,
    morphFactor: 0,
    reliefFactor: 0,
    phase: 'globe' as CameraState['phase'],
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
    camera.eyeLongitudeDeg = from.eyeLongitudeDeg;
    camera.eyeLatitudeDeg = from.eyeLatitudeDeg;
    camera.groundHeightMeters = from.groundHeightMeters;
    camera.viewMode = from.viewMode;
    camera.chosenTiltDeg = from.chosenTiltDeg;
    camera.chosenHeadingDeg = from.chosenHeadingDeg;
    camera.morphFactor = from.morphFactor;
    camera.reliefFactor = from.reliefFactor;
    camera.phase = from.phase;
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

/** The engine's view modes: the zoom curves drive the tilt ('auto'), it stays 0° ('2d'), or the user chose it ('manual'). */
export type ViewMode = CameraState['viewMode'];

/**
 * The globe's view mode, following `Globe.setViewMode`, the 3D choice and a tilt by hand (both report 'manual').
 * @param globe - the engine; by default that of the enclosing globe component ({@link useGlobe})
 */
export function useViewMode(globe: Readonly<Ref<Globe | undefined>> = useGlobe()): Readonly<Ref<ViewMode>> {
  const mode = shallowRef<ViewMode>('auto');
  onEachGlobe(globe, (engine) => {
    mode.value = engine.viewMode;
    return engine.on('view-mode-change', ({ mode: next }) => (mode.value = next));
  });
  return readonly(mode);
}
