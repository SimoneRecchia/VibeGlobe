import { NO_TERRAIN } from './types.js';
import {
  creditsOf,
  VisibleSources,
  type Credit,
  type CreditedSource,
  type CreditViewport,
} from '../imagery/credits.js';
import type { DrawList } from '../imagery/draw-list.js';
import type { ImagerySource } from '../imagery/imagery-source.js';
import type { Observability } from '../diagnostics/observability.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import type { RendererBackend, TileErrorEvent } from './types.js';
import type { GlobeError } from './errors.js';

/**
 * The credits of one engine instance (F254, F255): which sources each frame shows, by index (imagery sources in the
 * order of their loaders, then the terrain), and the list of their credits when that changes.
 */
export class RuntimeCredits {
  readonly visible: VisibleSources;
  private readonly warned = new Set<string>();
  /** The last list reported, as text: a refresh reports only a change. */
  private reported = '[]';
  /** Credit lines of the last settled view by source id, from `viewportCopyright` (F258). */
  private readonly viewTexts = new Map<string, string>();
  /** The camera pose of the last settled view asked about, and a counter that discards answers for older views. */
  private readonly settledPose = new Float64Array(8).fill(NaN);
  private settledViews = 0;
  /** Some source's credits depend on the view. */
  readonly viewDependent: boolean;

  /**
   * `sources` are the imagery sources then the terrain source, if any; `changed` receives the new list; `warn` logs
   * once per source whose required credit the configuration tried to hide.
   */
  constructor(
    private readonly sources: readonly CreditedSource[],
    private readonly hidden: ReadonlySet<string>,
    private readonly changed: (credits: readonly Credit[]) => void,
    private readonly warn: (message: string) => void,
    private readonly terrainIndex: number,
  ) {
    this.visible = new VisibleSources(sources.length);
    this.viewDependent = sources.some((source) => typeof source.viewportCopyright === 'function');
  }

  /**
   * The camera came to rest (`pose`: longitude, latitude, zoom, heading, tilt, width and height): when it rests
   * somewhere new, asks every visible source whose credits depend on the view for the credit line of `viewport()`, and
   * reports the list again as answers arrive; answers for a view the camera has left are dropped (F258).
   */
  settle(pose: readonly number[], viewport: () => CreditViewport): void {
    // The view-dependent sources in view count as part of the view: one coming into view is asked too.
    let shown = 0;
    this.sources.forEach((source, index) => {
      if (source.viewportCopyright && this.visible.visible(index)) shown += 2 ** (index % 52);
    });
    if (shown === 0 || [...pose, shown].every((value, i) => value === this.settledPose[i])) return;
    this.settledPose.set([...pose, shown]);
    const views = ++this.settledViews;
    const view = viewport();
    this.sources.forEach((source, index) => {
      if (!source.viewportCopyright || !this.visible.visible(index)) return;
      void source.viewportCopyright(view).then(
        (text) => {
          if (views !== this.settledViews) return;
          if (text) this.viewTexts.set(source.id, text);
          else this.viewTexts.delete(source.id);
          this.refresh();
        },
        () => undefined,
      );
    });
  }

  /** Ends a frame of `count` draws: marks the terrain when a draw shows it, and reports a change of credits. */
  afterFrame(list: DrawList, count: number): void {
    if (this.terrainIndex >= 0) {
      const textures = list.terrain.textures;
      for (let i = 0; i < count; i++) {
        if (textures[i] !== NO_TERRAIN) {
          this.visible.mark(this.terrainIndex);
          break;
        }
      }
    }
    if (this.visible.settle()) this.report(this.list());
  }

  /** Reads the visible sources' `attribution` again and reports a change (`Globe.refreshCredits`, F258). */
  refresh(): void {
    const credits = this.list();
    if (JSON.stringify(credits) !== this.reported) this.report(credits);
  }

  private report(credits: Credit[]): void {
    this.reported = JSON.stringify(credits);
    this.changed(credits);
  }

  /** The credits of the sources the last frame showed (allocates; called on a change and by `Globe.credits()`). */
  list(): Credit[] {
    const shown = this.sources.filter((_, index) => this.visible.visible(index));
    // A view's credit line joins its source's credits; required when the provider requires the source's credit.
    for (const source of [...shown]) {
      const text = this.viewTexts.get(source.id);
      if (text === undefined) continue;
      shown.push(
        source.profile?.requiredAttribution
          ? { id: source.id, profile: { requiredAttribution: { text } } }
          : { id: source.id, attribution: [{ text }] },
      );
    }
    return creditsOf(shown, this.hidden, (sourceId) => {
      if (this.warned.has(sourceId)) return;
      this.warned.add(sourceId);
      this.warn(`The credit of source "${sourceId}" is required by its provider and stays visible (F255)`);
    });
  }
}

/** What the imagery runtime reports to its globe. */
export interface ImageryCallbacks {
  /** Something arrived that changes the picture or the queue. */
  requestFrame(): void;
  /** A tile failed for good; its ancestors stay drawn (F112). */
  tileError(event: TileErrorEvent): void;
  /** The credits of the sources in view changed (F254). */
  creditsChange?(credits: readonly Credit[]): void;
  /** A source was left out for invalid metadata (F220). */
  sourceError?(error: GlobeError): void;
  /** Sources whose credits the application hides (`GlobeOptions.hiddenCredits`); required credits stay (F255). */
  readonly hiddenCredits?: readonly string[];
  /** False when the application shows the credits itself (`GlobeOptions.creditsElement`). */
  readonly creditsElement?: boolean;
}

/** The credits of an engine's sources, shown in the renderer's attribution element and reported to the globe. */
export function runtimeCredits(
  sources: readonly ImagerySource[],
  terrain: TerrainSource | undefined,
  renderer: RendererBackend,
  callbacks: ImageryCallbacks,
  observability: Observability | undefined,
): RuntimeCredits {
  return new RuntimeCredits(
    terrain ? [...sources, terrain] : sources,
    new Set(callbacks.hiddenCredits ?? []),
    (credits) => {
      if (callbacks.creditsElement !== false) renderer.host.showCredits?.(credits);
      callbacks.creditsChange?.(credits);
    },
    (message) => observability?.logger.log('warn', message),
    terrain ? sources.length : -1,
  );
}
