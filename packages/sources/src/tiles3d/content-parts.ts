/** The glTF parts of 3D Tiles content and their content-to-tile matrices (ADR 0141). */
import type { BinaryTable, ParsedContent } from './content.js';
import { multiply, type Mat4 } from './volumes.js';

/** A glTF of a content: its bytes, its content-to-tile matrix and the batch table of its features (b3dm). */
export interface GltfPart {
  readonly glb: Uint8Array;
  readonly local: Mat4;
  readonly batch: { readonly table: BinaryTable; readonly length: number } | undefined;
}

/** glTF's +Y up to 3D Tiles' +Z up (specification 1.0 §glTF transforms). */
const Y_UP_TO_Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** The glTF parts of a parsed content with their content-to-tile matrices. */
export function gltfParts(content: ParsedContent): GltfPart[] {
  switch (content.type) {
    case 'glb':
      return [{ glb: content.glb, local: Y_UP_TO_Z_UP, batch: undefined }];
    case 'b3dm': {
      const rtc = content.featureTable.json['RTC_CENTER'];
      const local = Array.isArray(rtc)
        ? multiply(translation(Number(rtc[0]) || 0, Number(rtc[1]) || 0, Number(rtc[2]) || 0), Y_UP_TO_Z_UP)
        : Y_UP_TO_Z_UP;
      return [{ glb: content.glb, local, batch: { table: content.batchTable, length: content.batchLength } }];
    }
    case 'cmpt':
      return content.tiles.flatMap(gltfParts);
    default:
      return [];
  }
}
