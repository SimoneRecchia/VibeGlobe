import { NO_TERRAIN } from './types.js';
import { creditsOf, VisibleSources, type Credit, type CreditedSource } from '../imagery/credits.js';
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

  /**
   * `sources` are the imagery and terrain sources by handle index (holes where a layer was removed); `changed` receives the new list; `warn` logs
   * once per source whose required credit the configuration tried to hide.
   */
  constructor(
    private readonly sources: readonly (CreditedSource | undefined)[],
    private readonly hidden: ReadonlySet<string>,
    private readonly changed: (credits: readonly Credit[]) => void,
    private readonly warn: (message: string) => void,
    private readonly terrainIndex: number,
    /** Sources render extensions credit for what they draw (`RenderExtensionContext.setCredits`, track E hook 2). */
    private readonly extra: () => readonly CreditedSource[] = () => [],
  ) {
    this.visible = new VisibleSources(sources.length);
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
    const shown = this.sources.filter(
      (source, index): source is CreditedSource => source !== undefined && this.visible.visible(index),
    );
    shown.push(...this.extra());
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
  /** Imagery layers were added, removed or moved (`Globe.imageryLayers`, track A hook 2). */
  layersChange?(): void;
  /** Sources whose credits the application hides (`GlobeOptions.hiddenCredits`); required credits stay (F255). */
  readonly hiddenCredits?: readonly string[];
  /** False when the application shows the credits itself (`GlobeOptions.creditsElement`). */
  readonly creditsElement?: boolean;
  /** False keeps every host at its own limit (`GlobeOptions.adaptiveRequests`, F303). */
  readonly adaptiveRequests?: boolean;
}

/**
 * The sources render extensions credit (`RenderExtensionContext.setCredits`, track E hook 2), by renderer and then by
 * extension: kept outside the credits, which the runtime builds again when a layer is added or removed.
 */
export const extensionCredits = new WeakMap<object, Map<object, readonly CreditedSource[]>>();

/** The credits of an engine's sources, shown in the renderer's attribution element and reported to the globe. */
export function runtimeCredits(
  sources: readonly (ImagerySource | TerrainSource | undefined)[],
  terrainIndex: number,
  renderer: RendererBackend,
  callbacks: ImageryCallbacks,
  observability: Observability | undefined,
): RuntimeCredits {
  return new RuntimeCredits(
    sources,
    new Set(callbacks.hiddenCredits ?? []),
    (credits) => {
      if (callbacks.creditsElement !== false) renderer.host.showCredits?.(credits);
      callbacks.creditsChange?.(credits);
    },
    (message) => observability?.logger.log('warn', message),
    terrainIndex,
    () => [...(extensionCredits.get(renderer)?.values() ?? [])].flat(),
  );
}
