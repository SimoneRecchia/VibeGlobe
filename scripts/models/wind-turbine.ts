// A three-blade wind turbine of the classic 2 MW class: an 80 m rotor (39 m blades) with its hub at 78 m on a conical
// steel tower 4.2 m across at the base and 2.3 m at the top, a streamlined nacelle 10.4 m long, the shaft tilted 6°.
// Three meshes in a node tree: the body (foundation and tower), the `nacelle` turning on the tower (about its Y axis,
// `ModelSetLayer`'s `yaw`) and in it the `rotor` (spinner and blades) turning on its shaft (about its Z axis, `spin`).
// They share one 256 × 512 texture atlas. Original geometry from the class's public dimensions; no third-party data.
import { Image, MeshBuilder, add, scale, type NodeSpec, type Vec3 } from './glb.ts';
import { disc, lathe, loopBand, openBand, rotateX, rotateZ } from './shapes.ts';

const TOWER_TOP = 76;
const TILT_DEG = 6;
const tilt = (TILT_DEG * Math.PI) / 180;
/** The nacelle's frame: on the tower's axis at its top. Its housing tilts with the shaft about this pivot. */
const PIVOT: Vec3 = [0, 1.9, 0];
/** The hub in the nacelle's frame: 1.45 m ahead of the housing's nose along the tilted shaft (78.3 m high). */
const HUB: Vec3 = [0, 1.9 + 4.05 * Math.sin(tilt), -4.05 * Math.cos(tilt)];

/** Atlas regions: the tower's column (u < 0.5), the blades' (0.5–0.75) and small color blocks in the last column. */
const BLOCK = { foundation: 0, nacelle: 1, spinner: 2, dark: 3 } as const;
const blockUv = (block: number, t = 0.5): [number, number] => [0.875, (block * 64 + 6 + t * 52) / 512];

/** The turbine: the body at the origin, the nacelle on the tower top, the rotor at the hub, tilted with the shaft. */
export function windTurbine(): readonly NodeSpec[] {
  const material = { name: 'turbine', png: turbineAtlas().png(), roughness: 0.55 };
  const half = tilt / 2;
  return [
    {
      name: 'turbine',
      mesh: body(),
      material,
      children: [
        {
          name: 'nacelle',
          mesh: nacelle(),
          material,
          translation: [0, TOWER_TOP, 0],
          children: [
            {
              name: 'rotor',
              mesh: rotor(),
              material,
              translation: HUB,
              rotation: [Math.sin(half), 0, 0, Math.cos(half)],
            },
          ],
        },
      ],
    },
  ];
}

/** The foundation's plinth and the tower, a steel tube tapering from 4.2 m to 2.3 m, its texture wrapped once. */
function body(): MeshBuilder {
  const mesh = new MeshBuilder();
  lathe(
    mesh,
    [
      [2.9, -0.6],
      [2.9, 0.3],
    ],
    24,
    (k) => blockUv(BLOCK.foundation, k),
  );
  disc(mesh, 2.9, 2.12, 0.3, 24, blockUv(BLOCK.foundation, 0.8));
  // The profile's heights: v follows the height, not the profile's index.
  const heights = [0.3, 30, TOWER_TOP];
  const towerUv = (k: number, angle: number): [number, number] => [
    0.005 + 0.49 * angle,
    0.998 - (0.996 * (heights[Math.round(k * 2)] ?? 0)) / TOWER_TOP,
  ];
  lathe(
    mesh,
    [
      [2.1, 0.3],
      [1.62, 30],
      [1.15, TOWER_TOP],
    ],
    32,
    towerUv,
  );
  return mesh;
}

/**
 * The nacelle: a streamlined housing 10.4 m long, 3.4 m wide and 3.6 m high, rounder on top than below, narrowing to
 * meet the spinner in front and rounded off behind.
 */
