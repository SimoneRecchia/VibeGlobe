// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Controls, ControlsFactory, Globe } from './types.js';

/** The input plug-in of a globe, attached to the renderer's input element and again when a recovery replaces it. */
export class ControlsSlot {
  controls: Controls | undefined;
  private element: unknown;

  /** Attaches the controls to `element`, unless they are already attached to it (KB-020), and connects the globe. */
  attach(factory: ControlsFactory | undefined, element: unknown, globe: Globe): void {
    if (!factory || (this.controls && element === this.element)) return;
    this.controls?.destroy();
    this.element = element;
    this.controls = factory(element, globe.navigation);
    factory.connect?.(globe);
  }

  /** Detaches the controls; the element is dropped too, as the canvas holds its GPU context (KB-053). */
  destroy(): void {
    this.controls?.destroy();
    this.element = undefined;
  }
}
