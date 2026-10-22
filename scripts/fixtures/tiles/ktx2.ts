// KTX2 fixture tiles (ADR 0020, Verification): the fixture patterns encoded to ETC1S or UASTC with a full mip chain
// by the Basis Universal encoder that `@loaders.gl/textures` ships (Binomial's own WebAssembly build, Apache-2.0),
// pinned through the lockfile. Test tooling only: nothing here reaches the engine's packages.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';

/** The Basis modes of the fixtures. */
export type Ktx2Mode = 'etc1s' | 'uastc';

interface BasisEncoder {
  setCreateKTX2File(on: boolean): void;
  setKTX2UASTCSupercompression(on: boolean): void;
  setKTX2AndBasisSRGBTransferFunc(on: boolean): void;
  setSliceSourceImage(slice: number, rgba: Uint8Array, width: number, height: number, isPng: boolean): boolean;
  setUASTC(on: boolean): void;
  setMipGen(on: boolean): void;
  setMipSRGB(on: boolean): void;
  setQualityLevel(level: number): void;
  setPerceptual(on: boolean): void;
  setCheckForAlpha(on: boolean): void;
  setStatusOutput(on: boolean): void;
  setDebug(on: boolean): void;
  encode(out: Uint8Array): number;
  delete(): void;
}

interface BasisModule {
  initializeBasis(): void;
  BasisEncoder: new () => BasisEncoder;
}

let basis: Promise<BasisModule> | undefined;

function loadEncoder(): Promise<BasisModule> {
  const entry = fileURLToPath(import.meta.resolve('@loaders.gl/textures'));
  const directory = join(dirname(entry), 'libs');
  // The encoder is a CommonJS script inside an ES module package, so it is evaluated with a CommonJS wrapper.
  const path = join(directory, 'basis_encoder.js');
  const module = { exports: {} as unknown };
  compileFunction(readFileSync(path, 'utf8'), ['module', 'exports', 'require', '__filename', '__dirname'])(
    module,
    module.exports,
    createRequire(path),
    path,
    directory,
  );
  const factory = module.exports as (options: { wasmBinary: Uint8Array }) => Promise<BasisModule>;
  return factory({ wasmBinary: readFileSync(join(directory, 'basis_encoder.wasm')) }).then((basisModule) => {
    basisModule.initializeBasis();
    return basisModule;
  });
}

/**
 * Encodes RGBA pixels (rows from the north, sRGB) into a KTX2 file with a full mip chain: ETC1S (BasisLZ) or UASTC
 * with Zstandard supercompression. Alpha is stored only when some pixel is not opaque.
 */
export async function encodeKtx2(rgba: Uint8Array, widthPx: number, heightPx: number, mode: Ktx2Mode): Promise<Buffer> {
  basis ??= loadEncoder();
  const encoder = new (await basis).BasisEncoder();
  try {
    encoder.setStatusOutput(false);
    encoder.setDebug(false);
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setKTX2AndBasisSRGBTransferFunc(true);
    encoder.setPerceptual(true);
    encoder.setMipSRGB(true);
    encoder.setMipGen(true);
    encoder.setCheckForAlpha(true);
    encoder.setUASTC(mode === 'uastc');
    encoder.setQualityLevel(255);
    encoder.setSliceSourceImage(0, rgba, widthPx, heightPx, false);
    const out = new Uint8Array(widthPx * heightPx * 8 + 65536);
    const length = encoder.encode(out);
    if (length === 0) throw new Error(`the Basis encoder failed on a ${widthPx}×${heightPx} ${mode} image`);
    return Buffer.from(out.subarray(0, length));
  } finally {
    encoder.delete();
  }
}
