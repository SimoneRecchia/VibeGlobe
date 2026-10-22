// The atmosphere's shader nodes (ADR 0034): the steps of `atmosphere-model.ts` in TSL, for WebGPU and WebGL2 alike.
// Every function here emits nodes into the shader being built, so it is called inside an `Fn`.
import {
  Fn,
  If,
  Loop,
  clamp,
  dot,
  exp,
  float,
  hash,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec3,
} from 'three/tsl';
import { Vector3, type Node } from 'three/webgpu';
import { ATMOSPHERE } from './atmosphere-model.js';

type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

/** The values the shaders read, set by `Atmosphere.update` each frame. */
export interface AtmosphereUniforms {
  /** The eye's altitude above the sphere, km. */
  readonly eyeAltitudeKm: { value: number };
  /** The sphere's radius, km: the globe's, or larger as the view morphs flat (F393). */
  readonly radiusKm: { value: number };
  /** The eye's zenith, in the sphere's space (world axes scaled by `axisScale`), unit length. */
  readonly up: { value: Vector3 };
  /** The direction toward the Sun in the sphere's space, unit length. */
  readonly sun: { value: Vector3 };
  /** Scales world axes into the sphere's space: (1, 1, a / b) on the globe, (1, 1, 1) when flat. */
  readonly axisScale: { value: Vector3 };
  /** The sky ray through the view's center, and its change per unit of x and y in normalized device coordinates. */
  readonly rayCenter: { value: Vector3 };
  readonly rayX: { value: Vector3 };
  readonly rayY: { value: Vector3 };
  /** Multiplies the aerosol density: 1 is a clear day, more is hazier. */
  readonly haze: { value: number };
  /** 1 shades the surface by the Sun (F396), 0 leaves it as the imagery shows it. */
  readonly lighting: { value: number };
  readonly skySamples: { value: number };
  readonly surfaceSamples: { value: number };
  /** 1 adds dithering noise (F392). */
  readonly dither: { value: number };
}

/** Creates the atmosphere's uniforms with neutral values: a globe seen from 10,000 km with the Sun behind the eye. */
export function createAtmosphereUniforms(): AtmosphereUniforms {
  return {
    eyeAltitudeKm: uniform(10_000.5),
    radiusKm: uniform(ATMOSPHERE.radiusKm),
    up: uniform(new Vector3(0, 0, 1)),
    sun: uniform(new Vector3(0, 0, 1)),
    axisScale: uniform(new Vector3(1, 1, ATMOSPHERE.polarScale)),
    rayCenter: uniform(new Vector3(0, 0, -1)),
    rayX: uniform(new Vector3(1, 0, 0)),
    rayY: uniform(new Vector3(0, 1, 0)),
    haze: uniform(1.5),
    lighting: uniform(0.5),
    skySamples: uniform(16, 'int'),
    surfaceSamples: uniform(8, 'int'),
    dither: uniform(1.5),
  } as unknown as AtmosphereUniforms;
}

/** Brightness of the sunlight, which maps the model's radiance to display values with {@link toDisplay}. */
const SUN_INTENSITY = 0.6;
/** The surface brightness on the night side with sun lighting: dark, never black (`docs/plan/quality.md`). */
const NIGHT_AMBIENT = 0.04;
/** The ground color where a ray hits the ground and no tile is drawn (holes, below the horizon). */
const GROUND_ALBEDO = 0.1;

/** A uniform as a node: the uniforms are created by `uniform()` and typed as plain values for the CPU side. */
function n<T extends 'float' | 'vec3' | 'int'>(value: unknown): Node<T> {
  return value as Node<T>;
}

/** {@link altitudeAlong} in nodes. */
function altitudeAlong(h0: FloatNode, r: FloatNode, mu: FloatNode, d: FloatNode): FloatNode {
  const r0 = r.add(h0);
  const grow = d.mul(r0.mul(2).mul(mu).add(d));
  return h0.add(grow.div(sqrt(r0.mul(r0).add(grow)).add(r0)));
}

/**
 * The two distances along a ray where it crosses altitude `target` (near in x, far in y), in the stable form of
 * `distanceToAltitude`; z is 1 when it crosses at all.
 */
function crossings(h0: FloatNode, r: FloatNode, mu: FloatNode, target: FloatNode): Vec3Node {
  const r0 = r.add(h0);
  const b = r0.mul(mu);
  const disc = target.sub(h0).mul(r.mul(2).add(target).add(h0)).add(b.mul(b));
  const c = h0.sub(target).mul(r.mul(2).add(h0).add(target));
  const q = b.add(select(b.greaterThanEqual(0), float(1), float(-1)).mul(sqrt(max(disc, 0)))).negate();
  const other = c.div(select(q.equal(0), float(1e-30), q));
  return vec3(min(q, other), max(q, other), select(disc.greaterThanEqual(0), float(1), float(0)));
}

/** √(2x) / (y + √(y² + 4/π)), y = √(x/2)·mu: `chapmanUp` of the model. */
function chapmanUp(x: FloatNode, mu: FloatNode): FloatNode {
  const y = sqrt(x.mul(0.5)).mul(mu);
  return sqrt(x.mul(2)).div(y.add(sqrt(y.mul(y).add(4 / Math.PI))));
}

