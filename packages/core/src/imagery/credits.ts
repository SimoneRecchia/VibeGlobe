/** A credit a source asks for: text, an optional link and an optional logo (docs/plan/api.md, `Attribution`). */
export interface Attribution {
  readonly text: string;
  readonly url?: string;
  readonly logo?: { readonly src: string; readonly alt: string };
}

/** What a source's provider profile asks of the credits: the credit that must always stay visible (F255). */
export interface CreditProfile {
  readonly requiredAttribution?: Attribution;
}

/** The credit metadata a tiled source may carry (`DescribedImagerySource` in `@vibeglobe/sources`). */
export interface CreditedSource {
  readonly id: string;
  readonly attribution?: readonly Attribution[];
  readonly profile?: CreditProfile;
}

/** A credit of the sources in view (F254): one per distinct text and link, with the sources that ask for it. */
export interface Credit extends Attribution {
  /** True when a provider's terms require it: it is always shown, whatever the configuration asks (F255). */
  readonly required: boolean;
  /** Ids of the visible sources it credits. */
  readonly sources: readonly string[];
}

/**
 * The credits of the visible sources, deduplicated by text and link (a source in two layers, or two sources of one
 * provider, are credited once), the required ones first. `hidden` lists source ids whose credits the application
 * hides; a required credit stays, and `refused` receives each source whose required credit could not be hidden.
 */
export function creditsOf(
  sources: readonly CreditedSource[],
  hidden: ReadonlySet<string> = new Set(),
  refused: (sourceId: string) => void = () => undefined,
): Credit[] {
  const byKey = new Map<string, { attribution: Attribution; required: boolean; sources: string[] }>();
  const add = (attribution: Attribution, required: boolean, sourceId: string): void => {
    const key = `${attribution.text}\u0000${attribution.url ?? ''}`;
    const entry = byKey.get(key);
    if (!entry) byKey.set(key, { attribution, required, sources: [sourceId] });
    else {
      entry.required ||= required;
      if (!entry.sources.includes(sourceId)) entry.sources.push(sourceId);
      if (!entry.attribution.logo && attribution.logo) entry.attribution = attribution;
    }
  };
  for (const source of sources) {
    const required = source.profile?.requiredAttribution;
    if (hidden.has(source.id)) {
      if (required) {
        refused(source.id);
        add(required, true, source.id);
      }
      continue;
    }
    if (required) add(required, true, source.id);
    for (const attribution of source.attribution ?? []) add(attribution, sameCredit(attribution, required), source.id);
  }
  const credits = [...byKey.values()].map(({ attribution, required, sources: ids }) => ({
    ...attribution,
    required,
    sources: ids,
  }));
  return credits.sort((a, b) => Number(b.required) - Number(a.required));
}

function sameCredit(a: Attribution, b: Attribution | undefined): boolean {
  return b !== undefined && a.text === b.text && (a.url ?? '') === (b.url ?? '');
}

/**
 * Which sources a frame showed, as flags by source index, compared with the previous frame's (F254): `mark` during the
 * frame, `settle` after it. Allocates nothing per frame.
 */
export class VisibleSources {
  private shown: Uint8Array;
  private previous: Uint8Array;

  constructor(count: number) {
    this.shown = new Uint8Array(count);
    this.previous = new Uint8Array(count);
  }

  /** Records that the frame shows source `index`. */
  mark(index: number): void {
    this.shown[index] = 1;
  }

  /** Ends a frame: true when its visible sources differ from the previous frame's. */
  settle(): boolean {
    let changed = false;
    for (let i = 0; i < this.shown.length; i++) if (this.shown[i] !== this.previous[i]) changed = true;
    const swap = this.previous;
    this.previous = this.shown;
    this.shown = swap;
    this.shown.fill(0);
    return changed;
  }

  /** True when the last settled frame showed source `index`. */
  visible(index: number): boolean {
    return this.previous[index] === 1;
  }
}
