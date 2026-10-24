// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GltfImage, GltfMaterial, GltfSampler, GltfTexture, GltfTextureInfo } from './document.js';
import {
  extension,
  integer,
  invalid,
  number,
  numbers,
  object,
  optionalRef,
  optionalString,
  ref,
  array,
  type Json,
} from './json-read.js';

function textureInfo(value: unknown, path: string, textures: number, factorKey?: string): GltfTextureInfo | undefined {
  if (value === undefined) return undefined;
  const info = object(value, path);
  const transform = extension(info, 'KHR_texture_transform');
  return {
    index: ref(info['index'], `${path}.index`, textures, 'texture'),
    texCoord: integer(info['texCoord'], `${path}.texCoord`, 0),
    factor: factorKey ? number(info[factorKey], `${path}.${factorKey}`, 1) : 1,
    transform: transform && {
      offset: numbers(transform['offset'], `${path}.transform.offset`, 2, [0, 0]) as [number, number],
      rotationRad: number(transform['rotation'], `${path}.transform.rotation`, 0),
      scale: numbers(transform['scale'], `${path}.transform.scale`, 2, [1, 1]) as [number, number],
      texCoord:
        transform['texCoord'] === undefined ? undefined : integer(transform['texCoord'], `${path}.transform.texCoord`),
    },
  };
}

/**
 *
 */
export function validateMaterials(gltf: Json, textures: number): GltfMaterial[] {
  return array(gltf['materials'], 'materials').map((value, i) => {
    const path = `materials[${i}]`;
    const material = object(value, path);
    const pbr =
      material['pbrMetallicRoughness'] === undefined
        ? {}
        : object(material['pbrMetallicRoughness'], `${path}.pbrMetallicRoughness`);
    const alphaMode = material['alphaMode'] ?? 'OPAQUE';
    if (alphaMode !== 'OPAQUE' && alphaMode !== 'MASK' && alphaMode !== 'BLEND')
      throw invalid(`${path}.alphaMode`, 'unknown mode');
    const strength = extension(material, 'KHR_materials_emissive_strength');
    const emissiveStrength = strength ? number(strength['emissiveStrength'], `${path}.emissiveStrength`, 1, 0) : 1;
    const emissive = numbers(material['emissiveFactor'], `${path}.emissiveFactor`, 3, [0, 0, 0]).map(
      (c) => c * emissiveStrength,
    );
    return {
      name: optionalString(material['name'], `${path}.name`),
      baseColorFactor: numbers(pbr['baseColorFactor'], `${path}.baseColorFactor`, 4, [1, 1, 1, 1]) as [
        number,
        number,
        number,
        number,
      ],
      baseColorTexture: textureInfo(pbr['baseColorTexture'], `${path}.baseColorTexture`, textures),
      metallicFactor: number(pbr['metallicFactor'], `${path}.metallicFactor`, 1, 0, 1),
      roughnessFactor: number(pbr['roughnessFactor'], `${path}.roughnessFactor`, 1, 0, 1),
      metallicRoughnessTexture: textureInfo(
        pbr['metallicRoughnessTexture'],
        `${path}.metallicRoughnessTexture`,
        textures,
      ),
      normalTexture: textureInfo(material['normalTexture'], `${path}.normalTexture`, textures, 'scale'),
      occlusionTexture: textureInfo(material['occlusionTexture'], `${path}.occlusionTexture`, textures, 'strength'),
      emissiveTexture: textureInfo(material['emissiveTexture'], `${path}.emissiveTexture`, textures),
      emissiveFactor: emissive as [number, number, number],
      alphaMode,
      alphaCutoff: number(material['alphaCutoff'], `${path}.alphaCutoff`, 0.5, 0),
      doubleSided: material['doubleSided'] === true,
      unlit: extension(material, 'KHR_materials_unlit') !== undefined,
    };
  });
}

/**
 *
 */
export function validateTextures(gltf: Json, images: number, samplers: number): GltfTexture[] {
  return array(gltf['textures'], 'textures').map((value, i) => {
    const path = `textures[${i}]`;
    const texture = object(value, path);
    const plain = optionalRef(texture['source'], `${path}.source`, images, 'image');
    const chosen = extension(texture, 'KHR_texture_basisu') ?? extension(texture, 'EXT_texture_webp');
    const source = chosen ? ref(chosen['source'], `${path}.extensions.source`, images, 'image') : plain;
    return {
      source,
      fallbackSource: chosen ? plain : undefined,
      sampler: optionalRef(texture['sampler'], `${path}.sampler`, samplers, 'sampler'),
    };
  });
}

/**
 *
 */
export function validateImages(gltf: Json, views: number): GltfImage[] {
  return array(gltf['images'], 'images').map((value, i) => {
    const path = `images[${i}]`;
    const image = object(value, path);
    const uri = optionalString(image['uri'], `${path}.uri`);
    const bufferView = optionalRef(image['bufferView'], `${path}.bufferView`, views, 'buffer view');
    const mimeType = optionalString(image['mimeType'], `${path}.mimeType`);
    if ((uri === undefined) === (bufferView === undefined))
      throw invalid(path, 'needs exactly one of uri and bufferView');
    if (bufferView !== undefined && mimeType === undefined) throw invalid(path, 'with a bufferView needs a mimeType');
    return { uri, bufferView, mimeType, name: optionalString(image['name'], `${path}.name`) };
  });
}

/**
 *
 */
export function validateSamplers(gltf: Json): GltfSampler[] {
  return array(gltf['samplers'], 'samplers').map((value, i) => {
    const sampler = object(value, `samplers[${i}]`);
    const filter = (key: string): number | undefined =>
      sampler[key] === undefined ? undefined : integer(sampler[key], `samplers[${i}].${key}`);
    return {
      magFilter: filter('magFilter'),
      minFilter: filter('minFilter'),
      wrapS: integer(sampler['wrapS'], `samplers[${i}].wrapS`, 10497),
      wrapT: integer(sampler['wrapT'], `samplers[${i}].wrapT`, 10497),
    };
  });
}

/**
 * Validates a parsed glTF 2.0 JSON document (F361) and returns its typed form. Checks the asset version, every
 * index against its array, accessor and buffer view bounds, the node hierarchy (a forest: one parent per node, no
 * cycles, scene nodes are roots) and that every required extension is one this package reads. Throws a ModelError:
 * 'invalid-gltf' naming the offending path, or 'unsupported' for a required extension or a version other than 2.x.
 */