/**
 * The optical depth toward the Sun (`lightDepth` of the model) for the two layers, Rayleigh in x and Mie in y, and in z
 * the share of the Sun above the ground: it fades over ±1 km of the light path's lowest altitude rather than
 * switching, so the Earth's shadow has a soft edge and no frame jumps when it moves.
 */
function lightDepths(h: FloatNode, r: FloatNode, mu: FloatNode): Vec3Node {
  const sine = sqrt(max(mu.mul(mu).oneMinus(), 0));
  const tangentRaw = h.mul(sine).sub(r.mul(mu).mul(mu).div(sine.add(1)));
  const tangent = max(tangentRaw, 0);
  const layer = (scaleKm: number): FloatNode => {
    const x = r.add(h).div(scaleKm);
    const up = exp(h.div(-scaleKm)).mul(chapmanUp(x, mu.abs()));
    const through = exp(tangent.div(-scaleKm))
      .mul(chapmanUp(r.add(tangent).div(scaleKm), float(0)))
      .mul(2);
    return select(mu.greaterThanEqual(0), up, through.sub(up));
  };
  const visible = select(mu.greaterThanEqual(0), float(1), smoothstep(-1, 1, tangentRaw));
  return vec3(layer(ATMOSPHERE.rayleighScaleHeightKm), layer(ATMOSPHERE.mieScaleHeightKm), visible);
}

const RAYLEIGH = vec3(...ATMOSPHERE.rayleighPerKm);

/** The extinction per km for given Rayleigh and Mie densities (Rayleigh plus Mie, per channel). */
function extinction(rayleigh: FloatNode, mie: FloatNode, haze: FloatNode): Vec3Node {
  return RAYLEIGH.mul(rayleigh).add(mie.mul(haze).mul(ATMOSPHERE.mieExtinctionPerKm));
}

/** The light scattered toward the eye along a ray and its optical depth, as shader variables. */
interface Scattering {
  readonly radiance: Vec3Node;
  readonly depth: Vec3Node;
}

/**
 * Marches a ray from `start` to `end` km in the sphere's space (`dir` unit length, from the eye), as `skyRadiance` of
 * the model: samples crowd toward the start, each lit through the analytic light depth. Emits a loop of `samples`.
 */
function march(
  u: AtmosphereUniforms,
  dir: Vec3Node,
  start: FloatNode,
  end: FloatNode,
  samples: Node<'int'>,
): Scattering {
  const h0 = n<'float'>(u.eyeAltitudeKm);
  const r = n<'float'>(u.radiusKm);
  const up = n<'vec3'>(u.up);
  const sun = n<'vec3'>(u.sun);
  const haze = n<'float'>(u.haze);
  const mu = dot(dir, up);
  const cosAngle = dot(dir, sun);
  const rayleighPhase = cosAngle.mul(cosAngle).add(1);
  const g = ATMOSPHERE.mieG;
  const miePhase = rayleighPhase
    .mul((1.5 * (1 - g * g)) / (2 + g * g))
    .div(pow(cosAngle.mul(-2 * g).add(1 + g * g), 1.5));
  const radiance = vec3(0).toVar();
  const depth = vec3(0).toVar();
  const length_ = max(end.sub(start), 0);
  const count = float(samples);
  const r0 = r.add(h0);
  const upSun = dot(up, sun);
  Loop({ start: int(0), end: samples, type: 'int', condition: '<' }, ({ i }: { i: Node<'int'> }) => {
    const a = float(i).div(count);
    const b = float(i).add(1).div(count);
    const middle = a.add(b).mul(0.5);
    const d = start.add(length_.mul(middle).mul(middle));
    const step = length_.mul(b.mul(b).sub(a.mul(a)));
    const h = max(altitudeAlong(h0, r, mu, d), 0);
    const rayleigh = exp(h.div(-ATMOSPHERE.rayleighScaleHeightKm)).mul(step);
    const mie = exp(h.div(-ATMOSPHERE.mieScaleHeightKm)).mul(step);
    // The sample's distance from the center is r + h; its zenith is (r0·up + d·dir) / (r + h).
    const sunMu = clamp(r0.mul(upSun).add(d.mul(cosAngle)).div(r.add(h)), -1, 1);
    const light = lightDepths(h, r, sunMu);
    const toSun = RAYLEIGH.mul(light.x.mul(ATMOSPHERE.rayleighScaleHeightKm)).add(
      light.y.mul(haze).mul(ATMOSPHERE.mieExtinctionPerKm * ATMOSPHERE.mieScaleHeightKm),
    );
    const stepExtinction = extinction(rayleigh, mie, haze);
    const reaching = exp(depth.add(stepExtinction.mul(0.5)).add(toSun).negate()).mul(light.z);
    const scattered = RAYLEIGH.mul(rayleigh.mul(rayleighPhase)).add(
      mie.mul(haze).mul(miePhase).mul(ATMOSPHERE.mieScatteringPerKm),
    );
    radiance.addAssign(reaching.mul(scattered));
    depth.addAssign(stepExtinction);
  });
  return { radiance, depth };
}

