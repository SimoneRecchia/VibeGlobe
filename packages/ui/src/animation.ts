// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Short camera animations of the controls (a zoom step, a turn to north), through the engine's public `jumpTo`, one
 * step per drawn frame on the engine clock (`Globe.timeMs`, whose steps the engine caps at 100 ms: ADR 0009), so a slow
 * frame never turns into a jump. A new target restarts from the current values, so repeated presses chain without a
 * jump; user input on the map cancels the animation. With reduced motion the camera moves in one step.
 */
import type { Globe } from '@vibeglobe/core';

/** What a tween animates; fields left out stay as they are. */
export interface TweenTarget {
  readonly zoom?: number;
  readonly headingDeg?: number;
}

/** Duration of a control's animation. */
export const TWEEN_DURATION_MS = 300;

/** Smoothstep: its speed peaks at 1.5 times the mean, so slow frames show no big step. */
const ease = (t: number): number => t * t * (3 - 2 * t);

/** The signed shortest turn from `fromDeg` to `toDeg`, in [-180, 180). */
function shortestTurnDeg(fromDeg: number, toDeg: number): number {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

/** Animates the camera of one globe towards a target. */
export class CameraTween {
  readonly #globe: Globe;
  readonly #reducedMotion: () => boolean;
  #stopFrames: (() => void) | undefined;
  #startMs = 0;
  #from = { zoom: 0, headingDeg: 0 };
  #to: TweenTarget = {};
  #stopInput: (() => void) | undefined;

  /**
   * @param globe - The engine instance.
   * @param inputElement - Where user input cancels a running animation (the map container).
   * @param reducedMotion - Whether the system currently asks for reduced motion.
   */
  constructor(globe: Globe, inputElement: HTMLElement, reducedMotion: () => boolean) {
    this.#globe = globe;
    this.#reducedMotion = reducedMotion;
    // Input on the map cancels; presses on the controls themselves chain instead.
    const cancel = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest('.vg-ui') !== null)) this.cancel();
    };
    const options = { passive: true, capture: true };
    inputElement.addEventListener('pointerdown', cancel, options);
    inputElement.addEventListener('wheel', cancel, options);
    this.#stopInput = () => {
      inputElement.removeEventListener('pointerdown', cancel, options);
      inputElement.removeEventListener('wheel', cancel, options);
    };
  }

  /** The target of the running animation, or undefined when none runs. */
  get target(): TweenTarget | undefined {
    return this.#stopFrames === undefined ? undefined : this.#to;
  }

  /** Starts (or retargets) an animation to `target` from the camera's current values. */
  to(target: TweenTarget): void {
    const camera = this.#globe.camera;
    this.cancel();
    if (this.#reducedMotion()) {
      this.#globe.jumpTo(target);
      return;
    }
    this.#from = { zoom: camera.zoom, headingDeg: camera.headingDeg };
    this.#to = target;
    this.#startMs = this.#globe.timeMs;
    this.#stopFrames = this.#globe.on('frame', this.#step);
    this.#globe.requestRender();
  }

  /** Stops the running animation where it is. */
  cancel(): void {
    this.#stopFrames?.();
    this.#stopFrames = undefined;
  }

  /** Stops and releases the input listeners. */
  destroy(): void {
    this.cancel();
    this.#stopInput?.();
    this.#stopInput = undefined;
  }

  /** Applies the value for the engine time of the frame just drawn; the jump asks for the next frame. */
  readonly #step = (): void => {
    const t = Math.min(1, Math.max(0, (this.#globe.timeMs - this.#startMs) / TWEEN_DURATION_MS));
    if (t >= 1) this.cancel();
    const k = ease(t);
    const { zoom, headingDeg } = this.#to;
    this.#globe.jumpTo({
      ...(zoom === undefined ? {} : { zoom: this.#from.zoom + (zoom - this.#from.zoom) * k }),
      ...(headingDeg === undefined
        ? {}
        : { headingDeg: this.#from.headingDeg + shortestTurnDeg(this.#from.headingDeg, headingDeg) * k }),
    });
  };
}
