// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The KTX2 container reader and target choice of ADR 0020 (rules 2, 3 and 6): validates a file and predicts the bytes
 * of every level before any WebAssembly runs, and picks the GPU format a tile is transcoded to. Pure functions, run in
 * the worker by the `transcode-ktx2` task and in Node by the tests.
 */
import {
  ASTC_4X4_FORMAT,
  BC1_FORMAT,
  BC7_FORMAT,
  blockCompressedBytes,
  ETC2_RGB8_FORMAT,
  ETC2_RGBA8_FORMAT,
  fullMipLevelCount,
  rgba8Bytes,
  type BlockFormat,
} from '../cache/byte-size.js';

/**
 * The formats a KTX2 tile reaches the GPU in. `etc2-rgb` holds ETC1 blocks, which every ETC2 decoder reads; `rgba8`
 * is the fallback where the device has no suitable compressed format.
 */
export type Ktx2Target = 'rgba8' | 'bc1' | 'bc7' | 'etc2-rgb' | 'etc2-rgba' | 'astc-4x4';

/** Number of each target in the transcoder's C interface (`packages/worker/wasm/basis-transcoder.cpp`). */
export const KTX2_TARGET_CODES: Readonly<Record<Ktx2Target, number>> = Object.freeze({
  rgba8: 0,
  bc1: 1,
  bc7: 2,
  'etc2-rgb': 3,
  'etc2-rgba': 4,
  'astc-4x4': 5,
});

/** How a file's texels are stored: Basis ETC1S, Basis UASTC LDR 4x4, or blocks of a GPU format already. */
export type Ktx2Kind = 'etc1s' | 'uastc' | 'raw';

/** What the reader learned from a valid file. */
export interface Ktx2Info {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Levels stored in the file, the full-size one first. */
  readonly levelCount: number;
  readonly kind: Ktx2Kind;
  /** The GPU format of a `raw` file's blocks, when the engine knows it. */
  readonly rawTarget: Ktx2Target | undefined;
  readonly hasAlpha: boolean;
  /** The data use the sRGB transfer function (imagery always should). */
  readonly srgb: boolean;
  /** Size multiple of 4 with every level down to 1 × 1: the file can keep its own mip chain (ADR 0020 rule 2). */
  readonly blockReady: boolean;
}

/** Why a file was refused: not a valid KTX2 file, or valid but outside what the engine supports. */
export type Ktx2ErrorCode = 'invalid' | 'unsupported';

/** A refused KTX2 file. */
export class Ktx2Error extends Error {
  readonly code: Ktx2ErrorCode;

  constructor(code: Ktx2ErrorCode, message: string) {
    super(message);
    this.name = 'Ktx2Error';
    this.code = code;
  }
}

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 80;
const LEVEL_INDEX_ENTRY_BYTES = 24;
/**
 * Largest tile edge accepted (imagery tiles are 256 or 512 px), so a hostile header cannot make the transcoder's
 * memory, which never shrinks, grow beyond 16 MB for one level.
 */
const MAX_EDGE_PX = 2048;
const SUPERCOMPRESSION_NONE = 0;
const SUPERCOMPRESSION_BASIS_LZ = 1;
const SUPERCOMPRESSION_ZSTD = 2;
const MODEL_ETC1S = 163;
const MODEL_UASTC = 166;
const TRANSFER_SRGB = 2;
const CHANNEL_ETC1S_AAA = 15;
const CHANNEL_UASTC_RGBA = 3;
const DFD_SAMPLES_OFFSET = 28;
const DFD_SAMPLE_BYTES = 16;

