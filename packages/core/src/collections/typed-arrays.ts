// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

type TypedArray = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array | Int8Array;

/** `array` copied into a new array of its type and `length` (the rest zero): the slow path of a growing table. */
export function grownArray<T extends TypedArray>(array: T, length: number): T {
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}
