// Shapes for the generated models: surfaces of revolution, discs, bands between rows of vertices, boxes, rotations.
import type { MeshBuilder, Vec3 } from './glb.ts';

/** A surface of revolution about Y (or Z) through profile points (radius, height), its seam duplicated for the UVs. */
export function lathe(
  mesh: MeshBuilder,
  profile: readonly [number, number][],
  segments: number,
  uv: (k: number, angle: number) => [number, number],
  axis: 'y' | 'z' = 'y',
): void {
  const rows = profile.map(([r, h], i) => {
    const prev = profile[Math.max(0, i - 1)] ?? [r, h];
    const next = profile[Math.min(profile.length - 1, i + 1)] ?? [r, h];
    // The outward normal in the (radius, height) plane: the profile's tangent turned a quarter.
    const dr = next[0] - prev[0];
    const dh = next[1] - prev[1];
    const [nr, nh] = axis === 'y' ? [dh, -dr] : [-dh, dr];
    return Array.from({ length: segments + 1 }, (_, j) => {
      const a = (2 * Math.PI * j) / segments;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const p: Vec3 = axis === 'y' ? [r * c, h, r * s] : [r * c, r * s, h];
      const n: Vec3 = axis === 'y' ? [nr * c, nh, nr * s] : [nr * c, nr * s, nh];
      return mesh.vertex(p, n, ...uv(i / Math.max(1, profile.length - 1), j / segments));
    });
  });
  for (let i = 0; i + 1 < rows.length; i++) {
    openBand(mesh, rows[i + 1] ?? [], rows[i] ?? []);
  }
}

/** A flat ring between two radii at a height (an outer one only for a full disc), facing +Y (or +Z). */
export function disc(
  mesh: MeshBuilder,
  outer: number,
  inner: number,
  h: number,
  segments: number,
  uv: [number, number],
  axis: 'y' | 'z' = 'y',
): void {
  const at = (r: number, a: number): Vec3 =>
    axis === 'y' ? [r * Math.cos(a), h, r * Math.sin(a)] : [r * Math.cos(a), r * Math.sin(a), h];
  const normal: Vec3 = axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const ring = (r: number): number[] =>
    Array.from({ length: segments }, (_, j) => mesh.vertex(at(r, (2 * Math.PI * j) / segments), normal, ...uv));
  const out = ring(outer);
  const center = inner > 0 ? undefined : mesh.vertex(at(0, 0), normal, ...uv);
  const inn = inner > 0 ? ring(inner) : [];
  for (let j = 0; j < segments; j++) {
    const k = (j + 1) % segments;
    const [a, b] = [out[j] ?? 0, out[k] ?? 0];
    const flip = axis === 'z';
    if (center !== undefined) mesh.triangle(center, flip ? a : b, flip ? b : a);
    else mesh.quad(inn[j] ?? 0, inn[k] ?? 0, b, a);
  }
}

/** Quads between two rows of vertices, without closing the loop. */
export function openBand(mesh: MeshBuilder, a: readonly number[], b: readonly number[]): void {
  for (let k = 0; k + 1 < a.length; k++) mesh.quad(a[k] ?? 0, a[k + 1] ?? 0, b[k + 1] ?? 0, b[k] ?? 0);
}

/** Quads between two closed loops of vertices. */
export function loopBand(mesh: MeshBuilder, a: readonly number[], b: readonly number[]): void {
  for (let k = 0; k < a.length; k++) {
    const next = (k + 1) % a.length;
    mesh.quad(a[k] ?? 0, b[k] ?? 0, b[next] ?? 0, a[next] ?? 0);
  }
}

/** An axis-aligned box without its bottom face, every face flat. */
export function box(mesh: MeshBuilder, min: Vec3, max: Vec3, uv: [number, number]): void {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: [Vec3, Vec3, Vec3, Vec3][] = [
    [
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
      [x0, y1, z0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x1, y0, z0],
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
    ],
    [
      [x1, y0, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
  ];
  for (const face of faces) mesh.flatQuad(face, [uv, uv, uv, uv]);
}

export function rotateX(values: number[], i: number, angle: number, pivot: Vec3): void {
  const y = (values[i * 3 + 1] ?? 0) - pivot[1];
  const z = (values[i * 3 + 2] ?? 0) - pivot[2];
  values[i * 3 + 1] = pivot[1] + y * Math.cos(angle) - z * Math.sin(angle);
  values[i * 3 + 2] = pivot[2] + y * Math.sin(angle) + z * Math.cos(angle);
}

export function rotateZ(p: Vec3, angle: number): Vec3 {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}