/** Vulkan formats a `raw` file may hold, by the target they upload as; sRGB and UNORM variants alike. */
const RAW_FORMATS: ReadonlyMap<number, { target: Ktx2Target; srgb: boolean; alpha: boolean }> = new Map([
  [37, { target: 'rgba8', srgb: false, alpha: true }],
  [43, { target: 'rgba8', srgb: true, alpha: true }],
  [131, { target: 'bc1', srgb: false, alpha: false }],
  [132, { target: 'bc1', srgb: true, alpha: false }],
  [145, { target: 'bc7', srgb: false, alpha: true }],
  [146, { target: 'bc7', srgb: true, alpha: true }],
  [147, { target: 'etc2-rgb', srgb: false, alpha: false }],
  [148, { target: 'etc2-rgb', srgb: true, alpha: false }],
  [151, { target: 'etc2-rgba', srgb: false, alpha: true }],
  [152, { target: 'etc2-rgba', srgb: true, alpha: true }],
  [157, { target: 'astc-4x4', srgb: false, alpha: true }],
  [158, { target: 'astc-4x4', srgb: true, alpha: true }],
]);

const BLOCK_FORMATS: Readonly<Record<Exclude<Ktx2Target, 'rgba8'>, BlockFormat>> = {
  bc1: BC1_FORMAT,
  bc7: BC7_FORMAT,
  'etc2-rgb': ETC2_RGB8_FORMAT,
  'etc2-rgba': ETC2_RGBA8_FORMAT,
  'astc-4x4': ASTC_4X4_FORMAT,
};

/** The compressed family a target needs, as the renderer names it in `compressedTextureFormats`. */
const FAMILY: Readonly<Record<Ktx2Target, string | undefined>> = {
  rgba8: undefined,
  bc1: 'bc',
  bc7: 'bc',
  'etc2-rgb': 'etc2',
  'etc2-rgba': 'etc2',
  'astc-4x4': 'astc',
};

/** True when `bytes` start with the KTX2 identifier. */
export function isKtx2(bytes: Uint8Array): boolean {
  if (bytes.length < IDENTIFIER.length) return false;
  for (let i = 0; i < IDENTIFIER.length; i++) if (bytes[i] !== IDENTIFIER[i]) return false;
  return true;
}

function invalid(message: string): Ktx2Error {
  return new Ktx2Error('invalid', message);
}

/** A 64-bit little-endian field that must fit in the file. */
function u64(view: DataView, offset: number): number {
  if (view.getUint32(offset + 4, true) !== 0) throw invalid(`the 64-bit field at ${offset} is out of range`);
  return view.getUint32(offset, true);
}

function checkRange(offset: number, length: number, fileBytes: number, what: string): void {
  if (offset + length > fileBytes) throw invalid(`${what} (${length} bytes at ${offset}) runs past the file end`);
}

interface Descriptor {
  readonly model: number;
  readonly srgb: boolean;
  readonly alphaChannel: boolean;
}

function readDescriptor(view: DataView, offset: number, length: number): Descriptor {
  if (length < DFD_SAMPLES_OFFSET) throw invalid(`the data format descriptor is ${length} bytes, too short`);
  const model = view.getUint8(offset + 12);
  const srgb = view.getUint8(offset + 14) === TRANSFER_SRGB;
  const blockBytes = view.getUint16(offset + 10, true);
  const samples = Math.floor((Math.min(blockBytes + 4, length) - DFD_SAMPLES_OFFSET) / DFD_SAMPLE_BYTES);
  let alphaChannel = false;
  for (let i = 0; i < samples; i++) {
    const channel = view.getUint8(offset + DFD_SAMPLES_OFFSET + i * DFD_SAMPLE_BYTES + 3) & 0x0f;
    if (model === MODEL_ETC1S && channel === CHANNEL_ETC1S_AAA) alphaChannel = true;
    if (model === MODEL_UASTC && channel === CHANNEL_UASTC_RGBA) alphaChannel = true;
  }
  return { model, srgb, alphaChannel };
}

function kindOf(vkFormat: number, scheme: number, model: number): Ktx2Kind {
  if (vkFormat === 0 && scheme === SUPERCOMPRESSION_BASIS_LZ && model === MODEL_ETC1S) return 'etc1s';
  if (vkFormat === 0 && model === MODEL_UASTC && (scheme === SUPERCOMPRESSION_NONE || scheme === SUPERCOMPRESSION_ZSTD))
    return 'uastc';
  if (vkFormat !== 0 && scheme === SUPERCOMPRESSION_NONE && RAW_FORMATS.has(vkFormat)) return 'raw';
  throw new Ktx2Error(
    'unsupported',
    `KTX2 data of Vulkan format ${vkFormat}, color model ${model} and supercompression ${scheme} are not supported`,
  );
}

