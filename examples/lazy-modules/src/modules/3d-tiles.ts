// 3D Tiles: the tileset loader and the renderer's tile meshes.
import type { Globe } from '@vibeglobe/core';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import { tiles3d } from '@vibeglobe/sources/tiles3d';

export async function enable(globe: Globe): Promise<string> {
  await globe.ready;
  return `3D Tiles: ${typeof tiles3d}, ${typeof threeTileMeshes}`;
}
