// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The license gate: refuses any source whose terms forbid offline packaging or redistribution, before anything is
 * downloaded or written (F333).
 */
import type { DatasetConfig, SourceConfig } from '../config/schema.js';
import { FORBIDDEN_HOSTS, FORBIDDEN_URLS, type ProviderProfile, findProfile } from './profiles.js';

/** A refused source: which one, under which profile, and the term it violates. */
export interface LicenseViolation {
  dataset: string;
  source: string;
  profile: string;
  term: string;
}

/** Every URL a source reads from. */
function sourceUrls(source: SourceConfig): string[] {
  switch (source.type) {
    case 'copernicus-dem':
    case 's2cloudless':
      return [source.baseUrl];
    case 'worldcover-s2':
      return source.gapFill ? [source.baseUrl, source.gapFill.mapBaseUrl] : [source.baseUrl];
    case 'geotiff':
    case 'osm-extract':
    case 'xyz':
      return [source.url];
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/[{}]/g, '')).hostname;
  } catch {
    return '';
  }
}

/** The profile a source effectively falls under: forbidden hosts and editions override the configured profile. */
function effectiveProfile(profileId: string, source: SourceConfig): ProviderProfile | undefined {
  for (const url of sourceUrls(source)) {
    const host = hostOf(url);
    const forbidden = FORBIDDEN_HOSTS.find((entry) => entry.pattern.test(host));
    if (forbidden) return findProfile(forbidden.profile);
    const layer = FORBIDDEN_URLS.find((entry) => entry.pattern.test(url));
    if (layer) return findProfile(layer.profile);
  }
  if (source.type === 's2cloudless' && source.edition !== 2016) return findProfile('s2cloudless-2018-or-later');
  return findProfile(profileId);
}

function termOf(profile: ProviderProfile): string | undefined {
  if (profile.offlinePackaging && profile.redistribution) return undefined;
  return profile.forbiddingTerm ?? `the ${profile.name} terms forbid offline packaging or redistribution`;
}

/** The violation of one source, or `undefined` when its terms allow packaging. */
export function checkSource(dataset: string, profileId: string, source: SourceConfig): LicenseViolation | undefined {
  const profile = effectiveProfile(profileId, source);
  const name = sourceUrls(source)[0] ?? source.type;
  if (!profile) return { dataset, source: name, profile: profileId, term: `unknown provider profile "${profileId}"` };
  const term = termOf(profile);
  return term === undefined ? undefined : { dataset, source: name, profile: profile.id, term };
}

/** Every violation of a build's datasets. */
export function checkDatasets(datasets: DatasetConfig[]): LicenseViolation[] {
  return datasets.flatMap((dataset) => checkSource(dataset.id, dataset.profile, dataset.source) ?? []);
}

/** A readable refusal message naming each source and the term it violates. */
export function describeViolations(violations: LicenseViolation[]): string {
  const lines = violations.map(
    (v) => `  ${v.dataset}: ${v.source} (profile ${v.profile}) is refused because ${v.term}`,
  );
  return `License gate: refusing to download or package forbidden sources:\n${lines.join('\n')}`;
}
