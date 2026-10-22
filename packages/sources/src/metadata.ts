import type { ImagerySource } from '@vibeglobe/core';

/**
 * Source metadata that the frozen source contract (`ImagerySource`, docs/parallel-tracks.md) does not carry yet:
 * attribution and the provider profile (docs/plan/api.md, "Sources and provider profiles"). The adapters of this
 * package return them as extra fields of the source object, so the engine can read them once it consumes them.
 */

/** A credit a source requires: text, an optional link and an optional logo. */
export interface Attribution {
  readonly text: string;
  readonly url?: string;
  readonly logo?: { readonly src: string; readonly alt: string };
}

/** The loading features a provider profile can switch off (docs/plan/api.md, "Loading policy and caches"). */
export interface LoadingSwitches {
  persistentCache: boolean;
  memoryReuse: boolean;
  prefetch: boolean;
  offlinePackaging: boolean;
}

/** What a provider's terms require of the engine; a profile can only switch features off (PLAN.md). */
export interface ProviderProfile {
  /** 'custom', 'google', 'osm-public', … */
  readonly id: string;
  readonly forbids: ReadonlySet<keyof LoadingSwitches>;
  /** Reuse responses only while their HTTP cache headers allow it. */
  readonly respectCacheHeaders: boolean;
  /** Most requests in flight to the provider at once. */
  readonly maxConcurrentRequests?: number;
  /** The credit that must always be visible and never covered. */
  readonly requiredAttribution?: Attribution;
  /** Sessions are renewed after this many seconds. */
  readonly sessionRenewalSeconds?: number;
  /** The ADR that records the reading of the provider's terms. */
  readonly termsAdr?: string;
}

/** An imagery source with the metadata of this package's adapters. */
export interface DescribedImagerySource extends ImagerySource {
  readonly attribution: readonly Attribution[];
  readonly profile: ProviderProfile;
}

/** The profile of sources whose owner set no provider rules: everything enabled. */
export const CUSTOM_PROFILE: ProviderProfile = Object.freeze({
  id: 'custom',
  forbids: new Set<keyof LoadingSwitches>(),
  respectCacheHeaders: true,
});

/** A source configuration the adapter refused: `code` is stable, `message` names the source and the field. */
export class SourceConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceConfigError';
    this.code = code;
  }
}
