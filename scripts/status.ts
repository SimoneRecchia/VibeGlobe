// Prints how many feature_list.json entries pass and how many fail, per milestone,
// and the next failing entry (file order is priority order).
import { readFileSync } from 'node:fs';

interface Feature {
  id: string;
  milestone: number;
  description: string;
  status: 'passing' | 'failing';
}

interface FeatureList {
  milestones: Record<string, string>;
  features: Feature[];
}

const list = JSON.parse(readFileSync(new URL('../feature_list.json', import.meta.url), 'utf8')) as FeatureList;
const { features } = list;

const invalid = features.filter((f) => f.status !== 'passing' && f.status !== 'failing');
const duplicateIds = features.map((f) => f.id).filter((id, index, ids) => ids.indexOf(id) !== index);
if (invalid.length > 0 || duplicateIds.length > 0) {
  if (invalid.length > 0) console.error(`Invalid status (expected "passing" or "failing"): ${invalid.map((f) => f.id).join(', ')}`);
  if (duplicateIds.length > 0) console.error(`Duplicate ids: ${duplicateIds.join(', ')}`);
  process.exit(1);
}

const passing = features.filter((f) => f.status === 'passing').length;
const failing = features.length - passing;
const percent = features.length === 0 ? 0 : (100 * passing) / features.length;

console.log(`Passing: ${passing}`);
console.log(`Failing: ${failing}`);
console.log(`Total:   ${features.length} (${percent.toFixed(1)}% passing)`);

console.log('\nBy milestone:');
for (const [milestone, name] of Object.entries(list.milestones)) {
  const inMilestone = features.filter((f) => f.milestone === Number(milestone));
  const done = inMilestone.filter((f) => f.status === 'passing').length;
  console.log(`  M${milestone.padEnd(2)}  ${`${done}/${inMilestone.length}`.padStart(7)}  ${name}`);
}

const next = features.find((f) => f.status === 'failing');
console.log(next ? `\nNext: ${next.id} (M${next.milestone}) ${next.description}` : '\nEvery feature passes.');
