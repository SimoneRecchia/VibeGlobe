/**
 * The layer switcher (F425): a button that opens a panel with the base maps (radio buttons: one imagery layer shown)
 * and the overlays (check boxes: imagery overlays and the data layers of a stack the application passes). Visibility changes go
 * through the engine's `imageryLayers.set` (F245: a hidden layer stops requesting tiles and shows its cached tiles
 * again) and the stack's `setVisible`. The lists follow layers added and removed at runtime while the panel is open.
 */
import type { GlobeLayers } from '@vibeglobe/layers';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link LayerSwitcherControl}. */
export interface LayerSwitcherOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Ids of imagery layers listed as overlays (check boxes); every other imagery layer is a base map. */
  readonly overlays?: readonly string[];
  /** Display names by layer id; by default the id. */
  readonly names?: Readonly<Record<string, string>>;
  /** A data-layer stack (`createGlobeLayers`) whose layers are listed as overlays. */
  readonly dataLayers?: GlobeLayers;
}

/** One row of the panel. */
interface Row {
  readonly id: string;
  readonly kind: 'base' | 'imagery-overlay' | 'data';
  readonly visible: boolean;
}

let instances = 0;

/** A disclosure button and its panel of base maps and overlays. */
export class LayerSwitcherControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #overlays: ReadonlySet<string>;
  readonly #names: Readonly<Record<string, string>>;
  readonly #prefix = `vg-ui-layers-${++instances}`;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #panel: HTMLElement | undefined;
  #layers: GlobeLayers | undefined;
  #signature = '';
  #stops: (() => void)[] = [];

  /** @param options - Placement, overlays and names; every field is optional. */
  constructor(options: LayerSwitcherOptions = {}) {
    this.id = options.id ?? 'layers';
    this.position = options.position ?? 'top-right';
    this.#overlays = new Set(options.overlays ?? []);
    this.#names = options.names ?? {};
    this.#layers = options.dataLayers;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('layers');
    const button = iconButton('layers', icon(ICONS.layers));
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${this.#prefix}-panel`);
    button.addEventListener('click', () => this.setOpen(!this.open));
    const panel = document.createElement('div');
    panel.id = `${this.#prefix}-panel`;
    panel.className = 'vg-ui__panel vg-ui__layers-panel';
    panel.hidden = true;
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.setOpen(false);
      button.focus();
    });
    frame.append(button, panel);
    this.#button = button;
    this.#panel = panel;
    // Runtime additions and removals show while the panel is open: the lists are compared once per drawn frame.
    this.#stops.push(context.globe.on('frame', () => this.#refresh()));
    return frame;
  }

  /** Whether the panel is open. */
  get open(): boolean {
    return this.#panel?.hidden === false;
  }

  /** Opens or closes the panel. */
  setOpen(open: boolean): void {
    if (this.#panel === undefined || this.#button === undefined) return;
    this.#panel.hidden = !open;
    this.#button.setAttribute('aria-expanded', String(open));
    this.localize();
    if (open) {
      this.#signature = '';
      this.#refresh();
    }
  }

  /** Shows one base map and hides the others. */
  chooseBase(id: string): void {
    const layers = this.#context?.globe.imageryLayers;
    if (layers === undefined) return;
    for (const row of this.#rows()) if (row.kind === 'base') layers.set(row.id, { visible: row.id === id });
    this.#refresh();
  }

  /** Shows or hides an overlay (an imagery overlay or a data layer). */
  setOverlayVisible(id: string, visible: boolean): void {
    const row = this.#rows().find((candidate) => candidate.id === id);
    if (row?.kind === 'imagery-overlay') this.#context?.globe.imageryLayers.set(id, { visible });
    else if (row?.kind === 'data') this.#layers?.stack.setVisible(id, visible);
    this.#refresh();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#button === undefined) return;
    label(this.#button, i18n.t(this.open ? 'layers.close' : 'layers.open'));
    this.#panel?.setAttribute('aria-label', i18n.t('layers.label'));
    this.#signature = '';
    this.#refresh();
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.#context = undefined;
  }

  #rows(): Row[] {
    const globe = this.#context?.globe;
    if (globe === undefined) return [];
    const rows: Row[] = globe.imageryLayers.list().map((layer) => ({
      id: layer.id,
      kind: this.#overlays.has(layer.id) ? 'imagery-overlay' : 'base',
      visible: layer.visible,
    }));
    const stack = this.#layers?.stack;
    if (stack !== undefined)
      for (const id of stack.order) rows.push({ id, kind: 'data', visible: stack.isVisible(id) });
    return rows;
  }

  #refresh(): void {
    const panel = this.#panel;
    const i18n = this.#context?.i18n;
    if (panel === undefined || i18n === undefined || panel.hidden) return;
    const rows = this.#rows();
    const signature = rows.map((row) => `${row.kind}:${row.id}:${row.visible}`).join('|');
    if (signature === this.#signature) return;
    this.#signature = signature;
    const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement.value : undefined;
    const base = rows.filter((row) => row.kind === 'base');
    const overlays = rows.filter((row) => row.kind !== 'base');
    panel.replaceChildren(
      ...(base.length > 0 ? [this.#group(i18n.t('layers.base'), base, 'radio')] : []),
      ...(overlays.length > 0 ? [this.#group(i18n.t('layers.overlays'), overlays, 'checkbox')] : []),
    );
    if (focused !== undefined) panel.querySelector<HTMLInputElement>(`input[value="${CSS.escape(focused)}"]`)?.focus();
  }

  #group(title: string, rows: readonly Row[], type: 'radio' | 'checkbox'): HTMLElement {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'vg-ui__layers-group';
    const legend = document.createElement('legend');
    legend.textContent = title;
    fieldset.append(legend);
    for (const row of rows) {
      const item = document.createElement('label');
      item.className = 'vg-ui__layers-item';
      const input = document.createElement('input');
      input.type = type;
      input.name = `${this.#prefix}-${type === 'radio' ? 'base' : row.id}`;
      input.value = row.id;
      input.checked = row.visible;
      input.addEventListener('change', () => {
        if (type === 'radio') this.chooseBase(row.id);
        else this.setOverlayVisible(row.id, input.checked);
      });
      const name = document.createElement('span');
      name.textContent = this.#names[row.id] ?? row.id;
      item.append(input, name);
      fieldset.append(item);
    }
    return fieldset;
  }
}
