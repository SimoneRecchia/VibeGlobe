import { describe, expect, it } from 'vitest';
import { readGeoidFile, writeGeoidFile } from './geoid-file.js';
import { geoidModel } from './vertical-datum.js';

describe('geoid grid file (F133)', () => {
  it('round-trips a grid', () => {
    const model = geoidModel(3, 4, Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, -12.5]));
    const read = readGeoidFile(writeGeoidFile(model));
    expect([read.rows, read.columns]).toEqual([3, 4]);
    expect([...read.undulationsMeters]).toEqual([...model.undulationsMeters]);
  });

  it('rejects other files, wrong sizes and truncated values', () => {
    const good = writeGeoidFile(geoidModel(2, 2, new Float32Array(4)));
    expect(() => readGeoidFile(new ArrayBuffer(8))).toThrow(RangeError);
    const wrongMagic = good.slice(0);
    new DataView(wrongMagic).setUint8(0, 0x41);
    expect(() => readGeoidFile(wrongMagic)).toThrow(/not a VGEOID1/);
    expect(() => readGeoidFile(good.slice(0, good.byteLength - 4))).toThrow(RangeError);
  });
});
