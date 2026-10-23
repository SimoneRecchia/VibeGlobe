import type { ModelImage, ModelImageType } from './description.js';
import type { GltfDocument } from './document.js';
import { ModelError } from './errors.js';
import { decodeMeshoptView, type MeshoptDecoderLike } from './meshopt.js';

/** External files of a `.gltf` model by the URI the document writes (buffers and images); a GLB needs none. */
export type ModelResources = Readonly<Record<string, Uint8Array>>;

/** The URIs a document refers to that are neither `data:` URIs nor inside a GLB: what a loader must fetch. */
export function externalUris(doc: GltfDocument): string[] {
  const uris = new Set<string>();
  for (const item of [...doc.buffers, ...doc.images])
    if (item.uri !== undefined && !item.uri.startsWith('data:')) uris.add(item.uri);
  return [...uris];
}

/** Decodes a base64 `data:` URI; throws 'invalid-gltf' for anything else. */
function decodeDataUri(uri: string, what: string): Uint8Array {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!match) throw new ModelError('invalid-gltf', `${what}: malformed data URI`);
  const payload = match[3] ?? '';
  if (!match[2]) return new TextEncoder().encode(decodeURIComponent(payload));
  try {
    const text = atob(payload);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  } catch (cause) {
    throw new ModelError('invalid-gltf', `${what}: invalid base64 in data URI`, { cause });
  }
}

function resource(uri: string, resources: ModelResources, what: string): Uint8Array {
  if (uri.startsWith('data:')) return decodeDataUri(uri, what);
  const bytes = resources[uri] ?? resources[decodeURIComponent(uri)];
  if (!bytes) throw new ModelError('missing-resource', `${what}: ${uri} was not supplied`);
  return bytes;
}

/**
 * The bytes of every buffer: the GLB's BIN chunk for a buffer without a URI, a zero-filled array for a meshopt
 * fallback buffer (its views are decoded), else the `data:` URI or the supplied external file. A buffer shorter
 * than its declared `byteLength` throws 'invalid-gltf'.
 */
export function resolveBuffers(
  doc: GltfDocument,
  glbBin: Uint8Array | undefined,
  resources: ModelResources,
): Uint8Array[] {
  return doc.buffers.map((buffer, i) => {
    let bytes: Uint8Array | undefined;
    if (buffer.uri !== undefined) bytes = resource(buffer.uri, resources, `buffers[${i}]`);
    else if (buffer.meshoptFallback) bytes = new Uint8Array(buffer.byteLength);
    else if (i === 0) bytes = glbBin;
    if (!bytes) throw new ModelError('missing-resource', `buffers[${i}] has no uri and the file has no BIN chunk`);
    if (bytes.byteLength < buffer.byteLength)
      throw new ModelError('invalid-gltf', `buffers[${i}]: ${bytes.byteLength} bytes, ${buffer.byteLength} declared`);
    return bytes;
  });
}

/**
 * The bytes of every buffer view, decoding meshopt-compressed views whose uncompressed data is absent (a fallback
 * buffer); views with uncompressed data read it directly, so the decoder is loaded only when needed.
 */
export function resolveViews(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  meshopt: MeshoptDecoderLike | undefined,
): Uint8Array[] {
  return doc.bufferViews.map((view, i) => {
    const owner = doc.buffers[view.buffer];
    if (view.meshopt && owner?.meshoptFallback) {
      if (!meshopt) throw new ModelError('unsupported', `bufferViews[${i}] needs the meshopt decoder`);
      return decodeMeshoptView(meshopt, view, buffers[view.meshopt.buffer] as Uint8Array, i);
    }
    return (buffers[view.buffer] as Uint8Array).subarray(view.byteOffset, view.byteOffset + view.byteLength);
  });
}

/** True when some view needs meshopt decoding. */
export function needsMeshopt(doc: GltfDocument): boolean {
  return doc.bufferViews.some(
    (view) => view.meshopt !== undefined && doc.buffers[view.buffer]?.meshoptFallback === true,
  );
}

/** The image type the bytes start with (PNG, JPEG, WebP or KTX2 signatures), if any. */
function sniffImage(bytes: Uint8Array): ModelImageType | undefined {
  const starts = (...signature: number[]): boolean => signature.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  if (starts(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/ktx2';
  return undefined;
}

/**
 * Every image as its own copy of the encoded bytes, with the type its signature shows. An image whose bytes are
 * none of PNG, JPEG, WebP and KTX2 throws 'invalid-gltf'; a declared `mimeType` that disagrees with the bytes too.
 */
export function resolveImages(
  doc: GltfDocument,
  views: readonly Uint8Array[],
  resources: ModelResources,
): ModelImage[] {
  return doc.images.map((image, i) => {
    const source =
      image.bufferView !== undefined
        ? (views[image.bufferView] as Uint8Array)
        : resource(image.uri ?? '', resources, `images[${i}]`);
    const mimeType = sniffImage(source);
    if (!mimeType) throw new ModelError('invalid-gltf', `images[${i}] is not a PNG, JPEG, WebP or KTX2 image`);
    if (image.mimeType !== undefined && image.mimeType !== mimeType)
      throw new ModelError('invalid-gltf', `images[${i}] declares ${image.mimeType} but holds ${mimeType}`);
    return { name: image.name, mimeType, bytes: source.slice() };
  });
}
