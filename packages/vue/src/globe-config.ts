// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ControlsOptions, NavigationControls } from '@vibeglobe/controls';
import type { Globe, GlobeOptions, ImagerySource, ViewInit } from '@vibeglobe/core';
import { createRenderer, type BackendChoice, type RendererOptions } from '@vibeglobe/renderer';
import { createWorkers } from '@vibeglobe/worker';

/** Engine options the component passes through unchanged (everything it does not build itself). */
export type GlobeExtraOptions = Omit<
  GlobeOptions,
  'container' | 'renderer' | 'controls' | 'baseImageryUrl' | 'view' | 'imagery' | 'workers'
>;

/** What the component needs to start an engine: its props, resolved. */
export interface GlobeConfig {
  readonly baseImageryUrl: string;
  readonly backend: BackendChoice;
  /** Navigation: off (false), the defaults (true) or these options (F625's tilt policy, the navigation mode…). */
  readonly controls: boolean | ControlsOptions;
  /** The glTF loader for models and model sets (F627), passed to the renderer. */
  readonly gltf?: RendererOptions['gltf'] | undefined;
  readonly view: ViewInit;
  readonly imagery?: readonly ImagerySource[] | undefined;
  readonly workers?: GlobeOptions['workers'];
  readonly options?: GlobeExtraOptions | undefined;
}

/**
 * The engine options for a configuration: a renderer in the container, the default navigation controls, and the
 * engine's bundled workers when imagery sources need decoding and the host passes none.
 */
export function globeOptions(
  container: HTMLElement,
  config: GlobeConfig,
  controls: NavigationControls | undefined,
): GlobeOptions {
  const imagery = config.imagery ?? [];
  const workers = config.workers ?? (imagery.length > 0 ? createWorkers() : undefined);
  return {
    ...config.options,
    container,
    renderer: createRenderer({ backend: config.backend, ...(config.gltf ? { gltf: config.gltf } : {}) }),
    ...(controls ? { controls } : {}),
    baseImageryUrl: config.baseImageryUrl,
    view: config.view,
    ...(imagery.length > 0 ? { imagery } : {}),
    ...(workers ? { workers } : {}),
  };
}

/**
 * The view fields that differ from the camera by more than rounding, or undefined when none do. With the `previous`
 * props, only fields whose prop changed count: the others stay where the user navigated (KB-146).
 */
export function changedView(camera: Globe['camera'], view: ViewInit, previous?: ViewInit): ViewInit | undefined {
  const changed: Record<string, number> = {};
  const fields = [
    ['longitudeDeg', camera.longitudeDeg],
    ['latitudeDeg', camera.latitudeDeg],
    ['zoom', camera.zoom],
    ['headingDeg', camera.headingDeg],
    ['tiltDeg', camera.tiltDeg],
  ] as const;
  for (const [field, current] of fields) {
    const wanted = view[field];
    if (previous !== undefined && previous[field] === wanted) continue;
    if (wanted !== undefined && Math.abs(wanted - current) > 1e-9) changed[field] = wanted;
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}

/** The controls a configuration asks for: none for false, the defaults for true, else these options. */
export function controlsOptions(controls: boolean | ControlsOptions): ControlsOptions | undefined | false {
  if (controls === false) return false;
  return controls === true ? undefined : controls;
}
