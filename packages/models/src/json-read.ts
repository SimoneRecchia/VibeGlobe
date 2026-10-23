import { ModelError } from './errors.js';

/** A parsed JSON object. */
export type Json = Record<string, unknown>;

/** An 'invalid-gltf' error naming the JSON path. */
export const invalid = (path: string, message: string): ModelError =>
  new ModelError('invalid-gltf', `${path}: ${message}`);

/** True for a plain JSON object. */
function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a JSON object, or throws. */
export function object(value: unknown, path: string): Json {
  if (!isObject(value)) throw invalid(path, 'must be an object');
  return value;
}

/** The value as an array (empty when absent), or throws. */
export function array(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(path, 'must be an array');
  return value;
}

/** A finite number within [min, max], the fallback when absent, or throws. */
export function number(value: unknown, path: string, fallback?: number, min = -Infinity, max = Infinity): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw invalid(path, `must be a number from ${min} to ${max}`);
  return value;
}

/** A non-negative integer (at least `min`), the fallback when absent, or throws. */
export function integer(value: unknown, path: string, fallback?: number, min = 0): number {
  const result = number(value, path, fallback, min);
  if (!Number.isInteger(result)) throw invalid(path, 'must be an integer');
  return result;
}

/** A string or undefined, or throws. */
export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(path, 'must be a string');
  return value;
}

/** A fixed-length list of numbers, the fallback when absent, or throws. */
export function numbers<N extends number>(
  value: unknown,
  path: string,
  length: N,
  fallback: readonly number[],
): number[] {
  if (value === undefined) return [...fallback];
  const list = array(value, path);
  if (list.length !== length) throw invalid(path, `must have ${length} numbers`);
  return list.map((item, i) => number(item, `${path}[${i}]`));
}

/** Checks an index into a list of `size` items. */
export function ref(value: unknown, path: string, size: number, what: string): number {
  const index = integer(value, path);
  if (index >= size) throw invalid(path, `refers to ${what} ${index}, but there are ${size}`);
  return index;
}

/** An optional index into a list of `size` items. */
export function optionalRef(value: unknown, path: string, size: number, what: string): number | undefined {
  return value === undefined ? undefined : ref(value, path, size, what);
}

/** The named extension object of a glTF object, when present. */
export function extension(owner: Json, name: string): Json | undefined {
  const extensions = owner['extensions'];
  if (!isObject(extensions)) return undefined;
  const value = extensions[name];
  return isObject(value) ? value : undefined;
}
