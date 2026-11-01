// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ImagerySource } from '@vibeglobe/core';

/**
 * Source metadata that the frozen source contract (`ImagerySource`, docs/internal/parallel-tracks.md) does not carry yet:
 * attribution and the provider profile (docs/internal/plan/api.md, "Sources and provider profiles"). The adapters of this
 * package return them as extra fields of the source object, so the engine can read them once it consumes them.
 */

/** A credit a source requires: text, an optional link and an optional logo. */
export interface Attribution {
  readonly text: string;
  readonly url?: string;
  readonly logo?: { readonly src: string; readonly alt: string };
}

/** The loading features a provider profile can switch off (docs/internal/plan/api.md, "Loading policy and caches"). */
export interface LoadingSwitches {
  persistentCache: boolean;
  memoryReuse: boolean;
  prefetch: boolean;
  offlinePackaging: boolean;
}

/** What a provider's terms require of the engine; a profile can only switch features off (PLAN.md). */
export interface ProviderProfile {
  /** 'custom', 'osm-public', … */
  readonly id: string;
  readonly forbids: ReadonlySet<keyof LoadingSwitches>;
  /** Reuse responses only while their HTTP cache headers allow it. */
  readonly respectCacheHeaders: boolean;
  /** Most requests in flight to the provider at once. */
  readonly maxConcurrentRequests?: number;
  /** The credit that must always be visible and never covered. */
  readonly requiredAttribution?: Attribution;
  /** The terms allow drawing only: pixel readback, tile data, elevation sampling and picking are refused. */
  readonly displayOnly?: boolean;
  /** The ADR that records the reading of the provider's terms. */
  readonly termsAdr?: string;
  /** A warning about the provider's terms, which the engine logs once per instance (KB-PT-07, F267). */
  readonly warning?: string;
}

/** The metadata of this package's adapters, on any tiled source (imagery or terrain). */
export interface DescribedSource {
  readonly attribution: readonly Attribution[];
  readonly profile: ProviderProfile;
}

/** An imagery source with the metadata of this package's adapters. */
export interface DescribedImagerySource extends ImagerySource {
  readonly attribution: readonly Attribution[];
  readonly profile: ProviderProfile;
  /**
   * Tiles must be downloaded by the source's own transport (sessions, signed or cropped requests, archives): a cache
   * tier in front of it (`@vibeglobe/offline`) never fetches its URLs directly (TB-01).
   */
  readonly transportRequired?: boolean;
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

/**
 * A profile that applies every rule of both (F325, F326): the union of what they forbid, the lower concurrency limit,
 * cache headers respected and drawing only when either asks, both warnings. `outer`'s required credit leads; the
 * adapter keeps the inner one among its credits, so neither is lost.
 */
export function combineProfiles(inner: ProviderProfile, outer: ProviderProfile): ProviderProfile {
  const limits = [inner.maxConcurrentRequests, outer.maxConcurrentRequests].filter((n) => n !== undefined);
  const requiredAttribution = outer.requiredAttribution ?? inner.requiredAttribution;
  const termsAdr = outer.termsAdr ?? inner.termsAdr;
  // Dropping either would lift a rule of the provider's terms (KB-328).
  const warning = [outer.warning, inner.warning].filter(Boolean).join(' ');
  return Object.freeze({
    id: `${outer.id}+${inner.id}`,
    forbids: new Set([...inner.forbids, ...outer.forbids]),
    respectCacheHeaders: inner.respectCacheHeaders || outer.respectCacheHeaders,
    ...(limits.length > 0 ? { maxConcurrentRequests: Math.min(...limits) } : {}),
    ...(requiredAttribution ? { requiredAttribution } : {}),
    ...(inner.displayOnly || outer.displayOnly ? { displayOnly: true } : {}),
    ...(termsAdr === undefined ? {} : { termsAdr }),
    ...(warning ? { warning } : {}),
  });
}

/**
 * Applies a source's profile where the engine reads it (F326): the per-host concurrency is capped by the profile's
 * limit, and the required credit is added to the attribution when missing. Adapters call it once when they are created;
 * a consumer's own adapter calls it the same way.
 */
export function withProfile<S extends ImagerySource>(
  source: S,
  profile: ProviderProfile,
  attribution: readonly Attribution[] = [],
): S & DescribedImagerySource {
  const credits = [...attribution];
  const required = profile.requiredAttribution;
  if (required && !credits.some((a) => a.text === required.text)) credits.unshift(required);
  const limit = profile.maxConcurrentRequests;
  const perHost = limit === undefined ? source.maxRequestsPerHost : Math.min(limit, source.maxRequestsPerHost ?? limit);
  return {
    ...source,
    ...(perHost === undefined ? {} : { maxRequestsPerHost: perHost }),
    attribution: credits,
    profile,
  };
}
