// The fixture tiles in the lossy and alpha-capable browser formats (F242): JPEG through jpeg-js, WebP and AVIF through
// the jSquash WebAssembly encoders, all permissively licensed development dependencies.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import jpeg from 'jpeg-js';
import { type FixtureTile, renderTile } from './generate.ts';

/** The browser image formats the fixture server encodes besides PNG. */
export const IMAGE_FORMATS: readonly string[] = ['jpg', 'webp', 'avif'];
export type ImageFormat = 'jpg' | 'webp' | 'avif';

const require = createRequire(import.meta.url);
type Encoder = (image: ImageData, options: Record<string, unknown>) => Promise<ArrayBuffer>;
const encoders = new Map<string, Promise<Encoder>>();

/** Loads a jSquash encoder once, compiling its WebAssembly from the package. */
function encoder(format: 'webp' | 'avif'): Promise<Encoder> {
  let loaded = encoders.get(format);
  if (!loaded) {
    loaded = (async () => {
      const module = (await (format === 'webp'
        ? import('@jsquash/webp/encode.js')
        : import('@jsquash/avif/encode.js'))) as unknown as {
        default: Encoder;
        init: (wasm: WebAssembly.Module) => Promise<unknown>;
      };
      const wasm = readFileSync(require.resolve(`@jsquash/${format}/codec/enc/${format}_enc.wasm`));
      await module.init(await WebAssembly.compile(wasm));
      return module.default;
    })();
    encoders.set(format, loaded);
  }
  return loaded;
}

/** Encodes a tile as JPEG (quality 90), WebP (quality 90, alpha kept) or AVIF (quality 80, alpha kept). */
export async function encodeTileImage(tile: FixtureTile, format: ImageFormat): Promise<Buffer> {
  const size = tile.sizePx ?? 256;
  const rgba = renderTile(tile);
  if (format === 'jpg') return jpeg.encode({ data: Buffer.from(rgba), width: size, height: size }, 90).data;
  const image = { data: new Uint8ClampedArray(rgba.buffer), width: size, height: size, colorSpace: 'srgb' };
  const options = format === 'webp' ? { quality: 90 } : { quality: 80, speed: 8 };
  return Buffer.from(await (await encoder(format))(image as ImageData, options));
}
