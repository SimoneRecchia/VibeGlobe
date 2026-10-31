// A fixed-tilt solar table: 24 modules in two rows of twelve in portrait (2P × 12, each 2,278 × 1,134 mm), tilted 20°
// toward −Z (the model's front: heading 180 faces south), its lower edge 0.65 m above the ground, on five pairs of
// steel posts with rafters, two purlins and braces. The posts reach 5 m below the base, so a table standing level on a
// slope (a model set's footprint, F663) meets the lower ground with each post; on flat ground they are buried. Two meshes: the modules' glass (one quad, a repeated module
// texture) and the frame and structure (a small color atlas). Original geometry; no third-party data.
import { Image, MeshBuilder, add, cross, scale, sub, type NodeSpec, type Vec3 } from './glb.ts';

const TILT_DEG = 20;
const COLUMNS = 12;
const ROWS = 2;
/** A module's pitch across and along the slope, a 20 mm gap included, meters. */
const PITCH_X = 1.154;
const PITCH_S = 2.298;
const WIDTH = COLUMNS * PITCH_X;
const SLOPE = ROWS * PITCH_S;
const LOW_EDGE = 0.65;
/** How far below the base the posts reach, meters. */
const POST_DEPTH = 5;
const THICKNESS = 0.04;
const tilt = (TILT_DEG * Math.PI) / 180;
const DEPTH = SLOPE * Math.cos(tilt);

/** A point in the table's tilted frame: across (x), up the slope from the lower edge (s), along the normal (n). */
function at(x: number, s: number, n: number): Vec3 {
  return [x, LOW_EDGE + s * Math.sin(tilt) + n * Math.cos(tilt), -DEPTH / 2 + s * Math.cos(tilt) - n * Math.sin(tilt)];
}

/** The structure atlas's colors (2 × 2 blocks): galvanized steel, the modules' aluminium frame, their backsheet. */
const STEEL: [number, number] = [0.25, 0.25];
const FRAME: [number, number] = [0.75, 0.25];
const BACKSHEET: [number, number] = [0.25, 0.75];

/** The table: the modules' glass and the frame with the structure. */
export function solarTable(): readonly NodeSpec[] {
  return [
    {
      name: 'solar-table',
      mesh: structure(),
      material: { name: 'structure', png: structureAtlas().png(), roughness: 0.7 },
      children: [
        {
          name: 'modules',
          mesh: glass(),
          material: { name: 'modules', png: moduleTexture().png(), repeat: true, metallic: 0.1, roughness: 0.25 },
        },
      ],
    },
  ];
}

/** The glass of every module: one quad over the table, the module texture repeated 12 × 2 times. */
function glass(): MeshBuilder {
  const mesh = new MeshBuilder();
  const [x0, x1] = [-WIDTH / 2, WIDTH / 2];
  mesh.flatQuad(
    [at(x0, SLOPE, 0), at(x1, SLOPE, 0), at(x1, 0, 0), at(x0, 0, 0)],
    [
      [0, ROWS],
      [COLUMNS, ROWS],
      [COLUMNS, 0],
      [0, 0],
    ],
  );
  return mesh;
}

/** The modules' edges and backsheet, and the mounting: posts, rafters, purlins and braces. */
function structure(): MeshBuilder {
  const mesh = new MeshBuilder();
  const [x0, x1] = [-WIDTH / 2, WIDTH / 2];
  const n0 = -THICKNESS;
  const quad = (corners: [Vec3, Vec3, Vec3, Vec3], uv: [number, number]): void =>
    mesh.flatQuad(corners, [uv, uv, uv, uv]);
  quad([at(x0, 0, 0), at(x1, 0, 0), at(x1, 0, n0), at(x0, 0, n0)], FRAME);
  quad([at(x1, SLOPE, 0), at(x0, SLOPE, 0), at(x0, SLOPE, n0), at(x1, SLOPE, n0)], FRAME);
  quad([at(x1, 0, 0), at(x1, SLOPE, 0), at(x1, SLOPE, n0), at(x1, 0, n0)], FRAME);
  quad([at(x0, SLOPE, 0), at(x0, 0, 0), at(x0, 0, n0), at(x0, SLOPE, n0)], FRAME);
  quad([at(x0, 0, n0), at(x1, 0, n0), at(x1, SLOPE, n0), at(x0, SLOPE, n0)], BACKSHEET);
  // Two purlins under the modules, across the whole table.
  for (const s of [1.05, SLOPE - 1.05])
    beam(mesh, at(x0 + 0.1, s, -0.08), at(x1 - 0.1, s, -0.08), slopeUp(), 0.08, 0.08);
  // Five bays: a rafter under the purlins up the slope, a front and a rear post, a brace between them.
  for (let bay = 0; bay < 5; bay++) {
    const x = (bay - 2) * 2.85;
    beam(mesh, at(x, 0.35, -0.19), at(x, SLOPE - 0.35, -0.19), [1, 0, 0], 0.1, 0.08);
    const [front, rear] = [post(mesh, x, 0.95), post(mesh, x, SLOPE - 0.95)];
    beam(mesh, add(front, [0, -front[1] + 0.3, 0]), add(rear, [0, -0.35, 0]), [1, 0, 0], 0.05, 0.05);
  }
  return mesh;
}

