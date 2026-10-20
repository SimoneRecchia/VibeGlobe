import { FEATURE_STATUSES, type Feature, type FeatureList } from '../feature-list.ts';

const FROZEN_FIELDS = ['milestone', 'section', 'description', 'steps'] as const;
const KNOWN_FIELDS = new Set(['id', ...FROZEN_FIELDS, 'status']);

/**
 * Lists the ways `current` breaks the feature-list rules relative to an earlier `base` version (ADR 0003):
 * entries are never deleted, reordered or reworded, only `status` changes (ADR 0016 adds `superseded`), and new entries
 * may be added.
 */
export function findFeatureListViolations(base: FeatureList, current: FeatureList): string[] {
  const violations: string[] = [];
  const currentById = new Map<string, Feature>();
  for (const feature of current.features) {
    if (currentById.has(feature.id)) violations.push(`${feature.id}: duplicate id`);
    currentById.set(feature.id, feature);
    if (!(FEATURE_STATUSES as readonly string[]).includes(feature.status)) {
      violations.push(`${feature.id}: invalid status "${String(feature.status)}"`);
    }
    for (const field of Object.keys(feature)) {
      if (!KNOWN_FIELDS.has(field)) violations.push(`${feature.id}: unknown field "${field}"`);
    }
  }

  for (const [milestone, name] of Object.entries(base.milestones)) {
    if (current.milestones[milestone] !== name) violations.push(`milestone ${milestone}: renamed or removed`);
  }

  let previousIndex = -1;
  for (const baseFeature of base.features) {
    const feature = currentById.get(baseFeature.id);
    if (!feature) {
      violations.push(`${baseFeature.id}: deleted`);
      continue;
    }
    for (const field of FROZEN_FIELDS) {
      if (JSON.stringify(feature[field]) !== JSON.stringify(baseFeature[field])) {
        violations.push(`${baseFeature.id}: ${field} changed`);
      }
    }
    const index = current.features.indexOf(feature);
    if (index < previousIndex) violations.push(`${baseFeature.id}: reordered`);
    previousIndex = Math.max(previousIndex, index);
  }
  return violations;
}

/**
 * Lists superseded entries that `record` (the text of docs/feature-changes.md) does not justify (ADR 0016): every
 * superseded entry has a row `| F… | replacement ids | … |`, every row names a superseded entry, and its replacements
 * exist and are not superseded themselves.
 */
export function findSupersessionViolations(current: FeatureList, record: string): string[] {
  const violations: string[] = [];
  const byId = new Map(current.features.map((feature) => [feature.id, feature]));
  const rows = new Map<string, string[]>();
  for (const match of record.matchAll(/^\|\s*(F\d+)\s*\|([^|]*)\|/gm)) {
    rows.set(match[1] as string, (match[2] as string).match(/F\d+/g) ?? []);
  }
  for (const feature of current.features) {
    if (feature.status === 'superseded' && !rows.has(feature.id)) {
      violations.push(`${feature.id}: superseded but not recorded in docs/feature-changes.md`);
    }
  }
  for (const [id, replacements] of rows) {
    const status = byId.get(id)?.status;
    if (status !== 'superseded') {
      violations.push(`${id}: recorded in docs/feature-changes.md but its status is "${status ?? 'missing'}"`);
    }
    if (replacements.length === 0) violations.push(`${id}: no replacement recorded in docs/feature-changes.md`);
    for (const replacement of replacements) {
      const replacementStatus = byId.get(replacement)?.status;
      if (replacementStatus === undefined) violations.push(`${id}: replacement ${replacement} does not exist`);
      else if (replacementStatus === 'superseded') {
        violations.push(`${id}: replacement ${replacement} is itself superseded`);
      }
    }
  }
  return violations;
}
