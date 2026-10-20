import type { Feature, FeatureList } from '../feature-list.ts';

const FROZEN_FIELDS = ['milestone', 'section', 'description', 'steps'] as const;
const KNOWN_FIELDS = new Set(['id', ...FROZEN_FIELDS, 'status']);

/**
 * Lists the ways `current` breaks the feature-list rules relative to an earlier `base` version (ADR 0003):
 * entries are never deleted, reordered or reworded, only `status` changes, and new entries may be added.
 */
export function findFeatureListViolations(base: FeatureList, current: FeatureList): string[] {
  const violations: string[] = [];
  const currentById = new Map<string, Feature>();
  for (const feature of current.features) {
    if (currentById.has(feature.id)) violations.push(`${feature.id}: duplicate id`);
    currentById.set(feature.id, feature);
    if (feature.status !== 'passing' && feature.status !== 'failing') {
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
