// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// `?stars=1`: the space background, stars and the Milky Way (ADR 0181), on the playground's first globe once it is
// ready; `&starCatalog=<url>` hosts its catalog elsewhere. Its handle is `window.vibeglobeStars`, for tests. Without
// the parameter nothing more loads.

const params = new URLSearchParams(location.search);

/** Waits for the playground's test hooks, which `main.ts` exposes once its globe is created. */
async function playground(): Promise<NonNullable<Window['vibeglobePlayground']>> {
  for (;;) {
    const hooks = window.vibeglobePlayground;
    if (hooks) return hooks;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

if (params.get('stars') === '1')
  void (async () => {
    const { globe } = await playground();
    await globe.ready;
    const { addSpaceBackground } = await import('@vibeglobe/renderer/starfield');
    const catalogUrl = params.get('starCatalog');
    Object.assign(window, { vibeglobeStars: addSpaceBackground(globe, catalogUrl === null ? {} : { catalogUrl }) });
  })();
