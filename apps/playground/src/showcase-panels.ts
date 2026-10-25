// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The showcase's own controls (owner, 2026-10-25): a settings panel (theme, language, quality preset, atmosphere, fog,
 * sun time, space background, network mode, backend) and a help overlay listing the gestures. Both are `UiControl`s,
 * so they sit in the UI's corners with its theme; their texts follow the UI's language (English or Italian).
 */
import type { AtmosphereLevel, Globe } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, Ui, UiControl } from '@vibeglobe/ui';

type Language = 'en' | 'it';

const TEXT = {
  en: {
    settings: 'Settings',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    language: 'Language',
    quality: 'Quality',
    atmosphere: 'Atmosphere',
    fog: 'Fog',
    sun: 'Sun time',
    space: 'Space background',
    network: 'Network',
    backend: 'Backend',
    reload: 'reloads the page',
    help: 'Help',
    gestures: [
      [
        'Mouse',
        'drag to pan · right-drag or Ctrl+drag to rotate and tilt · wheel to zoom · double-click to zoom in · Shift+drag to zoom to a box',
      ],
      ['Trackpad', 'drag to pan, flick to spin the globe · pinch to zoom · two-finger rotate'],
      [
        'Touch',
        'drag to pan · pinch to zoom · twist to rotate · two fingers up or down to tilt · double tap to zoom in, two-finger tap to zoom out',
      ],
      [
        'Keyboard',
        'arrows to pan · + and − to zoom · Shift+arrows to rotate and tilt · N for north · Home · 2, 3 and A for 2D, 3D and Auto',
      ],
    ],
  },
  it: {
    settings: 'Impostazioni',
    theme: 'Tema',
    light: 'Chiaro',
    dark: 'Scuro',
    language: 'Lingua',
    quality: 'Qualità',
    atmosphere: 'Atmosfera',
    fog: 'Nebbia',
    sun: 'Ora del sole',
    space: 'Sfondo spaziale',
    network: 'Rete',
    backend: 'Backend',
    reload: 'ricarica la pagina',
    help: 'Aiuto',
    gestures: [
      [
        'Mouse',
        'trascina per spostare · tasto destro o Ctrl+trascina per ruotare e inclinare · rotella per lo zoom · doppio clic per avvicinare · Maiusc+trascina per lo zoom su un riquadro',
      ],
      [
        'Trackpad',
        'trascina per spostare, un colpo rapido fa girare il globo · pizzica per lo zoom · ruota con due dita',
      ],
      [
        'Touch',
        'trascina per spostare · pizzica per lo zoom · ruota con due dita · due dita su e giù per inclinare · doppio tocco per avvicinare, tocco a due dita per allontanare',
      ],
      [
        'Tastiera',
        'frecce per spostare · + e − per lo zoom · Maiusc+frecce per ruotare e inclinare · N per il nord · Home · 2, 3 e A per 2D, 3D e Auto',
      ],
    ],
  },
} as const;

/** What the settings panel changes beyond the UI itself. */
export interface ShowcaseHooks {
  /** Sets the quality preset (loads `@vibeglobe/quality` on first use). */
  setQuality(preset: 'low' | 'medium' | 'high' | 'ultra'): void;
  /** Shows or hides the space background. */
  setSpace(on: boolean): void;
}

/** A labeled row of the settings panel. */
function row(text: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:center;margin:4px 0';
  label.append(text, input);
  return label;
}

function select(options: readonly (readonly [value: string, text: string])[], value: string): HTMLSelectElement {
  const element = document.createElement('select');
  for (const [optionValue, text] of options) element.add(new Option(text, optionValue, false, optionValue === value));
  return element;
}

function checkbox(checked: boolean): HTMLInputElement {
  const element = document.createElement('input');
  element.type = 'checkbox';
  element.checked = checked;
  return element;
}

/** Reloads the showcase with `name=value` (the network mode and the backend are chosen when the globe is created). */
function reloadWith(name: string, value: string): void {
  const params = new URLSearchParams(location.search);
  params.set('showcase', '1');
  if (value === 'auto' || value === 'online-default') params.delete(name);
  else params.set(name, value);
  location.search = params.toString();
}

/** A collapsible panel control: a button that opens a box of content built by `fill`. */
abstract class PanelControl implements UiControl {
  readonly position: ControlPosition = 'bottom-right';
  protected box = document.createElement('div');
  protected button = document.createElement('button');
  protected language: Language = 'en';
  #context: ControlContext | undefined;

  constructor(readonly id: string) {}

  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = document.createElement('div');
    frame.className = `vg-ui__control vg-ui__${this.id}`;
    this.button.type = 'button';
    this.button.style.cssText = 'font:inherit;padding:4px 10px;cursor:pointer';
    this.button.setAttribute('aria-expanded', 'false');
    this.box.hidden = true;
    this.box.style.cssText = 'max-width:360px;padding:8px 12px;font-size:13px;line-height:1.4';
    this.button.addEventListener('click', () => {
      this.box.hidden = !this.box.hidden;
      this.button.setAttribute('aria-expanded', String(!this.box.hidden));
    });
    frame.append(this.box, this.button);
    this.localize();
    return frame;
  }

  localize(): void {
    this.language = this.#context?.i18n.language === 'it' ? 'it' : 'en';
    this.box.replaceChildren();
    this.fill(this.#context?.globe);
  }

  protected abstract fill(globe: Globe | undefined): void;

  destroy(): void {
    this.box.replaceChildren();
  }
}