/**
 * Checks each level's uncompressed size, which the transcoder allocates before decompressing: a hostile value would
 * otherwise grow its memory, which never shrinks, by up to 4 GB. BasisLZ levels declare 0, UASTC levels 16 bytes per
 * 4 × 4 block, raw levels their stored length.
 */
function checkUncompressedSizes(
  view: DataView,
  kind: Ktx2Kind,
  widthPx: number,
  heightPx: number,
  levels: number,
): void {
  for (let level = 0; level < levels; level++) {
    const entry = HEADER_BYTES + level * LEVEL_INDEX_ENTRY_BYTES;
    const [width, height] = ktx2LevelSize(widthPx, heightPx, level);
    const expected =
      kind === 'etc1s'
        ? 0
        : kind === 'uastc'
          ? Math.ceil(width / 4) * Math.ceil(height / 4) * 16
          : u64(view, entry + 8);
    const declared = u64(view, entry + 16);
    if (declared !== expected) throw invalid(`level ${level} declares ${declared} uncompressed bytes, not ${expected}`);
  }
}

/**
 * Reads and validates a KTX2 file: identifier, header, level index and data format descriptor. Throws a
 * {@link Ktx2Error}: `invalid` for a malformed or truncated file, `unsupported` for a valid one the engine does not
 * handle (3D, arrays, cube maps, HDR, unknown formats or edges above 2048 px).
 */
