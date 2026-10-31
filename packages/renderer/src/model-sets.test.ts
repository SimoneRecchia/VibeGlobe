import { geodeticToEcef, MorphFrame, type FrameView } from '@vibeglobe/core';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { ModelSet } from './model-sets.js';

const RAD = Math.PI / 180;

/** A frame looking straight down at a point from `heightM` above it, 400 × 300 CSS pixels, 60° vertical field. */
function view(lonDeg: number, latDeg: number, heightM: number): FrameView {
  const [lon, lat] = [lonDeg * RAD, latDeg * RAD];
  const eye = new Float64Array(3);
  geodeticToEcef(lon, lat, heightM, eye);
  const e = [-Math.sin(lon), Math.cos(lon), 0];
  const n = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const u = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const v = new Float64Array(16);
  for (let i = 0; i < 3; i++) {
    v[i * 4] = e[i] ?? 0;
    v[i * 4 + 1] = n[i] ?? 0;
    v[i * 4 + 2] = u[i] ?? 0;
  }
  v[15] = 1;
  const p = new Float64Array(16);
  p[5] = 1 / Math.tan(Math.PI / 6);
  p[0] = (p[5] ?? 1) / (400 / 300);
  p[11] = -1;
  p[14] = 0.1;
  return { morph: new MorphFrame(), view: v, projection: p, eyeEcef: eye, widthPx: 400, heightPx: 300, pixelRatio: 1 };
}

/** A turbine-like model: a tower at the origin, a `nacelle` 10 m up and in it a `rotor` 2 m forward. */
function turbine(): Group {
  const root = new Group();
  const tower = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  const nacelle = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  const rotor = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  nacelle.name = 'nacelle';
  nacelle.position.set(0, 10, 0);
  rotor.name = 'rotor';
  rotor.position.set(0, 0, -2);
  nacelle.add(rotor);
  tower.add(nacelle);
  root.add(tower);
  return root;
}

describe('ModelSet joints (F648)', () => {
  it("turns each joint's meshes about its own axis by each copy's angle, nested joints together, the rest unmoved", () => {
    const set = new ModelSet(
      turbine(),
      {
        visibleBelowMeters: 3000,
        placeholderColor: [1, 1, 1],
        placeholderSizePx: 0,
        joints: [
          { node: 'nacelle', axis: 'y' },
          { node: 'rotor', axis: 'z' },
        ],
      },
      (material) => material,
    );
    const pose = { position: { longitudeDeg: 9, latitudeDeg: 45 }, headingDeg: 30 };
    set.setInstances([pose, pose], [1, 2]);
    set.angles[0] = new Float32Array([Math.PI / 2, 0]);
    set.angles[1] = new Float32Array([Math.PI / 2, 0]);
    set.place(view(9, 45, 500));
    expect(set.modelCount).toBe(2);
    const [tower, nacelle, rotor] = set.group.children as InstancedMesh[];
    const at = (mesh: InstancedMesh | undefined, copy: number, point: Vector3): Vector3 => {
      const m = new Matrix4();
      mesh?.getMatrixAt(copy, m);
      return point.clone().applyMatrix4(m);
    };
    // The nacelle yawed a quarter about +Y: its front (−Z) now toward −X, the hub at (−2, 10, 0) in the model.
    expect(at(nacelle, 0, new Vector3(0, 0, -1)).distanceTo(at(tower, 0, new Vector3(-1, 10, 0)))).toBeLessThan(1e-3);
    // A blade tip 5 m up the rotor, spun a quarter about the rotor's Z (+Y toward −X, the rotor's −X now +Z).
    expect(at(rotor, 0, new Vector3(0, 5, 0)).distanceTo(at(tower, 0, new Vector3(-2, 10, 5)))).toBeLessThan(1e-3);
    // The second copy at rest: as modelled.
    expect(at(rotor, 1, new Vector3(0, 5, 0)).distanceTo(at(tower, 1, new Vector3(0, 15, -2)))).toBeLessThan(1e-3);
  });
});
