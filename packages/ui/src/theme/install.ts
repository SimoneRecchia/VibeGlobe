// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Installs the ui stylesheet in the document or shadow root that holds a UI layer, while any UI layer or debug panel
 * there uses it: a page, or each `<vibe-globe>` element's shadow tree (F485).
 */
import { RULES_CSS, THEME_CSS } from './styles.js';

/** A document or shadow root and its adopted style sheets. */
type StyleRoot = Document | ShadowRoot;

const installed = new Map<StyleRoot, { uses: number; sheet: CSSStyleSheet | HTMLStyleElement }>();

/** The root a node renders in (the page's document by default). */
export function styleRootOf(node?: Node): StyleRoot {
  const root = node?.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

/**
 * Installs the stylesheet once per root (reference-counted), as a constructed sheet so a strict Content Security
 * Policy allows it.
 */
export function installStyles(root: StyleRoot = document): void {
  const entry = installed.get(root);
  if (entry !== undefined) {
    entry.uses++;
    return;
  }
  const css = THEME_CSS + RULES_CSS;
  let sheet: CSSStyleSheet | HTMLStyleElement;
  if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } else {
    sheet = document.createElement('style');
    sheet.textContent = css;
    (root instanceof ShadowRoot ? root : document.head).append(sheet);
  }
  installed.set(root, { uses: 1, sheet });
}

/** Releases one use of the stylesheet in a root; the last release removes it. */
export function uninstallStyles(root: StyleRoot = document): void {
  const entry = installed.get(root);
  if (entry === undefined || --entry.uses > 0) return;
  installed.delete(root);
  const { sheet } = entry;
  if (sheet instanceof HTMLStyleElement) sheet.remove();
  else root.adoptedStyleSheets = root.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
}
