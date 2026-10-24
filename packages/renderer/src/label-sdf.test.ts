import { describe, expect, it } from 'vitest';
import { FieldWaits, type LabelSdf } from './label-sdf.js';

describe('label fields (F358)', () => {
  it('rewrites the features that waited when fields arrive, and rebuilds every label batch when the atlas starts over', () => {
    const labels = { revision: 0, atlas: { generation: 0 } };
    const waits = new FieldWaits<string>();
    const rewritten: string[] = [];
    let rebuilds = 0;
    const settle = (): void =>
      waits.settle(
        labels as unknown as LabelSdf,
        (batch, feature) => rewritten.push(`${batch}:${String(feature)}`),
        () => rebuilds++,
      );
    waits.current = 'a';
    expect(waits.note(3)).toBeUndefined();
    waits.note(7);
    waits.current = undefined;
    waits.note(9);
    settle();
    expect(rewritten).toEqual([]);
    labels.revision = 1;
    settle();
    expect(rewritten).toEqual(['a:3', 'a:7']);
    settle();
    expect(rewritten).toHaveLength(2);
    waits.current = 'b';
    waits.note(1);
    labels.revision = 3;
    labels.atlas.generation = 1;
    settle();
    expect([rewritten.length, rebuilds]).toEqual([2, 1]);
  });
});