function nacelle(): MeshBuilder {
  const mesh = new MeshBuilder();
  // Along the housing: z, width and height scales, and a vertical shift (the roof drops toward the rear).
  const stations: [number, number, number, number][] = [
    [-2.6, 0.78, 0.8, 0.05],
    [-2.2, 0.93, 0.95, 0.02],
    [-1.4, 1, 1, 0],
    [5.6, 1, 1, 0],
    [6.9, 0.95, 0.9, -0.1],
    [7.8, 0.8, 0.7, -0.28],
  ];
  const section = housingSection(1.7, 1.8);
  const uvAt = (y: number): [number, number] => blockUv(BLOCK.nacelle, (y + 1.8) / 3.6);
  const rings = stations.map(([z, sw, sh, dy]) =>
    section.map(([x, y]) => mesh.vertex([x * sw, PIVOT[1] + dy + y * sh, z], [x, y, 0], ...uvAt(y * sh))),
  );
  for (let r = 0; r + 1 < rings.length; r++) loopBand(mesh, rings[r + 1] ?? [], rings[r] ?? []);
  mesh.smoothNormals(0);
  for (const end of [0, stations.length - 1]) {
    const [z, sw, sh, dy] = stations[end] ?? [0, 1, 1, 0];
    const front = end === 0;
    const n: Vec3 = [0, 0, front ? -1 : 1];
    const center = mesh.vertex([0, PIVOT[1] + dy, z + (front ? -0.05 : 0.25)], n, ...uvAt(0));
    const edge = section.map(([x, y]) => mesh.vertex([x * sw, PIVOT[1] + dy + y * sh, z], n, ...uvAt(y * sh)));
    edge.forEach((a, i) => {
      const b = edge[(i + 1) % edge.length] ?? a;
      if (front) mesh.triangle(center, b, a);
      else mesh.triangle(center, a, b);
    });
  }
  // A dark band where the housing sits on the tower's yaw bearing.
  lathe(
    mesh,
    [
      [1.2, -0.05],
      [1.2, 0.12],
    ],
    24,
    () => blockUv(BLOCK.dark),
  );
  for (let i = 0; i < mesh.vertexCount; i++) {
    rotateX(mesh.positions, i, tilt, PIVOT);
    rotateX(mesh.normals, i, tilt, [0, 0, 0]);
  }
  return mesh;
}