/** A post from {@link POST_DEPTH} below the base to the rafter at `s` up the slope; returns its top. */
function post(mesh: MeshBuilder, x: number, s: number): Vec3 {
  const top = at(x, s, -0.23);
  beam(mesh, [top[0], -POST_DEPTH, top[2]], top, [0, 0, 1], 0.12, 0.12);
  return top;
}

/** The slope's direction, up the table. */
function slopeUp(): Vec3 {
  return [0, Math.sin(tilt), Math.cos(tilt)];
}

/**
 * A beam from `a` to `b` (its axis) of `width` along `side` and `height` across both, as four flat faces (the ends
 * are hidden under the modules or in the ground).
 */
function beam(mesh: MeshBuilder, a: Vec3, b: Vec3, side: Vec3, width: number, height: number): void {
  const axis = sub(b, a);
  const unit = (v: Vec3): Vec3 => scale(v, 1 / (Math.hypot(...v) || 1));
  const w = unit(cross(cross(axis, side), axis));
  const h = unit(cross(axis, w));
  const corner = (p: Vec3, i: number, j: number): Vec3 =>
    add(add(p, scale(w, (i * width) / 2)), scale(h, (j * height) / 2));
  const around: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (let k = 0; k < 4; k++) {
    const [i0, j0] = around[k] ?? [1, 1];
    const [i1, j1] = around[(k + 1) % 4] ?? [1, 1];
    mesh.flatQuad(
      [corner(a, i0, j0), corner(a, i1, j1), corner(b, i1, j1), corner(b, i0, j0)],
      [STEEL, STEEL, STEEL, STEEL],
    );
  }
}

function structureAtlas(): Image {
  const image = new Image(32, 32);
  image.paint((u, v) => (v < 0.5 ? (u < 0.5 ? [150, 156, 162] : [184, 189, 195]) : [218, 221, 224]));
  return image;
}

/**
 * One module and half the gaps around it, portrait: the dark gap, the aluminium frame, then 6 × 24 half-cut
 * monocrystalline cells in two halves, their fine backsheet lines and busbars.
 */
function moduleTexture(): Image {
  const image = new Image(128, 256);
  image.paint((u, v) => {
    const x = u * PITCH_X * 1000;
    const y = v * PITCH_S * 1000;
    const edge = Math.min(x, PITCH_X * 1000 - x, y, PITCH_S * 1000 - y);
    if (edge < 10) return [34, 37, 41];
    if (edge < 45) return edge < 14 ? [214, 218, 222] : [172, 178, 185];
    // Cells: 6 across 1,064 mm, 2 × 12 half cells along 2,208 mm with an 8 mm gap at the middle.
    const cx = (x - 45) / (1064 / 6);
    const half = y - 45 < 1104 ? 0 : 1;
    const cy = (y - 45 - half * 1104) / (1100 / 12);
    if (half === 1 && y - 45 - 1104 < 4) return [196, 202, 210];
    const fx = cx - Math.floor(cx);
    const fy = cy - Math.floor(cy);
    if (fx < 0.012 || fx > 0.988 || fy < 0.025 || fy > 0.975) return [196, 202, 210];
    // Five busbars across each cell, and a slight variation between cells.
    const bus = Math.abs(((fx * 5) % 1) - 0.5) < 0.04;
    const seed = Math.sin(Math.floor(cx) * 12.9 + Math.floor(cy) * 78.2 + half * 37.7) * 43_758.5;
    const d = (seed - Math.floor(seed) - 0.5) * 6;
    return bus ? [84, 92, 108] : [30 + d, 42 + d, 70 + d];
  });
  return image;
}
