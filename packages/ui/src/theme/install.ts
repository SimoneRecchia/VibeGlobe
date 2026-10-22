/** Installs the ui stylesheet in the page while any UI layer or debug panel uses it. */
import { RULES_CSS, THEME_CSS } from './styles.js';

let installedSheets = 0;
let sheet: CSSStyleSheet | HTMLStyleElement | undefined;

/** Installs the stylesheet once per page (reference-counted), as a constructed sheet so a strict Content Security Policy allows it. */
export function installStyles(): void {
  installedSheets++;
  if (sheet !== undefined) return;
  const css = THEME_CSS + RULES_CSS;
  if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
    const constructed = new CSSStyleSheet();
    constructed.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, constructed];
    sheet = constructed;
  } else {
    const element = document.createElement('style');
    element.textContent = css;
    document.head.append(element);
    sheet = element;
  }
}

/** Releases one use of the stylesheet; the last release removes it from the page. */
export function uninstallStyles(): void {
  installedSheets--;
  if (installedSheets > 0 || sheet === undefined) return;
  const installed = sheet;
  if (installed instanceof HTMLStyleElement) installed.remove();
  else document.adoptedStyleSheets = document.adoptedStyleSheets.filter((candidate) => candidate !== installed);
  sheet = undefined;
}
