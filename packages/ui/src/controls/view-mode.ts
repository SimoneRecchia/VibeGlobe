/**
 * The 2D / 3D / Auto toggle (F421): 2D keeps the tilt at 0°, 3D chooses the default tilt, Auto restores the zoom-driven
 * curves, each through the engine's `setViewMode` (F163), which eases to the new tilt. A Back to Auto button next to it
 * shows whenever the view is not in Auto, including after a manual tilt.
 */
import type { ViewMode } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame } from './dom.js';

/** Options of {@link ViewModeControl}. */
export interface ViewModeControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
}

/** The toggle's choices, as `Globe.setViewMode` takes them. */
export type ViewModeChoice = '2d' | '3d' | 'auto';

const CHOICES: readonly ViewModeChoice[] = ['2d', '3d', 'auto'];
const NAMES = { '2d': 'viewMode.2d', '3d': 'viewMode.3d', auto: 'viewMode.auto' } as const;

/** The choice the toggle shows for an engine mode: a tilt chosen by hand is 3D. */
export function choiceOf(mode: ViewMode): ViewModeChoice {
  return mode === 'manual' ? '3d' : mode;
}

/** Three toggle buttons (one pressed) and a Back to Auto button; arrow keys move between the buttons. */
export class ViewModeControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  #context: ControlContext | undefined;
  #group: HTMLElement | undefined;
  readonly #buttons = new Map<ViewModeChoice, HTMLButtonElement>();
  #back: HTMLButtonElement | undefined;
  #stop: (() => void) | undefined;

  /** @param options - Placement; every field is optional. */
  constructor(options: ViewModeControlOptions = {}) {
    this.id = options.id ?? 'view-mode';
    this.position = options.position ?? 'top-right';
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('view-mode');
    const group = document.createElement('div');
    group.className = 'vg-ui__segmented';
    group.setAttribute('role', 'group');
    this.#group = group;
    for (const choice of CHOICES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `vg-ui__button vg-ui__button--text vg-ui__button--view-${choice}`;
      button.addEventListener('click', () => this.choose(choice));
      button.addEventListener('keydown', (event) => this.#onKey(event, choice));
      this.#buttons.set(choice, button);
      group.append(button);
    }
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'vg-ui__button vg-ui__button--text vg-ui__button--back-to-auto';
    back.addEventListener('click', () => this.choose('auto'));
    this.#back = back;
    frame.append(group, back);
    this.#stop = context.globe.on('view-mode-change', ({ mode }) => this.#show(mode));
    this.#show(context.globe.viewMode);
    return frame;
  }

  /** The choice shown now. */
  get choice(): ViewModeChoice | undefined {
    return this.#context === undefined ? undefined : choiceOf(this.#context.globe.viewMode);
  }

  /** Sets the view mode, as a press of its button does. */
  choose(choice: ViewModeChoice): void {
    const globe = this.#context?.globe;
    if (globe === undefined) return;
    globe.setViewMode(choice);
    this.#show(globe.viewMode);
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined) return;
    this.#group?.setAttribute('aria-label', i18n.t('viewMode.label'));
    for (const [choice, button] of this.#buttons) {
      button.textContent = i18n.t(NAMES[choice]);
      button.title = i18n.t(`viewMode.${choice}.title`);
    }
    if (this.#back !== undefined) {
      this.#back.textContent = i18n.t('viewMode.backToAuto');
      this.#back.title = i18n.t('viewMode.auto.title');
    }
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#context = undefined;
  }

  #show(mode: ViewMode): void {
    const shown = choiceOf(mode);
    for (const [choice, button] of this.#buttons) {
      button.setAttribute('aria-pressed', String(choice === shown));
      // One tab stop for the group: the pressed button; arrows move between the others.
      button.tabIndex = choice === shown ? 0 : -1;
    }
    if (this.#back !== undefined) this.#back.hidden = shown === 'auto';
  }

  #onKey(event: KeyboardEvent, choice: ViewModeChoice): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = CHOICES[(CHOICES.indexOf(choice) + step + CHOICES.length) % CHOICES.length] ?? 'auto';
    const button = this.#buttons.get(next);
    if (button === undefined) return;
    for (const other of this.#buttons.values()) other.tabIndex = other === button ? 0 : -1;
    button.focus();
  }
}
