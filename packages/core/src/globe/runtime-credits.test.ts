import { describe, expect, it } from 'vitest';
import type { Attribution } from '../imagery/credits.js';
import type { DrawList } from '../imagery/draw-list.js';
import { RuntimeCredits, runtimeCredits } from './runtime-credits.js';
import type { ImagerySource } from '../imagery/imagery-source.js';
import type { RendererBackend } from './types.js';

describe('runtime credits', () => {
  it('reports a source whose attribution changed at runtime on refresh, and only a change (F258)', () => {
    const source: { id: string; attribution: Attribution[] } = { id: 'g', attribution: [{ text: '© 2026 A' }] };
    const reported: string[][] = [];
    const credits = new RuntimeCredits(
      [source],
      new Set(),
      (list) => reported.push(list.map((credit) => credit.text)),
      () => undefined,
      -1,
    );
    credits.visible.mark(0);
    credits.afterFrame({} as DrawList, 0);
    expect(reported).toEqual([['© 2026 A']]);
    credits.refresh();
    expect(reported).toHaveLength(1);
    source.attribution = [{ text: '© 2026 B' }];
    credits.refresh();
    expect(reported.at(-1)).toEqual(['© 2026 B']);
    credits.refresh();
    expect(reported).toHaveLength(2);
  });

  it('leaves the credits element out when the application shows the credits itself (creditsElement: false)', () => {
    const shown: number[] = [];
    const renderer = { host: { showCredits: () => void shown.push(1) } } as unknown as RendererBackend;
    const source = { id: 'a', attribution: [{ text: 'A' }] } as unknown as ImagerySource;
    const reported: number[] = [];
    for (const creditsElement of [true, false]) {
      const credits = runtimeCredits(
        [source],
        -1,
        renderer,
        {
          requestFrame: () => undefined,
          tileError: () => undefined,
          creditsChange: () => void reported.push(1),
          creditsElement,
        },
        undefined,
      );
      credits.visible.mark(0);
      credits.afterFrame({} as DrawList, 0);
    }
    expect(shown).toHaveLength(1);
    expect(reported).toHaveLength(2);
  });

  it('lists the credit of a terrain tile drawn, from an offline package, under the terrain source (KB-193)', () => {
    const terrain = { id: 'relief', attribution: [{ text: 'Relief' }] };
    const reported: string[][] = [];
    const credits = new RuntimeCredits(
      [undefined, terrain],
      new Set(),
      (list) => reported.push(list.map((credit) => credit.text)),
      () => undefined,
      1,
    );
    const pack = { text: '© Package' };
    const list = { terrain: { textures: new Int32Array([7]) } } as unknown as DrawList;
    credits.afterFrame(list, 1, { attributionOf: (handle) => (handle === 7 ? pack : undefined) });
    expect(reported.at(-1)).toEqual(['Relief', '© Package']);
  });
});
