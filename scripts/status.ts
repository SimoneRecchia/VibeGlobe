// Prints how many feature_list.json entries pass and how many fail, per milestone, how many an owner decision
// superseded (ADR 0016), and the next failing entry (file order is priority order).
import { FEATURE_STATUSES, loadFeatureList } from './feature-list.ts';

const list = loadFeatureList();
const { features } = list;

const invalid = features.filter((f) => !(FEATURE_STATUSES as readonly string[]).includes(f.status));
const duplicateIds = features.map((f) => f.id).filter((id, index, ids) => ids.indexOf(id) !== index);
if (invalid.length > 0 || duplicateIds.length > 0) {
  if (invalid.length > 0)
    console.error(`Invalid status (expected ${FEATURE_STATUSES.join(', ')}): ${invalid.map((f) => f.id).join(', ')}`);
  if (duplicateIds.length > 0) console.error(`Duplicate ids: ${duplicateIds.join(', ')}`);
  process.exit(1);
}

const active = features.filter((f) => f.status !== 'superseded');
const passing = active.filter((f) => f.status === 'passing').length;
const pending = active.filter((f) => f.status === 'pending').length;
const failing = active.length - passing - pending;
const superseded = features.length - active.length;
const percent = active.length === 0 ? 0 : (100 * passing) / active.length;

console.log(`Passing:    ${passing}`);
console.log(`Failing:    ${failing}`);
console.log(`Pending:    ${pending} (waiting only for owner-only steps, docs/internal/open-questions.md)`);
console.log(`Superseded: ${superseded} (replaced by owner decisions, docs/internal/feature-changes.md)`);
console.log(`Total:      ${features.length} (${percent.toFixed(1)}% of the ${active.length} active entries passing)`);

console.log('\nBy milestone (passing/active, pending, superseded):');
for (const [milestone, name] of Object.entries(list.milestones)) {
  const inMilestone = features.filter((f) => f.milestone === Number(milestone));
  const activeInMilestone = inMilestone.filter((f) => f.status !== 'superseded');
  const done = activeInMilestone.filter((f) => f.status === 'passing').length;
  const pendingInMilestone = activeInMilestone.filter((f) => f.status === 'pending').length;
  const pendingNote = pendingInMilestone > 0 ? `  (${pendingInMilestone} pending)` : '';
  const supersededNote =
    inMilestone.length > activeInMilestone.length
      ? `  (${inMilestone.length - activeInMilestone.length} superseded)`
      : '';
  console.log(
    `  M${milestone.padEnd(2)}  ${`${done}/${activeInMilestone.length}`.padStart(7)}  ${name}${pendingNote}${supersededNote}`,
  );
}

const next = features.find((f) => f.status === 'failing');
console.log(next ? `\nNext: ${next.id} (M${next.milestone}) ${next.description}` : '\nEvery active feature passes.');
