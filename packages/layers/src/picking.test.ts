import { describe, expect, it } from 'vitest';
import {
  MAX_PICK_FEATURE_INDEX,
  PickSlotTable,
  decodePickColor,
  encodePickColor,
  packPickId,
  pickFeatureIndex,
  pickNearest,
  pickSlot,
} from './picking.js';

describe('picking id scheme', () => {
  it('packs a layer slot and feature index into RGBA8 and back', () => {
    const bytes = new Uint8Array(4);
    for (const [slot, index] of [
      [1, 0],
      [255, MAX_PICK_FEATURE_INDEX],
      [17, 123_456],
    ] as const) {
      const id = packPickId(slot, index);
      expect(id).toBeGreaterThan(0);
      encodePickColor(id, bytes);
      const decoded = decodePickColor(bytes);
      expect(decoded).toBe(id);
      expect(pickSlot(decoded)).toBe(slot);
      expect(pickFeatureIndex(decoded)).toBe(index);
    }
    expect(() => packPickId(0, 1)).toThrow(RangeError);
    expect(() => packPickId(256, 1)).toThrow(RangeError);
    expect(() => packPickId(1, MAX_PICK_FEATURE_INDEX + 1)).toThrow(RangeError);
  });

  it('picks the feature nearest the center of the readback region', () => {
    const rgba = new Uint8Array(5 * 5 * 4);
    encodePickColor(packPickId(2, 9), rgba, (0 * 5 + 0) * 4);
    encodePickColor(packPickId(3, 7), rgba, (2 * 5 + 3) * 4);
    expect(pickNearest(rgba, 5, 5)).toBe(packPickId(3, 7));
    expect(pickNearest(new Uint8Array(5 * 5 * 4), 5, 5)).toBe(0);
  });

  it('does not reuse a freed slot at once, and maps slots back to owners', () => {
    const table = new PickSlotTable<string>();
    const a = table.acquire('a');
    const b = table.acquire('b');
    table.release(a);
    const c = table.acquire('c');
    expect(c).not.toBe(a);
    expect(table.owner(packPickId(b, 5))).toBe('b');
    expect(table.owner(packPickId(a, 5))).toBeUndefined();
    const full = new PickSlotTable<number>();
    for (let i = 0; i < 255; i++) full.acquire(i);
    expect(() => full.acquire(255)).toThrow(RangeError);
  });
});
