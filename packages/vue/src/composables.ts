// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { NavigationControls } from '@vibeglobe/controls';
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
import { CONTROLS_KEY, GLOBE_KEY } from './context.js';

/**
 * The engine of the enclosing globe component: undefined on the server, before the engine starts and after it
 * unmounts. Call it in a component rendered inside the globe component's default slot.
 */
export function useGlobe(): Readonly<ShallowRef<Globe | undefined>> {
  return inject(GLOBE_KEY, shallowRef(undefined));
}

/**
 * Calls `subscribe` with each value the ref takes (an engine, controls), and the function it returns when the value changes or the
 * calling scope ends.
 */
function onEachValue<T extends object>(
  source: Readonly<Ref<T | undefined>>,
  subscribe: (value: T) => () => void,
): void {
  let stop: (() => void) | undefined;
  watch(
    source,
    (value) => {
      stop?.();
      stop = value ? subscribe(value) : undefined;
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
  // The engine's camera states are plain objects of exactly these fields.
  const copy = (from: CameraState): void => void Object.assign(camera, from);
  onEachValue(globe, (engine) => {
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
  onEachValue(globe, (engine) => {
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
  onEachValue(globe, (engine) => {
    mode.value = engine.viewMode;
    return engine.on('view-mode-change', ({ mode: next }) => (mode.value = next));
  });
  return readonly(mode);
}

/**
 * The navigation controls of the enclosing globe component (its `controls` prop): undefined on the server, before the
 * engine starts, after it unmounts and when the prop is false. Call it in a component rendered inside the globe
 * component's default slot; outside, read the component's exposed `controls`.
 */
export function useControls(): Readonly<ShallowRef<NavigationControls | undefined>> {
  return inject(CONTROLS_KEY, shallowRef(undefined));
}

/**
 * Whether the view may tilt now (F625): false while the controls' tilt policy keeps it flat, beyond its lock
 * distance, so an application's 3D button can be disabled; true without controls or without a policy. Follows
 * `NavigationControls.onTiltAvailabilityChange`.
 * @param controls - the controls; by default those of the enclosing globe component ({@link useControls})
 */
export function useTiltAvailable(
  controls: Readonly<Ref<NavigationControls | undefined>> = useControls(),
): Readonly<Ref<boolean>> {
  const available = shallowRef(true);
  watch(
    controls,
    (current) => {
      if (current === undefined) available.value = true;
    },
    { immediate: true },
  );
  onEachValue(controls, (current) => {
    available.value = current.tiltAvailable;
    return current.onTiltAvailabilityChange((next) => (available.value = next));
  });
  return readonly(available);
}
