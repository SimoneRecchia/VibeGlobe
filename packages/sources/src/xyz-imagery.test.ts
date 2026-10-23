import { describe, expect, it } from 'vitest';
import { xyzImagery } from './xyz-imagery.js';

const coord = { root: 0 as const, level: 3, x: 5, y: 2 };

describe('xyzImagery high-DPI variants (F241)', () => {
  it('fills {r} with @2x only when the engine asks for pixel ratio 2, and declares the source high-DPI', () => {
    const source = xyzImagery({ id: 'a', url: 'https://t/{z}/{x}/{y}{r}.png' });
    expect(source.highDpi).toBe(true);
    const out = { url: '', hostIndex: 0 };
    expect(source.request(coord, out)).toMatchObject({ url: 'https://t/3/5/2.png' });
    expect(source.request(coord, out, 1)).toMatchObject({ url: 'https://t/3/5/2.png' });
    expect(source.request(coord, out, 2)).toMatchObject({ url: 'https://t/3/5/2@2x.png' });
  });

  it('leaves a template without {r} at one variant', () => {
    const source = xyzImagery({ id: 'a', url: 'https://t/{z}/{x}/{y}.png' });
    expect(source.highDpi).toBeUndefined();
    expect(source.request(coord, { url: '', hostIndex: 0 }, 2)).toMatchObject({ url: 'https://t/3/5/2.png' });
  });
});
