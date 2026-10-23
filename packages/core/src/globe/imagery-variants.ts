import type { ImageryLayer } from '../imagery/imagery-draws.js';

/**
 * Picks the tiles of high-DPI sources for render-target pixels per CSS pixel `pixelRatio`: their `@2x` tiles above 1,
 * reloaded when the choice changes (F241). A tile of 512 texels or more (512-pixel or `@2x` tiles) serves the next
 * finer surface level, so the texels on screen stay as dense as with 256-pixel tiles and a quarter as many tiles load
 * (F240). Returns the selection's texels per surface tile and the finest surface level any layer serves.
 */
export function applyPixelRatio(
  layers: readonly ImageryLayer[],
  pixelRatio: number,
): { texelsPerTile: number; maxLevel: number } {
  const variant = pixelRatio > 1 ? 2 : 1;
  let texelsPerTile = 0;
  let maxLevel = 0;
  for (const { source, loader } of layers) {
    if (source.highDpi && loader.pixelRatio !== variant) {
      loader.pixelRatio = variant;
      loader.reload();
    }
    const texels = source.tileSizePx * (source.highDpi ? variant : source.pixelRatio);
    loader.levelShift = Math.max(0, Math.round(Math.log2(texels / 256)));
    texelsPerTile = Math.max(texelsPerTile, texels / 2 ** loader.levelShift);
    maxLevel = Math.max(maxLevel, source.maxLevel + loader.levelShift);
  }
  return { texelsPerTile, maxLevel };
}
