// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * What the playground page shows besides the engine (owner, 2026-10-25). In a person's browser every page shows the
 * `@vibeglobe/ui` controls (`?ui=0` hides them), and the default page, with no parameters other than `ui`, `lang` and
 * `theme`, is the showcase (`showcase.ts`); `?showcase=1` shows it with any parameters (the settings panel reloads with
 * `backend` and `network`). Under automation (`navigator.webdriver`, as Playwright sets it) the default is the bare
 * engine, so tests and benchmarks see the page they always did: `?ui=1` and `?showcase=1` ask for the rest.
 */
const params = new URLSearchParams(location.search);
const automated = navigator.webdriver;
const SHOWCASE_KEYS = new Set(['ui', 'lang', 'theme']);

/** Whether the page shows the UI controls. */
export const PAGE_UI = params.get('ui') === '1' || (params.get('ui') !== '0' && !automated);

/** Whether the page is the showcase of everything an application can have. */
export const SHOWCASE =
  params.get('showcase') === '1' ||
  (!automated && params.get('showcase') !== '0' && [...params.keys()].every((key) => SHOWCASE_KEYS.has(key)));
