// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The scenes' live controls: switches, sliders, segmented choices, buttons, readouts and file drops, built into the
 * scene's part of the tour panel with the UI's theme variables.
 */

/** A slider's range and how its value reads. */
interface SliderOptions {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly format?: (value: number) => string;
}

/** Rows of name and value that a scene updates as things change. */
export type Readout = (rows: readonly (readonly [name: string, value: string])[]) => void;

/** Builds controls into one element. */
export interface Panel {
  readonly element: HTMLElement;
  /** A titled group of controls. */
  group(title: string): Panel;
  note(text: string): HTMLParagraphElement;
  toggle(label: string, checked: boolean, change: (on: boolean) => void): HTMLInputElement;
  slider(label: string, options: SliderOptions, input: (value: number) => void): HTMLInputElement;
  /** One of a few values, as a row of buttons; returns the function that shows another value as chosen. */
  choice<T extends string>(
    label: string,
    options: readonly (readonly [value: T, text: string])[],
    value: T,
    change: (value: T) => void,
  ): (value: T) => void;
  select(
    label: string,
    options: readonly (readonly [string, string])[],
    value: string,
    change: (v: string) => void,
  ): void;
  buttons(...items: (readonly [text: string, action: () => void])[]): HTMLButtonElement[];
  color(label: string, value: string, change: (value: string) => void): HTMLInputElement;
  text(label: string, value: string, change: (value: string) => void): HTMLInputElement;
  readout(): Readout;
  /** A bar from 0 to 1; undefined hides it. */
  progress(): (fraction: number | undefined) => void;
  /** A drop zone and file picker for `accept` (file extensions). */
  files(label: string, accept: string, load: (file: File) => void): void;
}

/** An element with a class and optional text. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A labelled row holding `control`. */
function row(label: string, control: HTMLElement, extra?: HTMLElement): HTMLLabelElement {
  const line = element('label', 'tour-row');
  line.append(element('span', 'tour-row__label', label), control);
  if (extra) line.append(extra);
  return line;
}

function input(type: string, className: string): HTMLInputElement {
  const node = element('input', className);
  node.type = type;
  return node;
}

/** A button with text that runs `action`. */
export function button(text: string, action: () => void, className = 'tour-button'): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function choice<T extends string>(
  parent: HTMLElement,
  label: string,
  options: readonly (readonly [T, string])[],
  value: T,
  change: (value: T) => void,
): (value: T) => void {
  const group = element('div', 'tour-segmented');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const show = (chosen: T): void => {
    for (const node of group.children)
      node.setAttribute('aria-pressed', String((node as HTMLElement).dataset['value'] === chosen));
  };
  for (const [optionValue, text] of options) {
    const node = button(text, () => {
      show(optionValue);
      change(optionValue);
    });
    node.dataset['value'] = optionValue;
    group.append(node);
  }
  show(value);
  const line = element('div', 'tour-row tour-row--stack');
  line.append(element('span', 'tour-row__label', label), group);
  parent.append(line);
  return show;
}

function slider(
  parent: HTMLElement,
  label: string,
  options: SliderOptions,
  change: (value: number) => void,
): HTMLInputElement {
  const range = input('range', 'tour-range');
  Object.assign(range, { min: String(options.min), max: String(options.max), step: String(options.step) });
  range.value = String(options.value);
  const output = element('output', 'tour-row__value');
  const format = options.format ?? String;
  const show = (): void => void (output.textContent = format(Number(range.value)));
  range.addEventListener('input', () => {
    show();
    change(Number(range.value));
  });
  show();
  parent.append(row(label, range, output));
  return range;
}

function readout(parent: HTMLElement): Readout {
  const list = element('dl', 'tour-readout');
  parent.append(list);
  return (rows) => {
    const cells: HTMLElement[] = [];
    for (const [name, value] of rows) cells.push(element('dt', '', name), element('dd', '', value));
    list.replaceChildren(...cells);
  };
}

function files(parent: HTMLElement, label: string, accept: string, load: (file: File) => void): void {
  const zone = element('label', 'tour-drop');
  const picker = input('file', 'tour-drop__input');
  picker.accept = accept;
  picker.addEventListener('change', () => {
    const [file] = picker.files ?? [];
    if (file) load(file);
    picker.value = '';
  });
  zone.append(element('strong', '', label), element('span', '', `Drop a file here or choose one (${accept})`), picker);
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('tour-drop--over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('tour-drop--over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('tour-drop--over');
    const file = event.dataTransfer?.files[0];
    if (file) load(file);
  });
  parent.append(zone);
}

function progress(parent: HTMLElement): (fraction: number | undefined) => void {
  const bar = element('progress', 'tour-progress');
  bar.max = 1;
  bar.hidden = true;
  parent.append(bar);
  return (fraction) => {
    bar.hidden = fraction === undefined;
    if (fraction !== undefined) bar.value = fraction;
  };
}

/** A panel building into `parent`. */
export function createPanel(parent: HTMLElement): Panel {
  const add = <E extends HTMLElement>(node: E): E => (parent.append(node), node);
  const field = (type: string, label: string, value: string, change: (v: string) => void): HTMLInputElement => {
    const node = input(type, `tour-${type}`);
    node.value = value;
    node.addEventListener(type === 'color' ? 'input' : 'change', () => change(node.value));
    parent.append(row(label, node));
    return node;
  };
  return {
    element: parent,
    group(title) {
      const section = add(element('section', 'tour-group'));
      section.append(element('h3', 'tour-group__title', title));
      return createPanel(section);
    },
    note: (text) => add(element('p', 'tour-note', text)),
    toggle(label, checked, change) {
      const box = input('checkbox', 'tour-switch');
      box.setAttribute('role', 'switch');
      box.checked = checked;
      box.addEventListener('change', () => change(box.checked));
      parent.append(row(label, box));
      return box;
    },
    slider: (label, options, change) => slider(parent, label, options, change),
    choice: (label, options, value, change) => choice(parent, label, options, value, change),
    select(label, options, value, change) {
      const node = element('select', 'tour-select');
      for (const [optionValue, text] of options) node.add(new Option(text, optionValue, false, optionValue === value));
      node.addEventListener('change', () => change(node.value));
      parent.append(row(label, node));
    },
    buttons(...items) {
      const line = add(element('div', 'tour-buttons'));
      const made = items.map(([text, action]) => button(text, action));
      line.append(...made);
      return made;
    },
    color: (label, value, change) => field('color', label, value, change),
    text: (label, value, change) => field('text', label, value, change),
    readout: () => readout(parent),
    progress: () => progress(parent),
    files: (label, accept, load) => files(parent, label, accept, load),
  };
}
