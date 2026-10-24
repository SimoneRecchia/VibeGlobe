/**
 * What the 3D Tiles loader reads from a glTF besides its meshes (F466, F470; ADR 0141): the copyright of its asset
 * (the provider credits of Google Photorealistic 3D Tiles) and its `EXT_structural_metadata` property tables with
 * the buffer views they read, for feature picking. The glTF JSON is untrusted: anything malformed is ignored.
 */
import type { MetadataSchema, PropertyTable } from './metadata.js';

/** The metadata of a glTF content. */
export interface GltfInfo {
  readonly copyright: string | undefined;
  readonly schema: MetadataSchema | undefined;
  readonly propertyTables: readonly PropertyTable[];
  /** Every buffer view of the GLB's binary chunk, by index (empty views for other buffers). */
  readonly views: readonly Uint8Array[];
  /** For each `_FEATURE_ID_n` attribute name, the property table its feature ids index. */
  readonly featureTables: Readonly<Record<string, number>>;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const decoder = new TextDecoder();

function glbChunks(glb: Uint8Array): { json: Json; bin: Uint8Array | undefined } | undefined {
  if (glb.length < 20) return undefined;
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return undefined;
  let offset = 12;
  let json: Json | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= glb.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > glb.length) return undefined;
    const chunk = glb.subarray(start, start + length);
    if (type === 0x4e4f534a) {
      try {
        const parsed: unknown = JSON.parse(decoder.decode(chunk));
        if (isRecord(parsed)) json = parsed;
      } catch {
        return undefined;
      }
    } else if (type === 0x004e4942) bin = chunk;
    offset = start + length;
  }
  return json ? { json, bin } : undefined;
}

/** Reads the copyright and the structural metadata of a GLB; undefined fields when it has none. */
export function gltfInfo(glb: Uint8Array): GltfInfo {
  const empty: GltfInfo = { copyright: undefined, schema: undefined, propertyTables: [], views: [], featureTables: {} };
  const chunks = glbChunks(glb);
  if (!chunks) return empty;
  const { json, bin } = chunks;
  const asset = isRecord(json['asset']) ? json['asset'] : {};
  const copyright = typeof asset['copyright'] === 'string' ? asset['copyright'] : undefined;
  const extensions = isRecord(json['extensions']) ? json['extensions'] : {};
  const metadata = isRecord(extensions['EXT_structural_metadata']) ? extensions['EXT_structural_metadata'] : undefined;
  const views: Uint8Array[] = [];
  const bufferViews = Array.isArray(json['bufferViews']) ? json['bufferViews'] : [];
  for (const raw of bufferViews) {
    const v = isRecord(raw) ? raw : {};
    const start = typeof v['byteOffset'] === 'number' ? v['byteOffset'] : 0;
    const length = typeof v['byteLength'] === 'number' ? v['byteLength'] : 0;
    views.push(
      bin && v['buffer'] === 0 && start + length <= bin.length
        ? bin.subarray(start, start + length)
        : new Uint8Array(0),
    );
  }
  const featureTables: Record<string, number> = {};
  for (const mesh of Array.isArray(json['meshes']) ? json['meshes'] : [])
    for (const primitive of isRecord(mesh) && Array.isArray(mesh['primitives']) ? mesh['primitives'] : []) {
      const ext = isRecord(primitive) && isRecord(primitive['extensions']) ? primitive['extensions'] : {};
      const features = isRecord(ext['EXT_mesh_features']) ? ext['EXT_mesh_features']['featureIds'] : undefined;
      for (const id of Array.isArray(features) ? features : [])
        if (isRecord(id) && typeof id['attribute'] === 'number' && typeof id['propertyTable'] === 'number')
          featureTables[`_FEATURE_ID_${id['attribute']}`] = id['propertyTable'];
    }
  return {
    copyright,
    schema: metadata && isRecord(metadata['schema']) ? (metadata['schema'] as MetadataSchema) : undefined,
    propertyTables:
      metadata && Array.isArray(metadata['propertyTables']) ? (metadata['propertyTables'] as PropertyTable[]) : [],
    views,
    featureTables,
  };
}
