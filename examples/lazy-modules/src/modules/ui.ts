// UI: the default controls over the running globe.
import type { Globe } from '@vibeglobe/core';
import { createUi } from '@vibeglobe/ui';

export async function enable(globe: Globe, container: HTMLElement): Promise<string> {
  await globe.ready;
  createUi(globe, container);
  return `ui: ${container.querySelectorAll('button').length} buttons`;
}
