/**
 * The arc layer's GLSL (M3-T2) — the animated half of the batched message arcs.
 *
 * A `ShaderMaterial` is the only way to animate a pulse along a batched curve
 * without one mesh (and one update per frame) per message, so the animation
 * lives in GLSL — and the **rule** lives in the pure layer
 * ({@link arcPulseParameter}, `./arcs.ts`), which is what makes it testable at
 * all: jsdom has no GPU, so nothing about the rendered look is asserted (PRD
 * §5). What *is* gateable is the contract between the two halves, and this
 * module is built so that contract cannot rot:
 *
 * - the **attribute** declarations are generated from
 *   {@link ARC_CUSTOM_ATTRIBUTES}, the same list the geometry builder writes —
 *   a geometry attribute the shader forgot (or a shader attribute the geometry
 *   never provides) is impossible;
 * - the **uniform** declarations are generated from {@link ARC_UNIFORMS}, the
 *   same list {@link buildArcUniforms} builds values for;
 * - a test asserts the vertex shader's pulse formula uses the same names, so the
 *   GPU twin of `arcPulseParameter` cannot silently diverge from it.
 *
 * Pure: this module is strings and numbers — no three.js, no DOM, no clock, no
 * `Math.random`. The render layer (`MessageArcLayer.tsx`) supplies `uTime` from
 * its frame clock, which is the PRD's split exactly: the pure layer owns the
 * *rule*, the render layer owns the *clock*.
 *
 * The colours and glow constants here are deliberate working defaults, **not a
 * calibration** — the bloom-honest emissive calibration and the lighting rig are
 * M3-T4, and the look itself is human-reviewed (M5-T5).
 */

import { ARC_CUSTOM_ATTRIBUTES } from './arcs.ts'
import type { ArcSceneStyle } from './arcs.ts'
import type { Rgb } from './nodes.ts'

// ── Material tunables (M3-T4 owns the calibration; these are placeholders) ──

/** Brightness of the standing conduit glow, before the pulse is added. */
export const DEFAULT_ARC_BASE_GLOW = 0.45

/** How much brighter than the conduit a pulse reads at its centre. */
export const DEFAULT_ARC_PULSE_GAIN = 1.6

/** Brightness of the tube's silhouette, as a fraction of its facing surface. */
export const DEFAULT_ARC_RIM_DIM = 0.25

/** Brightness of the quietest channel on the arc layer (`intensity === 0`). */
export const DEFAULT_ARC_MIN_BRIGHTNESS = 0.35

// ── The uniform contract ────────────────────────────────────────────────────

/**
 * Every uniform the shaders declare, with the stage that reads it. One table,
 * so the declarations, the values {@link buildArcUniforms} produces and the
 * tests cannot disagree.
 */
export const ARC_UNIFORMS = [
  // Frame clock, in seconds. The render layer advances it; the pure layer never
  // reads a clock.
  { name: 'uTime', type: 'float', stage: 'vertex' },
  { name: 'uBaseColor', type: 'vec3', stage: 'fragment' },
  { name: 'uPulseColor', type: 'vec3', stage: 'fragment' },
  { name: 'uPulseWidth', type: 'float', stage: 'fragment' },
  { name: 'uBaseGlow', type: 'float', stage: 'fragment' },
  { name: 'uPulseGain', type: 'float', stage: 'fragment' },
  { name: 'uRimDim', type: 'float', stage: 'fragment' },
  { name: 'uMinBrightness', type: 'float', stage: 'fragment' },
] as const

/** One of the {@link ARC_UNIFORMS} names. */
export type ArcUniformName = (typeof ARC_UNIFORMS)[number]['name']

/** Optional overrides for the material's glow constants. All defaulted. */
export interface ArcMaterialOptions {
  /** Conduit glow before the pulse; default {@link DEFAULT_ARC_BASE_GLOW}. */
  baseGlow?: number
  /** Pulse gain over the conduit; default {@link DEFAULT_ARC_PULSE_GAIN}. */
  pulseGain?: number
  /** Silhouette dimming; default {@link DEFAULT_ARC_RIM_DIM}. */
  rimDim?: number
  /** Quietest-channel brightness; default {@link DEFAULT_ARC_MIN_BRIGHTNESS}. */
  minBrightness?: number
}

/** A three.js-style uniform slot. Plain numbers/tuples — no three.js import. */
export interface ArcUniform {
  value: number | Rgb
}

/** The uniform set for one arc material, keyed by {@link ArcUniformName}. */
export type ArcUniforms = Record<ArcUniformName, ArcUniform>

