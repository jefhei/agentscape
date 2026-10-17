/**
 * The tone-mapping model the emissive calibration is solved against (M3-T4).
 *
 * Bloom-honest calibration needs one thing the render layer cannot give it
 * headlessly: *what a linear radiance will look like after tone mapping*. The
 * renderer applies `THREE.ACESFilmicToneMapping`; this module carries the same
 * curve in pure form so the calibration can pick a radiance for a target
 * appearance — and, crucially, can be **inverted**, which is how the hot end of
 * the activity range is pinned to a stated display brightness instead of
 * hand-tuned.
 *
 * The curve is Krzysztof Narkowicz's ACES filmic approximation, the fit that is
 * ubiquitous in real-time renderers:
 *
 *     f(x) = (x·(2.51x + 0.03)) / (x·(2.43x + 0.59) + 0.14)
 *
 * three.js's shader implementation is the same ACES family with an extended
 * colour-space pipeline (ACES input/output matrices around the same RRT+ODT fit),
 * so this is a *brightness model*, not a pixel-exact prediction: it is what the
 * calibration is solved against, and the final look is human-reviewed (M5-T5).
 *
 * Pure: no three.js, no DOM, no clock.
 */

/** ACES fit coefficients (kept named so the inverse below is verifiably its inverse). */
const A = 2.51
const B = 0.03
const C = 2.43
const D = 0.59
const E = 0.14

/** Thrown when a display value has no inverse — a calibration anchor outside `(0, 1)`. */
export class ToneMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToneMappingError'
  }
}

/**
 * The ACES filmic fit, saturated: linear radiance → display luminance in `[0, 1]`.
 * Monotone increasing, `0` at `0`, and flat at `1` once the curve reaches white —
 * which is the roll-off that keeps highlights from clipping. The raw fit's
 * asymptote is `A/C = 2.51/2.43 ≈ 1.033`, so the clamp is not cosmetic: three.js
 * applies exactly the same `saturate()` after the fit, and without it a "display
 * luminance" could read above white. Negative or non-finite input is treated as
 * `0` (radiance is non-negative).
 */
export function acesFilmic(radiance: number): number {
  const x = Number.isFinite(radiance) ? Math.max(0, radiance) : 0
  return Math.min(1, (x * (A * x + B)) / (x * (C * x + D) + E))
}

/**
 * Invert {@link acesFilmic}: the linear radiance that displays as `display`.
 *
 * Solving `y·(C·x² + D·x + E) = A·x² + B·x` for `x` is a quadratic, so the answer
 * is exact rather than searched:
 *
 *     (C·y − A)·x² + (D·y − B)·x + E·y = 0
 *
 * For `y ∈ (0, 1)` the leading coefficient is negative, the constant positive, so
 * the discriminant is always positive and exactly one root is positive. That root
 * is returned. The interval is open at both ends because `0` is the curve's fixed
 * point at the origin and `1` is its flat top (every radiance above ~7.24 clamps
 * there), so neither endpoint names a single radiance — inverting them would be a
 * guess, and the caller gets told instead.
 *
 * @throws ToneMappingError when `display` is not a finite number in `(0, 1)`.
 */
export function inverseAcesFilmic(display: number): number {
  if (!Number.isFinite(display) || display <= 0 || display >= 1) {
    throw new ToneMappingError(
      `display luminance must be in (0, 1) to invert ACES; got ${String(display)}`,
    )
  }
  const a = C * display - A
  const b = D * display - B
  const c = E * display
  const discriminant = b * b - 4 * a * c
  const root = (-b - Math.sqrt(discriminant)) / (2 * a)
  // The quadratic's other root is negative; guard anyway so a future coefficient
  // change cannot silently hand back a negative radiance.
  return root > 0 ? root : (-b + Math.sqrt(discriminant)) / (2 * a)
}
