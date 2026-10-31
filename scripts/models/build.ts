// Builds the playground's wind turbine and solar table (`apps/playground/public/models/`): `node scripts/models/build.ts`.
// Fails when a triangle's winding disagrees with its normals (the models draw front faces only).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';
import { cross, sub, writeGlb, type MeshBuilder, type NodeSpec } from './glb.ts';
import { solarTable } from './solar-table.ts';
import { windTurbine } from './wind-turbine.ts';

const OUT_DIR = join(ROOT_DIR, 'apps/playground/public/models');

for (const [file, roots] of [
  ['wind-turbine.glb', windTurbine()],
  ['solar-table.glb', solarTable()],
] as const) {
  const meshes = collect(roots);
  for (const [name, mesh] of meshes) checkWinding(name, mesh);
  const glb = writeGlb('VibeGlobe scripts/models', roots);
  writeFileSync(join(OUT_DIR, file), glb);
  const triangles = meshes.map(([name, mesh]) => `${name} ${String(mesh.triangleCount)}`).join(', ');
  console.log(`${file}: ${(glb.byteLength / 1024).toFixed(1)} KB, triangles: ${triangles}`);
}

function collect(nodes: readonly NodeSpec[]): [string, MeshBuilder][] {
  return nodes.flatMap((node) => [
    ...(node.mesh ? [[node.name, node.mesh] as [string, MeshBuilder]] : []),
    ...collect(node.children ?? []),
  ]);
}

function checkWinding(name: string, mesh: MeshBuilder): void {
  let wrong = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i] ?? 0, mesh.indices[i + 1] ?? 0, mesh.indices[i + 2] ?? 0];
    const face = cross(sub(mesh.point(b), mesh.point(a)), sub(mesh.point(c), mesh.point(a)));
    let dot = 0;
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) dot += (face[j] ?? 0) * (mesh.normals[k * 3 + j] ?? 0);
    if (dot < 0) wrong++;
  }
  if (wrong > 0) throw new Error(`${name}: ${String(wrong)} of ${String(mesh.triangleCount)} triangles wound inward`);
}
