// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Globe } from '@vibeglobe/core';
import type { Ui } from '@vibeglobe/ui';

/** The attributes that configure the element's UI layer, followed at runtime. */
export const UI_ATTRIBUTES = ['ui', 'theme', 'lang'] as const;

/** The element's UI layer: the ui package's controls inside the shadow tree, created when the `ui` attribute is set. */
export class ElementUi {
  #ui: Promise<Ui> | undefined;
  #stopped = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly globe: Globe,
    private readonly container: HTMLElement,
  ) {}

  /** The UI layer, once created (with the `ui` attribute). */
  get ui(): Promise<Ui> | undefined {
    return this.#ui;
  }

  /**
   * Applies the attributes: `ui` (`default`, or `all` for every navigation control) creates the layer once, `theme`
   * (`light` or `dark`) and `lang` (a registered language) switch it at runtime.
   */
  sync(): void {
    const mode = this.host.getAttribute('ui');
    if (mode === null) return;
    this.#ui ??= this.#create(mode);
    void this.#ui.then((ui) => {
      const theme = this.host.getAttribute('theme');
      if (theme === 'light' || theme === 'dark') ui.setTheme(theme);
      const language = this.host.getAttribute('lang');
      if (language !== null && ui.i18n.languages().includes(language)) ui.setLanguage(language);
    });
  }

  /** Removes the layer. */
  stop(): void {
    this.#stopped = true;
    void this.#ui?.then((ui) => ui.destroy());
  }

  async #create(mode: string): Promise<Ui> {
    const { addAllControls, addDefaultControls, createUi } = await import('@vibeglobe/ui');
    const ui = createUi(this.globe, this.container);
    // Host pages theme the controls through `vibe-globe::part(ui)`, setting the documented `--vg-ui-*` variables.
    ui.element.setAttribute('part', 'ui');
    (mode === 'all' ? addAllControls : addDefaultControls)(ui);
    if (this.#stopped) ui.destroy();
    return ui;
  }
}
