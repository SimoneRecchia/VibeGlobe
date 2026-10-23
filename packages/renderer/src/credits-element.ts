import type { Credit } from '@vibeglobe/core';

/** Inline declarations that page CSS cannot override (inline `!important` wins over any stylesheet rule). */
const PINNED = [
  ['display', 'flex'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['z-index', '2147483647'],
  ['transform', 'none'],
  ['clip-path', 'none'],
  ['pointer-events', 'auto'],
] as const;

/** What page CSS cannot change on each credit and its logo either (TB-02, F259): only the element's own were pinned. */
const PINNED_ITEM = [
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['transform', 'none'],
  ['clip-path', 'none'],
] as const;

function pinItem(element: HTMLElement, display: string): void {
  element.style.setProperty('display', display, 'important');
  for (const [name, value] of PINNED_ITEM) element.style.setProperty(name, value, 'important');
}

/**
 * The engine's minimal attribution element (F255): the credits of the sources in view, with their links and logos,
 * at the bottom right of the container, above everything else in it. Its look is pinned with inline `!important`
 * declarations and restored if a script changes them, so required credits stay visible; an application that shows
 * the credits itself hides the optional ones with `GlobeOptions.hiddenCredits`. Where the browser has popovers, the
 * element lives in the top layer, placed over the container's corner, so no page element covers it whatever its
 * z-index (F259).
 */
export class CreditsElement {
  private element: HTMLElement | undefined;
  private observer: MutationObserver | undefined;
  private resize: ResizeObserver | undefined;
  private readonly place = (): void => {
    if (this.element) this.pin(this.element);
  };

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
    this.pin(element);
    this.observer?.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'popover'] });
  }

  /** Removes the element. */
  destroy(): void {
    this.observer?.disconnect();
    this.resize?.disconnect();
    const view = this.container.ownerDocument.defaultView;
    view?.removeEventListener('scroll', this.place, true);
    view?.removeEventListener('resize', this.place);
    this.element?.remove();
    this.element = undefined;
  }

  /** Pins the look and places the element: in the top layer over the container's bottom right, or inside it. */
  private pin(element: HTMLElement): void {
    pin(element);
    const view = this.container.ownerDocument.defaultView;
    if (!view || typeof element.showPopover !== 'function') {
      for (const [name, value] of [
        ['position', 'absolute'],
        ['right', '0'],
        ['bottom', '0'],
      ] as const)
        element.style.setProperty(name, value, 'important');
      return;
    }
    const box = this.container.getBoundingClientRect();
    for (const [name, value] of [
      ['position', 'fixed'],
      ['inset', 'auto'],
      ['right', `${view.innerWidth - box.right}px`],
      ['bottom', `${view.innerHeight - box.bottom}px`],
      ['margin', '0'],
      ['border', '0'],
      ['overflow', 'visible'],
    ] as const)
      element.style.setProperty(name, value, 'important');
    if (!element.matches(':popover-open') && element.isConnected) element.showPopover();
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
    if (typeof element.showPopover === 'function') {
      element.popover = 'manual';
      // A page that closes the popover sees it open again; it follows the container as it moves or resizes.
      element.addEventListener('toggle', () => queueMicrotask(this.place));
      view?.addEventListener('scroll', this.place, true);
      view?.addEventListener('resize', this.place);
      if (view && 'ResizeObserver' in view) {
        this.resize = new view.ResizeObserver(this.place);
        this.resize.observe(this.container);
      }
    }
    if (view && 'MutationObserver' in view) {
      this.observer = new view.MutationObserver(() => {
        this.observer?.disconnect();
        element.removeAttribute('hidden');
        element.className = 'vg-credits';
        if (typeof element.showPopover === 'function') element.popover = 'manual';
        this.pin(element);
        this.observer?.observe(element, {
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden', 'popover'],
        });
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
  pinItem(item, 'inline');
  if (credit.logo) {
    const logo = document.createElement('img');
    logo.src = credit.logo.src;
    logo.alt = credit.logo.alt;
    logo.style.height = '14px';
    logo.style.verticalAlign = 'middle';
    pinItem(logo, 'inline-block');
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
