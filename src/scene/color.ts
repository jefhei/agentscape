/**
 * Colour math for the scene layer (M3-T4).
 *
 * A tiny, pure module the scene plans share: the linear-RGB tuple type, the
 * Rec.709 luminance of such a tuple, sRGB-hex → linear conversion (the renderer
 * takes a CSS hex string for the background/fog, the pure layer needs the linear
 * numbers to reason about brightness), and a hue-preserving rescale onto a target
 * luminance.
 *
 * Nothing here touches three.js, the DOM or the clock — three.js's own
 * `Color`/`SRGBToLinear` do the same job in the render layer, but the *calibration*
 * has to reason about luminance in the pure half (PRD §5: the data layer is pure
 * and testable, the render layer is a thin consumer). Keeping the transfer
 * functions here means the calibration and the colour it emits can never
 * disagree about what "linear" means.
 */

/** A linear RGB colour as a `[r, g, b]` tuple (plain numbers — no three.js). */
export type Rgb = [number, number, number]

/** Rec.709 luminance weights — the coefficients the renderer's eye model uses. */
export const LUMINANCE_WEIGHTS: Rgb = [0.2126, 0.7152, 0.0722]

/**
 * The luminance of a linear RGB colour under Rec.709 weighting. This is the
 * quantity brightness calibration is expressed in: two colours of different hue
 * but equal luminance read as equally bright, which is what lets a node's glow be
 * scaled to a target brightness without its hue changing.
 */
export function luminanceOf(color: Rgb): number {
  return (
    LUMINANCE_WEIGHTS[0] * color[0] +
    LUMINANCE_WEIGHTS[1] * color[1] +
    LUMINANCE_WEIGHTS[2] * color[2]
  )
}

/** True for a `#rgb` / `#rrggbb` string (the only forms a rig constant uses). */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

/** The sRGB transfer function's inverse, per channel (1.0 stays 1.0). */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

/**
 * Convert an sRGB hex colour (`#rrggbb` or `#rgb`) to linear RGB, which is the
 * space a renderer lights and tone-maps in. A malformed string is a programming
 * error in a rig constant, so it throws rather than silently rendering black.
 */
export function hexToLinearRgb(hex: string): Rgb {
  if (!isHexColor(hex)) {
    throw new Error(`not an sRGB hex colour: ${String(hex)}`)
  }
  const digits =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((character) => character + character)
          .join('')
      : hex.slice(1)
  return [
    srgbToLinear(parseInt(digits.slice(0, 2), 16) / 255),
    srgbToLinear(parseInt(digits.slice(2, 4), 16) / 255),
    srgbToLinear(parseInt(digits.slice(4, 6), 16) / 255),
  ]
}

/**
 * Rescale a colour to emit exactly `targetLuminance` while preserving its hue
 * ratios — the operation that makes a node's glow depend on its *activity* and not
 * on which colour the style happens to pick.
 *
 * A colour with no luminance (black) has no hue left to preserve, so it becomes
 * neutral grey at the target luminance: a node must never be invisible merely
 * because a caller passed black, and grey is the honest "no hue" answer.
 */
export function scaleToLuminance(color: Rgb, targetLuminance: number): Rgb {
  const target = Number.isFinite(targetLuminance) ? Math.max(0, targetLuminance) : 0
  const luminance = luminanceOf(color)
  if (!(luminance > 1e-12)) return [target, target, target]
  const scale = target / luminance
  return [color[0] * scale, color[1] * scale, color[2] * scale]
}
