// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The drawing control (F407–F410): a toolbar for points, lines, polygons and editing, operable with mouse, touch and
 * keyboard, over the drawing tool (`tool`: shapes as GeoJSON, events, commands). A keyboard cursor over the map
 * places and picks with Enter; a validation message reports a polygon that would cross itself.
 */
import { themeValue } from '../theme/value.js';
import { formatCoordinate } from '@vibeglobe/gis';
import type { TranslationKey } from '../i18n/en.js';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { DrawInput } from '../draw/draw-input.js';
import { DrawLayers } from '../draw/draw-layers.js';
import { DrawingTool, type DrawMode } from '../draw/drawing-tool.js';
import type { LonLat } from '../draw/geometry.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';
import { decimalSeparator } from './locale.js';

/** Options of {@link DrawControl}. */
export interface DrawControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** The modes the toolbar offers (default: point, line, polygon and edit). */
  readonly modes?: readonly Exclude<DrawMode, 'none'>[];
  /** A tool to show (shared with another control); by default a new one. */
  readonly tool?: DrawingTool;
  /** The accessible names of the mode buttons, replacing the defaults (the measurement tools name their own). */
  readonly labels?: Partial<Record<Exclude<DrawMode, 'none'>, TranslationKey>>;
  /** The toolbar's accessible name (default `draw.label`). */
  readonly toolbarLabel?: TranslationKey;
}

const MODE_ICONS = { point: ICONS.point, line: ICONS.line, polygon: ICONS.polygon, edit: ICONS.edit } as const;
const MODE_LABELS = {
  point: 'draw.point',
  line: 'draw.line',
  polygon: 'draw.polygon',
  edit: 'draw.edit',
} as const satisfies Record<Exclude<DrawMode, 'none'>, TranslationKey>;

let instances = 0;