export function readKtx2(bytes: Uint8Array): Ktx2Info {
  if (!isKtx2(bytes)) throw invalid('the KTX2 identifier is missing');
  if (bytes.length < HEADER_BYTES) throw invalid(`a KTX2 header needs ${HEADER_BYTES} bytes, got ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vkFormat = view.getUint32(12, true);
  const widthPx = view.getUint32(20, true);
  const heightPx = view.getUint32(24, true);
  const depth = view.getUint32(28, true);
  const layers = view.getUint32(32, true);
  const faces = view.getUint32(36, true);
  const levelCount = Math.max(1, view.getUint32(40, true));
  const scheme = view.getUint32(44, true);
  if (widthPx < 1 || heightPx < 1) throw invalid(`the texture is ${widthPx}×${heightPx}`);
  if (depth > 1 || layers > 1 || faces !== 1)
    throw new Ktx2Error('unsupported', 'only 2D textures without layers or faces are supported');
  if (widthPx > MAX_EDGE_PX || heightPx > MAX_EDGE_PX)
    throw new Ktx2Error('unsupported', `${widthPx}×${heightPx} exceeds the ${MAX_EDGE_PX} px tile limit`);
  if (levelCount > fullMipLevelCount(widthPx, heightPx))
    throw invalid(`${levelCount} levels for ${widthPx}×${heightPx}`);
  const indexBytes = levelCount * LEVEL_INDEX_ENTRY_BYTES;
  checkRange(HEADER_BYTES, indexBytes, bytes.length, 'the level index');
  for (let level = 0; level < levelCount; level++) {
    const entry = HEADER_BYTES + level * LEVEL_INDEX_ENTRY_BYTES;
    checkRange(u64(view, entry), u64(view, entry + 8), bytes.length, `level ${level}`);
  }
  const dfdOffset = view.getUint32(48, true);
  const dfdLength = view.getUint32(52, true);
  checkRange(dfdOffset, dfdLength, bytes.length, 'the data format descriptor');
  const descriptor = readDescriptor(view, dfdOffset, dfdLength);
  const kind = kindOf(vkFormat, scheme, descriptor.model);
  checkRange(u64(view, 64), u64(view, 72), bytes.length, 'the supercompression global data');
  checkUncompressedSizes(view, kind, widthPx, heightPx, levelCount);
  const raw = kind === 'raw' ? RAW_FORMATS.get(vkFormat) : undefined;
  const fullChain = levelCount === fullMipLevelCount(widthPx, heightPx);
  return {
    widthPx,
    heightPx,
    levelCount,
    kind,
    rawTarget: raw?.target,
    hasAlpha: raw ? raw.alpha : descriptor.alphaChannel,
    srgb: raw ? raw.srgb : descriptor.srgb,
    blockReady: widthPx % 4 === 0 && heightPx % 4 === 0 && fullChain,
  };
}

/**
 * The format a tile reaches the GPU in (ADR 0020 rule 3), from the file and the compressed families the device
 * decodes (`RendererCapabilities.compressedTextureFormats`). BC wherever it exists, since desktop drivers may emulate
 * ETC2 and ASTC; then ETC2 for ETC1S and ASTC for UASTC; RGBA8 when nothing fits or the file cannot keep its chain.
 * Returns undefined for a raw file whose format the device cannot decode (no transcoder handles raw blocks).
 */
export function chooseKtx2Target(info: Ktx2Info, formats: readonly string[]): Ktx2Target | undefined {
  if (info.kind === 'raw') {
    const target = info.rawTarget ?? 'rgba8';
    const family = FAMILY[target];
    return family === undefined || formats.includes(family) ? target : undefined;
  }
  if (!info.blockReady) return 'rgba8';
  const bc = formats.includes('bc');
  const etc2 = formats.includes('etc2');
  const astc = formats.includes('astc');
  const etc2Target: Ktx2Target = info.hasAlpha ? 'etc2-rgba' : 'etc2-rgb';
  if (info.kind === 'etc1s') {
    if (bc) return info.hasAlpha ? 'bc7' : 'bc1';
    if (etc2) return etc2Target;
    return astc ? 'astc-4x4' : 'rgba8';
  }
  if (bc) return 'bc7';
  if (astc) return 'astc-4x4';
  return etc2 ? etc2Target : 'rgba8';
}

/** Bytes of one level in `target`; RGBA8 levels are `width × height × 4`. */
export function ktx2LevelBytes(target: Ktx2Target, widthPx: number, heightPx: number): number {
  return target === 'rgba8'
    ? rgba8Bytes(widthPx, heightPx, 1)
    : blockCompressedBytes(widthPx, heightPx, BLOCK_FORMATS[target], 1);
}

/**
 * GPU bytes of a tile in `target` (ADR 0020 rule 6): the exact sum of its levels. A compressed tile keeps the file's
 * chain; an RGBA8 tile uploads its base level and gets a full chain of GPU-generated mipmaps.
 */
export function ktx2GpuBytes(info: Ktx2Info, target: Ktx2Target): number {
  return target === 'rgba8'
    ? rgba8Bytes(info.widthPx, info.heightPx)
    : blockCompressedBytes(info.widthPx, info.heightPx, BLOCK_FORMATS[target], info.levelCount);
}

/** Width and height of `level` in a chain starting at `widthPx` × `heightPx`. */
export function ktx2LevelSize(widthPx: number, heightPx: number, level: number): [number, number] {
  return [Math.max(1, widthPx >> level), Math.max(1, heightPx >> level)];
}

/** One level of a compressed tile, ready for upload. */
export interface CompressedLevel {
  readonly data: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** A tile in a block-compressed format, as the `transcode-ktx2` task returns it in `DecodedTile.image`. */
export interface CompressedTileImage {
  readonly kind: 'compressed';
  readonly target: Exclude<Ktx2Target, 'rgba8'>;
  readonly srgb: boolean;
  /** The mip chain, full size first. */
  readonly levels: readonly CompressedLevel[];
}

/** Byte offset and length of a raw file's level `level` (for pass-through). */
export function ktx2LevelRange(bytes: Uint8Array, level: number): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entry = HEADER_BYTES + level * LEVEL_INDEX_ENTRY_BYTES;
  return [u64(view, entry), u64(view, entry + 8)];
}
