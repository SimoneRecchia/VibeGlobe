import type { RenderHost } from '@vibeglobe/core';

/** Browser services for the engine: frames, size and pixel-ratio changes, page visibility (architecture §2). */
export function createBrowserHost(container: HTMLElement): RenderHost {
  const view = container.ownerDocument.defaultView ?? window;
  /** Matches while the pixel ratio is the one the canvas was last sized for. */
  let ratioQuery: MediaQueryList | undefined;
  let onRatioChange: (() => void) | undefined;
  return {
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (id) => view.cancelAnimationFrame(id),
    now: () => view.performance.now(),
    setTimer: (callback, delayMs) => view.setTimeout(callback, delayMs),
    clearTimer: (handle) => view.clearTimeout(handle as number),
    // The content box, which the canvas fills: clientWidth and clientHeight include the padding (KB-048).
    containerSize: () => {
      const style = view.getComputedStyle(container);
      const padding = (a: string, b: string): number => (parseFloat(a) || 0) + (parseFloat(b) || 0);
      return {
        widthPx: Math.max(0, container.clientWidth - padding(style.paddingLeft, style.paddingRight)),
        heightPx: Math.max(0, container.clientHeight - padding(style.paddingTop, style.paddingBottom)),
      };
    },
    pixelRatio: () => view.devicePixelRatio || 1,
    observeSize(callback) {
      const observer = new ResizeObserver(() => callback());
      // The device-pixel box changes with the CSS size and with the pixel ratio (browser zoom, another monitor).
      // Browsers without it (Safari) observe the CSS box and rely on the media query below for ratio changes.
      try {
        observer.observe(container, { box: 'device-pixel-content-box' });
      } catch {
        observer.observe(container);
      }
      // A pixel-ratio change also fires the media query for the current ratio once.
      const watchRatio = (): void => {
        ratioQuery?.removeEventListener('change', onRatio);
        ratioQuery = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
        ratioQuery.addEventListener('change', onRatio);
      };
      const onRatio = (): void => {
        watchRatio();
        callback();
      };
      onRatioChange = onRatio;
      watchRatio();
      return () => {
        observer.disconnect();
        ratioQuery?.removeEventListener('change', onRatio);
        ratioQuery = undefined;
        onRatioChange = undefined;
      };
    },
    // Some environments change the pixel ratio without any event (Chromium 156 under DevTools-protocol emulation,
    // KB-011). Reading whether the query still matches is a boolean, so this check allocates nothing.
    checkSize() {
      if (ratioQuery && !ratioQuery.matches) onRatioChange?.();
    },
    observeReducedMotion: (callback) => observeReducedMotion(view, callback),
    setOpacity: (opacity) => setCanvasOpacity(container, opacity),
    observeVisibility(callback) {
      const document = container.ownerDocument;
      const onChange = (): void => callback(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}

/** Calls `callback` now and on every change with the system's reduced-motion setting (F214); returns an unsubscribe. */
function observeReducedMotion(view: Window, callback: (reduce: boolean) => void): () => void {
  const query = view.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = (): void => callback(query.matches);
  query.addEventListener('change', onChange);
  onChange();
  return () => query.removeEventListener('change', onChange);
}

/** Shows the canvases the backend draws into, the container's own (ADR 0011), at `opacity` (F214). */
function setCanvasOpacity(container: HTMLElement, opacity: number): void {
  for (const canvas of container.querySelectorAll<HTMLCanvasElement>(':scope > canvas'))
    canvas.style.opacity = opacity >= 1 ? '' : String(opacity);
}
