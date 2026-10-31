// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GestureContext } from './gesture-context.js';

/** Keys of the key map (docs/guides/controls.md): held arrows, +/- presses, N for north, Home, view modes, Escape. */
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const;
const ZOOM_IN = new Set(['+', '=', 'Add']);
const ZOOM_OUT = new Set(['-', '_', 'Subtract']);
const VIEW_MODES: Readonly<Record<string, '2d' | '3d' | 'auto'>> = { '2': '2d', '3': '3d', a: 'auto', A: 'auto' };

/** A key event's fields the key map reads. */
export interface KeyInput {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/**
 * Keyboard navigation while the map has focus (F181, F187, F213): arrows pan, Shift+arrows rotate (Left/Right) and
 * tilt (Up/Down), each with an eased start and stop; + and − zoom one level per press about the screen center,
 * accumulating; N turns to north up; Home flies to the home view; 2, 3 and A pick the 2D, 3D and Auto view modes;
 * Escape cancels a zoom box. Keys with Ctrl, Alt or Meta are left to the browser.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();
  private shift = false;

  constructor(
    private readonly context: GestureContext,
    private readonly onEscape: () => void,
  ) {}

  /** Handles a key press; returns true when the key belongs to the map (the caller prevents its default). */
  keyDown(event: KeyInput): boolean {
    if (!this.context.options.gestures.keyboard || event.ctrlKey || event.altKey || event.metaKey) return false;
    const key = event.key;
    if (key === 'Shift') {
      this.shift = true;
      if (this.held.size > 0) this.retarget();
      return false;
    }
    if (key === 'Escape') {
      this.onEscape();
      return false;
    }
    if ((ARROWS as readonly string[]).includes(key)) {
      if (!this.held.has(key)) this.context.interrupt();
      this.held.add(key);
      this.shift = event.shiftKey;
      this.retarget();
      return true;
    }
    if (event.repeat) return ZOOM_IN.has(key) || ZOOM_OUT.has(key);
    const numpad = event.code === 'NumpadAdd' ? 'Add' : event.code === 'NumpadSubtract' ? 'Subtract' : key;
    if (ZOOM_IN.has(numpad) || ZOOM_OUT.has(numpad)) {
      this.zoomBy(ZOOM_IN.has(numpad) ? 1 : -1);
      return true;
    }
    if (key === 'n' || key === 'N') {
      this.resetNorth();
      return true;
    }
    return this.command(key);
  }

  /** Home and the view-mode keys, through the engine's commands when the connected globe has them. */
  private command(key: string): boolean {
    const globe = this.context.port.globe;
    const mode = VIEW_MODES[key];
    if (mode !== undefined && globe?.setViewMode) {
      this.context.interrupt();
      globe.setViewMode(mode);
      return true;
    }
    if (key === 'Home' && globe?.goHome) {
      this.context.interrupt();
      this.context.keys.stop();
      globe.goHome();
      return true;
    }
    return false;
  }

  /** Handles a key release. */
  keyUp(event: KeyInput): void {
    if (event.key === 'Shift') this.shift = false;
    if (!this.held.delete(event.key) && event.key !== 'Shift') return;
    this.retarget();
  }

  /** Focus left the map: every held key is released. */
  releaseAll(): void {
    this.held.clear();
    this.shift = false;
    this.retarget();
  }

  /** Zooms by `steps` presses about the screen center; presses accumulate (F174). */
  zoomBy(steps: number): void {
    const { zoom, options, port, keys, inertia } = this.context;
    inertia.stop();
    keys.panX.stop();
    keys.panY.stop();
    const levels = steps * options.keyboard.zoomLevelsPerPress;
    zoom.add(levels, this.context.widthPx() / 2, this.context.heightPx() / 2, options.zoomAnimationMs);
    port.requestUpdate();
  }

  /** Turns the heading to north up along the shortest arc, keeping center and tilt. */
  resetNorth(): void {
    const { heading, options, port } = this.context;
    this.context.interrupt();
    heading.start(0, options.zoomAnimationMs * 2);
    port.requestUpdate();
  }

  /** Sets the held-key target velocities from the keys down. */
  private retarget(): void {
    const { keys, options, port } = this.context;
    const along = (minus: string, plus: string): number =>
      (this.held.has(plus) ? 1 : 0) - (this.held.has(minus) ? 1 : 0);
    const horizontal = along('ArrowLeft', 'ArrowRight');
    const vertical = along('ArrowDown', 'ArrowUp');
    const rotate = this.shift;
    const panPerMs = (options.keyboard.panViewportsPerS * this.context.heightPx()) / 1000;
    keys.panX.target = rotate ? 0 : horizontal * panPerMs;
    // Up moves the view up the screen (toward the top), so the content moves down.
    keys.panY.target = rotate ? 0 : -vertical * panPerMs;
    keys.heading.target = rotate ? (horizontal * options.keyboard.rotateDegPerS) / 1000 : 0;
    keys.tilt.target = rotate ? (vertical * options.keyboard.tiltDegPerS) / 1000 : 0;
    port.requestUpdate();
  }
}
