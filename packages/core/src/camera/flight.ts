/**
 * The optimal zoom-and-pan path of van Wijk and Nuij ("Smooth and efficient zooming and panning", 2003) for flights
 * (F195): the view's width w and its center's travelled distance u along a path parameter s, so that the camera
 * rises while it travels and descends at the end, at a perceived constant speed. Widths and distances share one unit
 * (ground meters). Written from the paper's equations; allocates nothing.
 */

/** The paper's trade-off between zooming and panning; √2 is its recommended value, 1.42 in practice. */
const FLIGHT_RHO = 1.42;

/** Below this distance, relative to the widths, a flight is a pure zoom (the paper's u₁ = 0 case). */
const PURE_ZOOM_EPSILON = 1e-9;

/** Slots of a {@link FlightPath}'s parameters. */
const W0 = 0;
const W1 = 1;
const U1 = 2;
const R0 = 3;
const LENGTH = 4;
/** 0 for a flight, then +1 or −1 for a pure zoom out or in. */
const ZOOM_SIGN = 5;

/**
 * A flight path from a view `w0` wide to one `w1` wide whose centers lie `u1` apart. {@link length} is the path's
 * length S in the paper's units; {@link evaluate} gives the width and travelled distance at a fraction of it.
 */
export class FlightPath {
  private readonly p = new Float64Array(6);

  /** Sets the path; widths must be positive and the distance at least 0. Allocates nothing. */
  set(w0: number, w1: number, u1: number): this {
    const p = this.p;
    p[W0] = w0;
    p[W1] = w1;
    p[U1] = u1;
    if (u1 <= PURE_ZOOM_EPSILON * (w0 > w1 ? w0 : w1)) {
      p[ZOOM_SIGN] = w1 >= w0 ? 1 : -1;
      p[LENGTH] = Math.abs(Math.log(w1 / w0)) / FLIGHT_RHO;
      p[R0] = 0;
      return this;
    }
    p[ZOOM_SIGN] = 0;
    const rho2 = FLIGHT_RHO * FLIGHT_RHO;
    const rho4u2 = rho2 * rho2 * u1 * u1;
    const b0 = (w1 * w1 - w0 * w0 + rho4u2) / (2 * w0 * rho2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - rho4u2) / (2 * w1 * rho2 * u1);
    // r = ln(−b + √(b² + 1)), written as −asinh(b) to keep precision when b is large.
    const r0 = -Math.asinh(b0);
    const r1 = -Math.asinh(b1);
    p[R0] = r0;
    p[LENGTH] = (r1 - r0) / FLIGHT_RHO;
    return this;
  }

  /** The path's length S: a flight's duration is proportional to it. */
  get length(): number {
    return this.p[LENGTH] ?? 0;
  }

  /**
   * Writes into `out[0]` the view width and into `out[1]` the distance travelled from the start, at the fraction
   * `out[2]` (0 to 1) of the path. Inputs and outputs share the array: a double passed as an argument is boxed in hot
   * code (ADR 0018).
   */
  evaluate(out: Float64Array): void {
    const p = this.p;
    const w0 = p[W0] ?? 1;
    const t = out[2] ?? 0;
    const s = t * (p[LENGTH] ?? 0);
    const sign = p[ZOOM_SIGN] ?? 0;
    if (sign !== 0) {
      out[0] = w0 * Math.exp(sign * FLIGHT_RHO * s);
      out[1] = t * (p[U1] ?? 0);
      return;
    }
    const r0 = p[R0] ?? 0;
    const rho2 = FLIGHT_RHO * FLIGHT_RHO;
    const coshR0 = Math.cosh(r0);
    out[0] = (w0 * coshR0) / Math.cosh(FLIGHT_RHO * s + r0);
    out[1] = (w0 / rho2) * (coshR0 * Math.tanh(FLIGHT_RHO * s + r0) - Math.sinh(r0));
  }
}
