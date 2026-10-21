import type { RenderHost } from '@vibeglobe/core';

/** Browser services for the engine: frames, size and pixel-ratio changes, page visibility (architecture §2). */
export function createBrowserHost(container: HTMLElement): RenderHost {
  const view = container.ownerDocument.defaultView ?? window;
  return {
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (id) => view.cancelAnimationFrame(id),
    now: () => view.performance.now(),
    containerSize: () => ({ widthPx: container.clientWidth, heightPx: container.clientHeight }),
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
      let query: MediaQueryList | undefined;
      const watchRatio = (): void => {
        query?.removeEventListener('change', onRatio);
        query = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
        query.addEventListener('change', onRatio);
      };
      const onRatio = (): void => {
        watchRatio();
        callback();
      };
      watchRatio();
      return () => {
        observer.disconnect();
        query?.removeEventListener('change', onRatio);
      };
    },
    observeVisibility(callback) {
      const document = container.ownerDocument;
      const onChange = (): void => callback(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}
