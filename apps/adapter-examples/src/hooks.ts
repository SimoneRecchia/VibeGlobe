import type { Globe } from '@vibeglobe/core';

/** An event an example received from an adapter, with its payload as the listener got it. */
export interface ExampleEvent {
  readonly source: string;
  readonly type: string;
  readonly payload: unknown;
}

/** Test hooks of the example pages (end-to-end specs `e2e/vue-*.spec.ts`, `e2e/web-component-*.spec.ts`). */
export interface ExampleHooks {
  readonly events: ExampleEvent[];
  /** The engines of the globes on the page, in page order. */
  globes(): (Globe | undefined)[];
  /** Mounts (true) or unmounts (false) the globes, or only the one at `index`; resolves once the change is rendered. */
  show(shown: boolean, index?: number): Promise<void>;
  /** Sets a reactive camera prop or attribute of the first globe. */
  setView(view: {
    readonly longitudeDeg?: number;
    readonly latitudeDeg?: number;
    readonly zoom?: number;
  }): Promise<void>;
  /** What the page displays from the adapter's reactive state, when it has any. */
  displayed?(): Record<string, number | boolean>;
}

declare global {
  interface Window {
    adapterExample?: ExampleHooks;
  }
}

/** The page's query parameters. */
export const params = new URLSearchParams(location.search);

/** `?backend=webgpu|webgl2` forces a backend. */
export const backend =
  params.get('backend') === 'webgpu' || params.get('backend') === 'webgl2'
    ? (params.get('backend') as 'webgpu' | 'webgl2')
    : 'auto';

/** URL of the base imagery, served from the playground's public folder. */
export const BASE_IMAGERY_URL = '/imagery/natural-earth-4096.jpg';

/** The XYZ template of a fixture tile pattern in a fixture-server session (`?session=`). */
export function fixtureTiles(pattern: string): string {
  return `/fixture-tiles/${params.get('session') ?? 'examples'}/${pattern}/mercator/{z}/{x}/{y}.png`;
}
