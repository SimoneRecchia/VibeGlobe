import type { Credit } from '@vibeglobe/core';

/** Inline declarations that page CSS cannot override (inline `!important` wins over any stylesheet rule). */
const PINNED = [
  ['display', 'flex'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['position', 'absolute'],
  ['right', '0'],
  ['bottom', '0'],
  ['z-index', '2147483647'],
  ['transform', 'none'],
  ['clip-path', 'none'],
  ['pointer-events', 'auto'],
] as const;

/**
 * The engine's minimal attribution element (F255): the credits of the sources in view, with their links and logos,
 * at the bottom right of the container, above everything else in it. Its look is pinned with inline `!important`
 * declarations and restored if a script changes them, so required credits stay visible; an application that shows
 * the credits itself hides the optional ones with `GlobeOptions.hiddenCredits`.
 */
export class CreditsElement {
  private element: HTMLElement | undefined;
  private observer: MutationObserver | undefined;

  constructor(private readonly container: HTMLElement) {}

  /** Shows `credits`; an empty list removes the element. */
  show(credits: readonly Credit[]): void {
    if (credits.length === 0) {
      this.destroy();
      return;
    }
    const document = this.container.ownerDocument;
    const element = this.element ?? this.create(document);
    this.observer?.disconnect();
    element.replaceChildren(...credits.map((credit) => creditNode(document, credit)));
    pin(element);
    this.observer?.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }

  /** Removes the element. */
  destroy(): void {
    this.observer?.disconnect();
    this.element?.remove();
    this.element = undefined;
  }

  private create(document: Document): HTMLElement {
    const element = document.createElement('div');
    element.className = 'vg-credits';
    element.setAttribute('role', 'contentinfo');
    element.setAttribute('aria-label', 'Map data credits');
    this.container.append(element);
    // The container positions the element; a static container gets `position: relative` (as the canvas needs).
    if (this.container.ownerDocument.defaultView?.getComputedStyle(this.container).position === 'static')
      this.container.style.position = 'relative';
    const view = document.defaultView;
    if (view && 'MutationObserver' in view) {
      this.observer = new view.MutationObserver(() => {
        this.observer?.disconnect();
        element.removeAttribute('hidden');
        element.className = 'vg-credits';
        pin(element);
        this.observer?.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      });
    }
    this.element = element;
    return element;
  }
}

function pin(element: HTMLElement): void {
  for (const [name, value] of PINNED) element.style.setProperty(name, value, 'important');
  const style = element.style;
  style.gap = '6px';
  style.alignItems = 'center';
  style.padding = '2px 6px';
  style.font = '11px/1.4 system-ui, sans-serif';
  style.color = '#222';
  style.background = 'rgba(255, 255, 255, 0.8)';
  style.maxWidth = '100%';
  style.flexWrap = 'wrap';
}

function creditNode(document: Document, credit: Credit): HTMLElement {
  const item = document.createElement('span');
  item.className = credit.required ? 'vg-credit vg-credit-required' : 'vg-credit';
  item.dataset['sources'] = credit.sources.join(' ');
  if (credit.logo) {
    const logo = document.createElement('img');
    logo.src = credit.logo.src;
    logo.alt = credit.logo.alt;
    logo.style.height = '14px';
    logo.style.verticalAlign = 'middle';
    item.append(logo);
  }
  const text = credit.url ? document.createElement('a') : document.createElement('span');
  if (credit.url && text instanceof HTMLAnchorElement) {
    text.href = credit.url;
    text.target = '_blank';
    text.rel = 'noopener noreferrer';
    text.style.color = 'inherit';
  }
  text.textContent = credit.text;
  item.append(text);
  return item;
}
