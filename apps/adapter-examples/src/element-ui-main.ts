// The `<vibe-globe>` element with the ui package's controls in its shadow tree, themed from the host page (F485).
import { xyzImagery } from '@vibeglobe/sources';
import { defineVibeGlobe, type VibeGlobeElement } from '@vibeglobe/web-component';
import { elementHooks } from './element-hooks.js';
import { fixtureTiles } from './hooks.js';

// A source with a provider-required credit and logo, so the attribution shows inside the element.
const logo =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="14"><rect width="28" height="14" fill="#1a73e8"/></svg>',
  );
const element = document.querySelector<VibeGlobeElement>('vibe-globe');
if (element)
  element.imagery = [
    xyzImagery({
      id: 'world',
      url: fixtureTiles('world'),
      maxLevel: 18,
      attribution: [{ text: 'Fixture world', url: 'https://example.com/fixtures/world' }],
      profile: { requiredAttribution: { text: 'Required world', logo: { src: logo, alt: 'world logo' } } },
    }),
  ];
defineVibeGlobe();
window.adapterExample = elementHooks([], async () => undefined);
