// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Apps chapter: the framework adapters, the example applications and the playground's other pages. */
import { element } from '../panel.js';
import type { SceneModule } from '../types.js';

const REPO = 'https://github.com/SimoneRecchia/VibeGlobe/blob/main/';

/** A link card: a title and one line about it. */
function card(href: string, title: string, text: string): HTMLAnchorElement {
  const link = element('a', 'tour-link');
  link.href = href;
  if (href.startsWith('http')) {
    link.target = '_blank';
    link.rel = 'noopener';
  }
  link.append(element('strong', '', title), element('span', '', text));
  return link;
}

/** Links to every way of embedding the engine, and to the playground's test pages. */
export const integrations: SceneModule = {
  code: `<!-- Vue 3: @vibeglobe/vue -->
<VibeGlobe base-imagery-url="/vibeglobe/fallback-base.jpg" :zoom="3" view-mode="auto">
  <VibeDataLayer :layer="cities" />
  <template #placeholder>Loading the map…</template>
</VibeGlobe>

<!-- Any page: @vibeglobe/web-component -->
<vibe-globe base-imagery-url="/vibeglobe/fallback-base.jpg" center="12.5, 41.9" zoom="5" ui="all"></vibe-globe>`,
  start(context) {
    const { panel } = context;
    context.go({ longitudeDeg: 10, latitudeDeg: 30, zoom: 1.9, tiltDeg: 0, headingDeg: 0 });
    const frameworks = panel.group('Frameworks');
    const links = element('div', 'tour-links');
    links.append(
      card(
        `${REPO}packages/vue/README.md`,
        'Vue 3',
        'A <VibeGlobe> component with layers, markers and controls as children.',
      ),
      card(`${REPO}apps/nuxt-example`, 'Nuxt', 'Server-rendered pages with the globe started after hydration.'),
      card(
        `${REPO}packages/web-component/README.md`,
        'Web Component',
        'A <vibe-globe> element for any page, with or without a bundler.',
      ),
      card(`${REPO}apps/adapter-examples`, 'Adapter examples', 'Vue, React and plain HTML pages on the same engine.'),
      card(
        `${REPO}apps/lazy-host`,
        'Lazy loading',
        'A host page that downloads the engine only when the map is shown.',
      ),
      card(
        `${REPO}apps/custom-layer-example`,
        'A custom layer',
        'A layer of your own drawn through the public render target.',
      ),
    );
    frameworks.element.append(links);
    const pages = panel.group('More of this playground');
    const more = element('div', 'tour-links');
    more.append(
      card('?scenario=two-globes', 'Two globes', 'Two engines on one page, each with its own view.'),
      card('?scenario=energy-park&ui=1', 'Energy park', 'The models scene on a page of its own.'),
      card('?quality=auto&debug=1&ui=1', 'Debug overlay', 'The playground’s full diagnostics.'),
    );
    pages.element.append(more);
    panel.note('Every guide is written for people and for AI agents that build applications: see llms.txt.');
  },
};