/** The housing's cross-section, counter-clockwise in the XY plane: corners of 1.0 m radius on top, 0.45 m below. */
function housingSection(hw: number, hh: number): [number, number][] {
  const points: [number, number][] = [];
  const corners: [number, number, number, number][] = [
    [hw - 1, hh - 1, 1, 0],
    [-hw + 1, hh - 1, 1, 90],
    [-hw + 0.45, -hh + 0.45, 0.45, 180],
    [hw - 0.45, -hh + 0.45, 0.45, 270],
  ];
  for (const [cx, cy, radius, start] of corners)
    for (let step = 0; step <= 4; step++) {
      const a = ((start + step * 22.5) * Math.PI) / 180;
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  return points;
}

/** The rotor about its own origin, the shaft along Z, the spinner's nose toward −Z: spinner and three blades. */
function rotor(): MeshBuilder {
  const mesh = new MeshBuilder();
  // A long, pointed nose cone 3.4 m across.
  const profile: [number, number][] = [
    [1.6, 1.3],
    [1.71, 0.6],
    [1.7, -0.1],
    [1.6, -0.8],
    [1.4, -1.5],
    [1.1, -2.1],
    [0.72, -2.6],
    [0.34, -2.95],
    [0, -3.1],
  ];
  lathe(mesh, profile, 24, (k) => blockUv(BLOCK.spinner, k), 'z');
  disc(mesh, 1.6, 0, 1.3, 24, blockUv(BLOCK.spinner, 0.1), 'z');
  for (let blade = 0; blade < 3; blade++) addBlade(mesh, (blade * 2 * Math.PI) / 3);
  return mesh;
}

/**
 * Spanwise stations: radius, chord, how round the section is (1 at the root), thickness/chord, twist (degrees). A round
 * root 1.9 m across, the widest chord (3.45 m) at 17% of the span, then a long, nearly straight taper to a slim tip.
 */
const STATIONS: readonly (readonly [number, number, number, number, number])[] = [
  [1.2, 1.9, 1, 0.4, 15],
  [2.4, 1.9, 1, 0.4, 15],
  [3.6, 2.3, 0.7, 0.4, 15],
  [5, 3, 0.3, 0.38, 15],
  [6.8, 3.45, 0, 0.32, 14],
  [8.5, 3.3, 0, 0.28, 12],
  [11, 3, 0, 0.25, 10],
  [14, 2.65, 0, 0.23, 8],
  [18, 2.25, 0, 0.21, 6],
  [22, 1.9, 0, 0.2, 4.2],
  [26, 1.6, 0, 0.19, 2.8],
  [30, 1.33, 0, 0.18, 1.6],
  [34, 1.06, 0, 0.18, 0.6],
  [37, 0.8, 0, 0.17, 0],
  [39, 0.5, 0, 0.16, -0.5],
  [39.8, 0.25, 0, 0.15, -0.8],
];
const BLADE_TIP = 40;
/** The blades lean 2° upwind, away from the tower. */
const CONE = Math.sin((2 * Math.PI) / 180);

/** Chord positions from the trailing edge over the upper surface to the leading edge and back below. */
const CHORD_X = [1, 0.62, 0.32, 0.13, 0.035, 0, 0.035, 0.13, 0.32, 0.62, 1];
const PITCH_AXIS = 0.3;

/**
 * One blade along the rotor plane at `angle` from +Y: twisted, tapering airfoil sections from a round root. The leading
 * edge leads in the turning direction (clockwise seen from the front: +Y toward −X).
 */
function addBlade(mesh: MeshBuilder, angle: number): void {
  const first = mesh.vertexCount;
  const rings = STATIONS.map(([r, chord, round, thickness, twistDeg]) => {
    const beta = (twistDeg * Math.PI) / 180;
    // In the rotor plane: toward the leading edge (the motion, −X for a blade along +Y, turned upwind) and the
    // suction side (downwind).
    const toLeading: Vec3 = [-Math.cos(beta), 0, -Math.sin(beta)];
    const toSuction: Vec3 = [-Math.sin(beta), 0, Math.cos(beta)];
    return CHORD_X.map((x, k) => {
      const [s, n] = sectionPoint(x, k < CHORD_X.length / 2, thickness, k, round);
      const p = add(add([0, r, -r * CONE], scale(toLeading, s * chord)), scale(toSuction, n * chord));
      return mesh.vertex(rotateZ(p, angle), [0, 0, 1], 0.625, 0.004 + (0.992 * r) / BLADE_TIP);
    });
  });
  for (let i = 0; i + 1 < rings.length; i++) openBand(mesh, rings[i + 1] ?? [], rings[i] ?? []);
  // The tip: a fan to a point just beyond the last section.
  const last = rings[rings.length - 1] ?? [];
  const tip = mesh.vertex(rotateZ([0, BLADE_TIP, -BLADE_TIP * CONE], angle), [0, 1, 0], 0.625, 0.996);
  for (let k = 0; k + 1 < last.length; k++) mesh.triangle(last[k + 1] ?? tip, last[k] ?? tip, tip);
  mesh.smoothNormals(first);
}

/**
 * A section point as (toward the leading edge, toward the suction side) in chords: a cambered airfoil of the given
 * thickness, blended toward a circle one chord across about the pitch axis near the root.
 */
function sectionPoint(x: number, upper: boolean, thickness: number, k: number, round: number): [number, number] {
  const half =
    5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const camber = x < 0.4 ? (0.02 / 0.16) * (0.8 * x - x * x) : (0.02 / 0.36) * (0.2 + 0.8 * x - x * x);
  const airfoil: [number, number] = [PITCH_AXIS - x, camber + (upper ? half : -half)];
  const psi = (2 * Math.PI * k) / (CHORD_X.length - 1);
  const circle: [number, number] = [-0.5 * Math.cos(psi), 0.5 * Math.sin(psi)];
  return [round * circle[0] + (1 - round) * airfoil[0], round * circle[1] + (1 - round) * airfoil[1]];
}

/** The light grey of the tower, housing and blades (close to RAL 7035, the usual color of turbines). */
const GREY: [number, number, number] = [226, 229, 229];

/** The atlas: the tower's column (door, flanges, the base's grime), the blades' and small color blocks. */
function turbineAtlas(): Image {
  const image = new Image(256, 512);
  image.paint((u, v) => {
    if (u < 0.5) return towerColor(u / 0.5, ((0.998 - v) / 0.996) * TOWER_TOP);
    if (u < 0.75) return v * BLADE_TIP < 2.2 ? [168, 172, 176] : GREY;
    const block = Math.floor(v * 8);
    const t = (v * 8) % 1;
    if (block === BLOCK.foundation) return grain([172, 170, 164], u, v);
    if (block === BLOCK.nacelle) return mixRgb([198, 201, 203], [234, 236, 237], Math.min(1, t * 1.5));
    if (block === BLOCK.spinner) return [236, 238, 239];
    if (block === BLOCK.dark) return [92, 96, 102];
    return GREY;
  });
  return image;
}

/** The tower at a fraction around it and a height: its door (facing +Z), section flanges, the base's grime. */
function towerColor(around: number, y: number): [number, number, number] {
  const doorU = Math.abs(around - 0.25) * 13.2;
  if (doorU < 0.5 && y > 0.6 && y < 2.8) return doorU > 0.42 || y > 2.72 ? [150, 154, 160] : [96, 101, 108];
  if (doorU < 0.75 && y > 0.3 && y < 0.6) return [126, 128, 132];
  if (y > TOWER_TOP - 0.35) return [150, 152, 156];
  for (const flange of [21, 47]) if (Math.abs(y - flange) < 0.12) return [212, 215, 218];
  return y < 3 ? mixRgb([172, 174, 176], GREY, Math.min(1, y / 3) ** 0.7) : GREY;
}

function mixRgb(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [0, 1, 2].map((k) => (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t) as [number, number, number];
}

/** A color with a fine deterministic grain (concrete). */
function grain(rgb: readonly number[], u: number, v: number): [number, number, number] {
  const noise = Math.sin(u * 12_989.8 + v * 78_233.1) * 43_758.5;
  const d = (noise - Math.floor(noise) - 0.5) * 18;
  return [(rgb[0] ?? 0) + d, (rgb[1] ?? 0) + d, (rgb[2] ?? 0) + d];
}