/** Maps radiance to display values (linear, 0 to 1): an exponential exposure curve that never clips. */
function toDisplay(radiance: Vec3Node): Vec3Node {
  return exp(radiance.mul(-SUN_INTENSITY)).oneMinus();
}

/**
 * Adds ±1 step of 8-bit noise, triangular, in a gamma-2 space close to sRGB, so smooth gradients show no bands after
 * the 8-bit output (F392). The amplitude follows the uniform, 0 turning it off.
 */
function dither(u: AtmosphereUniforms, color: Vec3Node): Vec3Node {
  const seed = screenCoordinate.x.add(screenCoordinate.y.mul(4099));
  const noise = hash(seed)
    .add(hash(seed.add(0.5)))
    .sub(1)
    .div(255)
    .mul(n<'float'>(u.dither));
  const encoded = sqrt(max(color, 0)).add(noise);
  return max(encoded, 0).mul(max(encoded, 0));
}

/** Where a ray from the eye enters the atmosphere (0 when the eye is inside) and where it leaves it or hits ground. */
function raySpan(u: AtmosphereUniforms, dir: Vec3Node): { start: FloatNode; end: FloatNode; ground: FloatNode } {
  const h0 = n<'float'>(u.eyeAltitudeKm);
  const r = n<'float'>(u.radiusKm);
  const mu = dot(dir, n<'vec3'>(u.up));
  const top = crossings(h0, r, mu, float(ATMOSPHERE.topKm));
  const ground = crossings(h0, r, mu, float(0));
  const hitsGround = ground.z.greaterThan(0).and(ground.x.greaterThan(0));
  const exit = select(top.z.greaterThan(0), max(top.y, 0), float(0));
  const start = select(h0.greaterThan(ATMOSPHERE.topKm), min(max(top.x, 0), exit), float(0));
  const end = select(hitsGround, min(ground.x, exit), exit);
  return { start, end, ground: select(hitsGround, float(1), float(0)) };
}

/**
 * The sky's color for a world-space view ray (not necessarily unit length): the light scattered along it, black space
 * beyond the atmosphere, and dim ground where it hits the ground with no tile drawn there.
 */
export function skyColor(u: AtmosphereUniforms, worldRay: Vec3Node): Vec3Node {
  return Fn(() => {
    const dir = normalize(worldRay.mul(n<'vec3'>(u.axisScale)));
    const span = raySpan(u, dir);
    const scattering = march(u, dir, span.start, span.end, n<'int'>(u.skySamples));
    const color = toDisplay(scattering.radiance).toVar();
    If(span.ground.greaterThan(0), () => {
      color.addAssign(exp(scattering.depth.negate()).mul(GROUND_ALBEDO));
    });
    return dither(u, color);
  })() as Vec3Node;
}

/**
 * A surface color seen through the atmosphere (F394), lit by the Sun when lighting is on (F396): the color times the
 * light reaching it, dimmed by the transmittance to the eye, plus the light the air scatters toward the eye on the way.
 * `eyeRelative` is the fragment's position relative to the eye in meters, world axes (`eyeRelativePosition`).
 */
export function surfaceColor(u: AtmosphereUniforms, color: Vec3Node, eyeRelative: Vec3Node): Vec3Node {
  return Fn(() => {
    const scaled = eyeRelative.mul(n<'vec3'>(u.axisScale)).mul(0.001);
    const distance = length(scaled);
    const dir = scaled.div(max(distance, 1e-6));
    const span = raySpan(u, dir);
    const end = min(distance, span.end);
    const scattering = march(u, dir, min(span.start, end), end, n<'int'>(u.surfaceSamples));
    // The surface's zenith and altitude, as for a sample at the end of the ray.
    const h0 = n<'float'>(u.eyeAltitudeKm);
    const r = n<'float'>(u.radiusKm);
    const up = n<'vec3'>(u.up);
    const sun = n<'vec3'>(u.sun);
    const h = max(altitudeAlong(h0, r, dot(dir, up), distance), 0);
    const sunMu = clamp(
      r
        .add(h0)
        .mul(dot(up, sun))
        .add(distance.mul(dot(dir, sun)))
        .div(r.add(h)),
      -1,
      1,
    );
    const light = lightDepths(h, r, sunMu);
    const sunlight = exp(
      RAYLEIGH.mul(light.x.mul(ATMOSPHERE.rayleighScaleHeightKm))
        .add(light.y.mul(n<'float'>(u.haze)).mul(ATMOSPHERE.mieExtinctionPerKm * ATMOSPHERE.mieScaleHeightKm))
        .negate(),
    )
      .mul(light.z)
      .mul(max(sunMu, 0));
    const lit = mix(vec3(1), sunlight.mul(1 - NIGHT_AMBIENT).add(NIGHT_AMBIENT), n<'float'>(u.lighting));
    const seen = color.mul(lit).mul(exp(scattering.depth.negate())).add(toDisplay(scattering.radiance));
    return dither(u, seen);
  })() as Vec3Node;
}
