import { describe, expect, it } from 'vitest';
import {
  COMPRESSED_UPLOAD,
  DEFAULT_COMPRESSED_MS_PER_BYTE,
  DEFAULT_UNCOMPRESSED_MS_PER_BYTE,
  DEFAULT_UPLOAD_COST_OUTLIER_FACTOR,
  DEFAULT_UPLOAD_COST_SMOOTHING,
  UNCOMPRESSED_UPLOAD,
  UploadCostModel,
  type UploadCostOptions,
} from './upload-cost.js';

const MIB = 1024 * 1024;

describe('UploadCostModel', () => {
  it('starts from conservative seeds, compressed cheaper than uncompressed', () => {
    const model = new UploadCostModel();
    expect(model.predictMs(MIB, false)).toBeCloseTo(2, 12);
    expect(model.predictMs(MIB, true)).toBeCloseTo(1, 12);
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBe(DEFAULT_UNCOMPRESSED_MS_PER_BYTE);
    expect(model.msPerByte[COMPRESSED_UPLOAD]).toBe(DEFAULT_COMPRESSED_MS_PER_BYTE);
    // A 256 px RGBA8 tile with its mip chain: three fit a 2 ms frame before any measurement.
    expect(model.predictMs(349_524, false) * 3).toBeLessThan(2);
    expect(model.predictMs(349_524, false) * 4).toBeGreaterThan(2);
    expect(model.sampleCount(false)).toBe(0);
  });

  it('averages the seed with the first samples, then weights new samples by the smoothing', () => {
    const model = new UploadCostModel({ uncompressedMsPerByte: 1e-6, smoothing: 0.25, outlierFactor: 100 });
    model.record(1_000_000, 2, false); // sample 2e-6, weight 1/2
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(1.5e-6, 15);
    model.record(1_000_000, 3, false); // sample 3e-6, weight 1/3
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(2e-6, 15);
    model.record(1_000_000, 4, false); // weight 1/4 = smoothing
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(2.5e-6, 15);
    model.record(1_000_000, 4.5, false); // weight stays 0.25 (1/5 < 0.25)
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(3e-6, 15);
    expect(model.sampleCount(false)).toBe(4);
  });

  it('uses a smoothing of 0.1 and an outlier clamp of 8 by default', () => {
    expect(DEFAULT_UPLOAD_COST_SMOOTHING).toBe(0.1);
    expect(DEFAULT_UPLOAD_COST_OUTLIER_FACTOR).toBe(8);
    const seed: UploadCostOptions = { uncompressedMsPerByte: 1e-6 };
    const model = new UploadCostModel(seed);
    for (let i = 0; i < 9; i++) model.record(1_000_000, 1, false);
    // After warm-up (weights 1/2 … 1/10), a sample moves the estimate by a tenth of the difference.
    const before = model.msPerByte[UNCOMPRESSED_UPLOAD] ?? 0;
    model.record(1_000_000, 2, false);
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(before + (2e-6 - before) * 0.1, 15);
    // A sample 1,000 times the estimate enters as 8 times it.
    const fresh = new UploadCostModel(seed);
    fresh.record(1_000_000, 1000, false);
    expect(fresh.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo((1e-6 + 8e-6) / 2, 15);
  });

  it('converges to a steady measured rate', () => {
    const model = new UploadCostModel();
    for (let i = 0; i < 200; i++) model.record(500_000, 0.25, false);
    expect(model.predictMs(1_000_000, false)).toBeCloseTo(0.5, 6);
  });

  it('keeps the compressed and uncompressed averages apart', () => {
    const model = new UploadCostModel();
    for (let i = 0; i < 50; i++) model.record(100_000, 1, true);
    expect(model.predictMs(100_000, true)).toBeGreaterThan(0.9);
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBe(DEFAULT_UNCOMPRESSED_MS_PER_BYTE);
    expect(model.sampleCount(true)).toBe(50);
    expect(model.sampleCount(false)).toBe(0);
  });

  it('clamps outliers to a bounded step', () => {
    const model = new UploadCostModel({ uncompressedMsPerByte: 1e-6, smoothing: 0.1, outlierFactor: 8 });
    // A 1 s stall on a 1 MB upload (1,000 times the estimate) enters as 8e-6, averaged with weight 1/2.
    model.record(1_000_000, 1000, false);
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo(4.5e-6, 15);
    // A 0 ms reading from a coarse clock enters as estimate / 8.
    const fresh = new UploadCostModel({ uncompressedMsPerByte: 8e-6, outlierFactor: 8 });
    fresh.record(1_000_000, 0, false);
    expect(fresh.msPerByte[UNCOMPRESSED_UPLOAD]).toBeCloseTo((8e-6 + 1e-6) / 2, 15);
    expect(fresh.predictMs(1_000_000, false)).toBeGreaterThan(0);
  });

  it('ignores samples without bytes or with an invalid duration', () => {
    const model = new UploadCostModel();
    model.record(0, 1, false);
    model.record(1000, -1, false);
    model.record(1000, Number.NaN, false);
    model.record(1000, Infinity, false);
    expect(model.sampleCount(false)).toBe(0);
    expect(model.msPerByte[UNCOMPRESSED_UPLOAD]).toBe(DEFAULT_UNCOMPRESSED_MS_PER_BYTE);
  });

  it('records durations read from an array', () => {
    const model = new UploadCostModel({ compressedMsPerByte: 1e-6, outlierFactor: 100 });
    const durations = new Float64Array([9, 3]);
    model.recordAt(1_000_000, durations, 1, true);
    expect(model.msPerByte[COMPRESSED_UPLOAD]).toBeCloseTo(2e-6, 15);
  });

  it('rejects invalid settings', () => {
    expect(() => new UploadCostModel({ uncompressedMsPerByte: 0 })).toThrow(RangeError);
    expect(() => new UploadCostModel({ compressedMsPerByte: Infinity })).toThrow(RangeError);
    expect(() => new UploadCostModel({ smoothing: 0 })).toThrow(RangeError);
    expect(() => new UploadCostModel({ smoothing: 1.5 })).toThrow(RangeError);
    expect(() => new UploadCostModel({ outlierFactor: 0.5 })).toThrow(RangeError);
    expect(() => new UploadCostModel({ outlierFactor: Infinity })).toThrow(RangeError);
  });
});