/** The drawing toolbar, its keyboard cursor and status line. */
export class DrawControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  /** The drawing tool: shapes, events and commands, for the application. */
  readonly tool: DrawingTool;
  readonly #modes: readonly Exclude<DrawMode, 'none'>[];
  readonly #labels: Record<Exclude<DrawMode, 'none'>, TranslationKey>;
  readonly #toolbarLabel: TranslationKey;
  readonly #prefix = `vg-ui-draw-${++instances}`;
  #context: ControlContext | undefined;
  readonly #buttons = new Map<string, HTMLButtonElement>();
  #cursor: HTMLElement | undefined;
  #status: HTMLElement | undefined;
  #input: DrawInput | undefined;
  #message: TranslationKey | undefined;
  #cursorAt: LonLat | undefined;
  #stops: (() => void)[] = [];

  /** @param options - Placement, modes and tool; every field is optional. */
  constructor(options: DrawControlOptions = {}) {
    this.id = options.id ?? 'draw';
    this.position = options.position ?? 'top-left';
    this.#modes = options.modes ?? ['point', 'line', 'polygon', 'edit'];
    this.tool = options.tool ?? new DrawingTool();
    this.#labels = { ...MODE_LABELS, ...options.labels };
    this.#toolbarLabel = options.toolbarLabel ?? 'draw.label';
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('draw');
    const bar = document.createElement('div');
    bar.className = 'vg-ui__segmented';
    bar.setAttribute('role', 'toolbar');
    for (const mode of this.#modes) {
      const button = iconButton(`draw-${mode}`, icon(MODE_ICONS[mode]));
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', (event) => {
        this.setMode(this.tool.mode === mode ? 'none' : mode);
        // From the keyboard (a click without a pointer), the keyboard cursor takes the focus.
        if (event.detail === 0 && this.tool.mode !== 'none') this.#cursor?.focus();
      });
      this.#buttons.set(mode, button);
      bar.append(button);
    }
    for (const [name, iconPath, action] of [
      ['finish', ICONS.check, () => this.tool.finish()],
      ['cancel', ICONS.close, () => this.tool.cancel()],
      ['delete', ICONS.trash, () => this.tool.deleteSelection()],
    ] as const) {
      const button = iconButton(`draw-${name}`, icon(iconPath));
      button.addEventListener('click', () => void action());
      this.#buttons.set(name, button);
      bar.append(button);
    }
    const status = document.createElement('div');
    status.className = 'vg-ui__status';
    status.setAttribute('role', 'status');
    frame.append(bar, status);
    this.#status = status;
    this.#cursor = this.#makeCursor(context);
    this.#stops.push(
      this.tool.on('mode', () => this.#showMode()),
      this.tool.on('validation', () => this.#say('draw.selfIntersection')),
      this.tool.on('create', () => this.#say(undefined)),
      this.tool.on('change', () => this.#say(undefined)),
    );
    void this.#attach(context);
    this.#showMode();
    return frame;
  }

  /** Switches the tool's mode (see {@link DrawingTool.setMode}). */
  setMode(mode: DrawMode): void {
    this.tool.setMode(mode);
    if (mode !== 'none') this.#input?.resetCursor();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined) return;
    for (const [name, button] of this.#buttons) {
      const key =
        name in this.#labels ? this.#labels[name as keyof typeof MODE_LABELS] : (`draw.${name}` as TranslationKey);
      label(button, i18n.t(key));
    }
    this.#buttons.get(this.#modes[0] ?? 'point')?.parentElement?.setAttribute('aria-label', i18n.t(this.#toolbarLabel));
    this.#say(this.#message);
    this.#announce(this.#cursorAt);
  }

  /** Stops the input and removes the layers and the cursor (UiControl); the tool keeps its shapes. */
  destroy(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.#input?.destroy();
    this.tool.detach();
    this.#cursor?.remove();
    this.#context = undefined;
  }

  async #attach(context: ControlContext): Promise<void> {
    const [layers, module] = await Promise.all([
      context.layers(() => import('@vibeglobe/layers')),
      import('@vibeglobe/layers'),
    ]);
    if (this.#context === undefined || this.#cursor === undefined) return;
    const colors = {
      shape: themeValue(context.container, '--vg-ui-drawing-color'),
      handle: themeValue(context.container, '--vg-ui-drawing-handle-color'),
    };
    this.tool.attach(new DrawLayers(layers, module, this.#prefix, colors));
    this.#input = new DrawInput(context.globe, context.container, this.tool, this.#cursor, (p) => this.#announce(p));
  }

  #makeCursor(context: ControlContext): HTMLElement {
    const cursor = document.createElement('div');
    cursor.className = 'vg-ui__draw-cursor';
    cursor.tabIndex = 0;
    cursor.setAttribute('role', 'application');
    cursor.hidden = true;
    (context.container.querySelector('.vg-ui') ?? context.container).append(cursor);
    return cursor;
  }

  #showMode(): void {
    const mode = this.tool.mode;
    for (const [name, button] of this.#buttons)
      if (name in MODE_LABELS) button.setAttribute('aria-pressed', String(name === mode));
    if (this.#cursor !== undefined) this.#cursor.hidden = mode === 'none';
    for (const name of ['finish', 'cancel']) {
      const button = this.#buttons.get(name);
      if (button !== undefined) button.hidden = mode === 'none' || mode === 'edit' || mode === 'point';
    }
    const remove = this.#buttons.get('delete');
    if (remove !== undefined) remove.hidden = mode !== 'edit';
  }

  #say(key: TranslationKey | undefined): void {
    this.#message = key;
    if (this.#status !== undefined && this.#context !== undefined)
      this.#status.textContent = key === undefined ? '' : this.#context.i18n.t(key);
  }

  #announce(position: LonLat | undefined): void {
    this.#cursorAt = position;
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#cursor === undefined) return;
    const coordinates =
      position === undefined
        ? i18n.t('readout.none')
        : (formatCoordinate({ longitudeDeg: position[0], latitudeDeg: position[1] }, 'decimal', {
            decimalSeparator: decimalSeparator(i18n.language),
          }) ?? '');
    this.#cursor.setAttribute('aria-label', i18n.t('draw.cursor', { coordinates }));
  }
}
