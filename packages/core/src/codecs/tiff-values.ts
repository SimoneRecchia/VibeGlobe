// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** TIFF tag values (TIFF 6.0 section 2), shared by `@vibeglobe/sources`' GeoTIFF reader and `@vibeglobe/tools`. */

/** Bytes per value of each TIFF field type, by type (1 to 12; type 0 does not exist and reads as a byte). */
export const TIFF_TYPE_SIZES: readonly number[] = [1, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** One value of a TIFF field of `type` at `offset`; a RATIONAL as its quotient, other unknown types as a byte. */
export function readTiffValue(view: DataView, type: number, offset: number, little: boolean): number {
  switch (type) {
    case 3:
      return view.getUint16(offset, little);
    case 4:
      return view.getUint32(offset, little);
    case 8:
      return view.getInt16(offset, little);
    case 9:
      return view.getInt32(offset, little);
    case 11:
      return view.getFloat32(offset, little);
    case 12:
      return view.getFloat64(offset, little);
    case 5:
      return view.getUint32(offset, little) / view.getUint32(offset + 4, little);
    default:
      return view.getUint8(offset);
  }
}
