# @vibeglobe/web-component

The framework-neutral `<vibe-globe>` custom element: a globe configured by attributes, with the camera attributes
followed at runtime, the ready-made controls of `@vibeglobe/ui` (`ui="all"`) and `CustomEvent`s. Use it in an
application without Vue, with another framework, or in a plain page. Importing the package registers nothing:
`defineVibeGlobe()` does, so it is safe under server-side rendering.

## Install

It brings `@vibeglobe/controls`, `@vibeglobe/core`, `@vibeglobe/renderer`, `@vibeglobe/sources`, `@vibeglobe/ui` and
`@vibeglobe/worker`; install `@vibeglobe/sources` directly to build sources in your own code.

## Entry points

| Import path                        | What                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `@vibeglobe/web-component`         | `defineVibeGlobe`, the `VibeGlobeElement` and event types                          |
| `@vibeglobe/web-component/browser` | One ES module with the engine bundled, and its worker, for pages without a bundler |

## Example

```ts
import { xyzImagery } from '@vibeglobe/sources';
import { defineVibeGlobe, type VibeGlobeElement } from '@vibeglobe/web-component';

defineVibeGlobe();
const element = document.createElement('vibe-globe') as VibeGlobeElement;
element.setAttribute('base-imagery-url', '/vibeglobe/fallback-base.jpg');
element.setAttribute('ui', 'default');
element.imagery = [xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/{z}/{x}/{y}.jpg', maxLevel: 14 })];
element.addEventListener('globe-click', (event) => console.log(event.detail.position));
container.append(element); // the engine starts here
element.zoom = 6; // moves the running camera
```

## Pitfalls

- `base-imagery-url` is required.
- `imagery`, `imagery-url`, `backend` and `no-controls` are read when the element is connected: set them before.
- The element is at least 150px high: give it the height you want.
- Its shadow tree is styled with a `<style>` element, which a Content Security Policy must allow (`'unsafe-inline'`
  in `style-src`).

## Guides

[Integration](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/integration.md#the-web-component) and
[UI and GIS](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/ui-and-gis.md) (theming the controls).