/** The settings panel. */
export class SettingsControl extends PanelControl {
  readonly #ui: () => Ui | undefined;
  readonly #hooks: ShowcaseHooks;
  #state = { quality: 'high', atmosphere: 'high' as AtmosphereLevel, fog: true, space: true, sun: '' };

  constructor(ui: () => Ui | undefined, hooks: ShowcaseHooks) {
    super('showcase-settings');
    this.#ui = ui;
    this.#hooks = hooks;
  }

  protected fill(globe: Globe | undefined): void {
    const t = TEXT[this.language];
    this.button.textContent = `⚙ ${t.settings}`;
    const ui = this.#ui();
    const theme = select(
      [
        ['light', t.light],
        ['dark', t.dark],
      ],
      ui?.theme ?? 'light',
    );
    theme.addEventListener('change', () => ui?.setTheme(theme.value === 'dark' ? 'dark' : 'light'));
    const language = select(
      [
        ['en', 'English'],
        ['it', 'Italiano'],
      ],
      this.language,
    );
    language.addEventListener('change', () => ui?.setLanguage(language.value));
    const quality = select(
      ['low', 'medium', 'high', 'ultra'].map((q) => [q, q] as const),
      this.#state.quality,
    );
    quality.addEventListener('change', () => {
      this.#state.quality = quality.value;
      this.#hooks.setQuality(quality.value as 'low' | 'medium' | 'high' | 'ultra');
    });
    this.box.append(row(t.theme, theme), row(t.language, language), row(t.quality, quality));
    this.fillScene(globe);
    this.fillReloads();
  }

  /** Atmosphere, fog, sun time and the space background. */
  private fillScene(globe: Globe | undefined): void {
    const t = TEXT[this.language];
    const state = this.#state;
    const levels: readonly AtmosphereLevel[] = ['off', 'low', 'medium', 'high', 'ultra'];
    const atmosphere = select(
      levels.map((l) => [l, l] as const),
      state.atmosphere,
    );
    const fog = checkbox(state.fog);
    const apply = (): void => {
      state.atmosphere = atmosphere.value as AtmosphereLevel;
      state.fog = fog.checked;
      globe?.setQualitySettings({ atmosphere: state.atmosphere, fog: state.fog });
    };
    atmosphere.addEventListener('change', apply);
    fog.addEventListener('change', apply);
    const sun = document.createElement('input');
    sun.type = 'datetime-local';
    sun.value = state.sun;
    sun.addEventListener('change', () => {
      state.sun = sun.value;
      const timeMs = Date.parse(sun.value);
      globe?.setAtmosphere(Number.isNaN(timeMs) ? { sunLighting: false } : { sunLighting: true, timeMs });
    });
    const space = checkbox(state.space);
    space.addEventListener('change', () => {
      state.space = space.checked;
      this.#hooks.setSpace(space.checked);
    });
    this.box.append(row(t.atmosphere, atmosphere), row(t.fog, fog), row(t.sun, sun), row(t.space, space));
  }

  /** The network mode and the backend, which reload the page. */
  private fillReloads(): void {
    const t = TEXT[this.language];
    const params = new URLSearchParams(location.search);
    const network = select(
      [
        ['online-default', 'online (direct)'],
        ['online', 'online (offline engine)'],
        ['hybrid', 'hybrid'],
        ['offline', 'offline'],
      ],
      params.get('network') ?? 'online-default',
    );
    network.addEventListener('change', () => reloadWith('network', network.value));
    const backend = select(
      [
        ['auto', 'auto'],
        ['webgpu', 'WebGPU'],
        ['webgl2', 'WebGL2'],
      ],
      params.get('backend') ?? 'auto',
    );
    backend.addEventListener('change', () => reloadWith('backend', backend.value));
    const note = document.createElement('small');
    note.textContent = `${t.network} · ${t.backend}: ${t.reload}`;
    this.box.append(row(t.network, network), row(t.backend, backend), note);
  }
}

/** The help overlay: the gestures of every input. */
export class HelpControl extends PanelControl {
  constructor() {
    super('showcase-help');
  }

  protected fill(): void {
    const t = TEXT[this.language];
    this.button.textContent = `? ${t.help}`;
    const list = document.createElement('dl');
    list.style.margin = '0';
    for (const [device, gestures] of t.gestures) {
      const term = document.createElement('dt');
      term.style.fontWeight = '600';
      term.textContent = device;
      const description = document.createElement('dd');
      description.style.margin = '0 0 6px';
      description.textContent = gestures;
      list.append(term, description);
    }
    this.box.append(list);
  }
}