/** A finite, non-negative override, or its deterministic default. */
function number(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/**
 * Build a fresh uniform set from the plan's style: the two colours, the pulse
 * band width and the material's glow constants, with `uTime` at `0` — the render
 * layer owns the clock and advances that one uniform each frame.
 *
 * Pure and deterministic; a fresh object (and fresh tuples) each call, so a
 * material can never share mutable state with another.
 */
export function buildArcUniforms(
  style: ArcSceneStyle,
  material: ArcMaterialOptions = {},
): ArcUniforms {
  return {
    uTime: { value: 0 },
    uBaseColor: { value: [...style.baseColor] as Rgb },
    uPulseColor: { value: [...style.pulseColor] as Rgb },
    uPulseWidth: { value: style.pulseWidth },
    uBaseGlow: { value: number(material.baseGlow, DEFAULT_ARC_BASE_GLOW) },
    uPulseGain: { value: number(material.pulseGain, DEFAULT_ARC_PULSE_GAIN) },
    uRimDim: { value: number(material.rimDim, DEFAULT_ARC_RIM_DIM) },
    uMinBrightness: {
      value: number(material.minBrightness, DEFAULT_ARC_MIN_BRIGHTNESS),
    },
  }
}

// ── Declarations, generated from the contract ───────────────────────────────

/** `uniform <type> <name>;` lines for one stage, straight from {@link ARC_UNIFORMS}. */
function uniformDeclarations(stage: 'vertex' | 'fragment'): string {
  return ARC_UNIFORMS.filter((uniform) => uniform.stage === stage)
    .map((uniform) => `uniform ${uniform.type} ${uniform.name};`)
    .join('\n')
}

/**
 * `attribute float <name>;` lines for the layer's own attributes. `position`,
 * `normal` and `uv` are injected by three.js for a `ShaderMaterial`, so they are
 * deliberately absent here — re-declaring them is a compile error.
 */
const ATTRIBUTE_DECLARATIONS = ARC_CUSTOM_ATTRIBUTES.map(
  (name) => `attribute float ${name};`,
).join('\n')

/** The varyings passed from the vertex shader to the fragment shader. */
const VARYING_DECLARATIONS = [
  'varying float vT;',
  'varying float vPulse;',
  'varying float vIntensity;',
  'varying vec3 vNormal;',
  'varying vec3 vViewPosition;',
].join('\n')

// ── The shaders ─────────────────────────────────────────────────────────────

/**
 * The arc vertex shader: places a tube vertex (the geometry already did the
 * geometry work) and computes where the pulse sits along the arc at `uTime`.
 *
 * The pulse formula is the GPU twin of {@link arcPulseParameter}: wrap
 * `uTime × aSpeed + aPhase` into `[0, 1)`, then flip it for a channel whose net
 * flow runs the other way (`aFlow < 0`). A parked channel (`aFlow === 0`,
 * `aSpeed === 0`) sits at its own phase and does not move.
 */
export const ARC_VERTEX_SHADER = `
${uniformDeclarations('vertex')}

${ATTRIBUTE_DECLARATIONS}

${VARYING_DECLARATIONS}

void main() {
  // Mirror of the pure reference arcPulseParameter (./arcs.ts).
  float cycles = uTime * aSpeed + aPhase;
  float wrapped = fract(cycles);
  float pulse = aFlow < 0.0 ? 1.0 - wrapped : wrapped;

  vT = aT;
  vPulse = pulse;
  vIntensity = aIntensity;
  vNormal = normalize(normalMatrix * normal);

  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`.trim()

/**
 * The arc fragment shader: a band of light travelling along the tube. Its
 * distance to the pulse is measured in arc parameter (so it wraps around the
 * ends), the conduit and the pulse colours are mixed by that band, the tube is
 * rounded by dimming its silhouette, and the whole line is scaled by the arc's
 * own normalized volume (`aIntensity`, M2-T3) so a busy channel reads brighter.
 */
export const ARC_FRAGMENT_SHADER = `
${uniformDeclarations('fragment')}

${VARYING_DECLARATIONS}

void main() {
  // Wrap-around distance from this fragment to the pulse, in arc parameter.
  float delta = abs(vT - vPulse);
  delta = min(delta, 1.0 - delta);
  float pulse = 1.0 - smoothstep(uPulseWidth * 0.35, uPulseWidth, delta);

  vec3 color = mix(uBaseColor, uPulseColor, pulse) * (uBaseGlow + pulse * uPulseGain);

  // Round the conduit: dim the silhouette against the camera.
  float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
  float falloff = mix(uRimDim, 1.0, facing * facing);

  float brightness = uMinBrightness + (1.0 - uMinBrightness) * vIntensity;
  gl_FragColor = vec4(color * falloff * brightness, 1.0);
}
`.trim()
