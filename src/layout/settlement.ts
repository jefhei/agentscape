/**
 * Layout settlement rules (M2-T2).
 *
 * The second half of the M2 "Spatial Layout Engine". {@link layoutTrace}
 * (M2-T1) runs a *fixed* number of relaxation iterations and returns the
 * configuration wherever it lands. {@link settleLayout} instead relaxes until
 * the shape **settles** — the forces balance and the nodes stop moving — and
 * reports exactly when and how that happened.
 *
 * ## Why a separate settlement pass
 *
 * M2-T1 cools the simulation **linearly against the iteration budget**
 * (`temperature = half · (1 − iter/iterations)`). That is fine for a
 * fixed-budget primitive, but it has two properties that make it a poor
 * *settlement* rule:
 *
 * 1. **It freezes rather than equilibrates.** The cap only collapses in the
 *    final few iterations, so the raw residual force stays large for most of
 *    the run and the shape is really decided in the last stretch. There is no
 *    point at which you can say "this is settled".
 * 2. **Its result depends on the budget.** Change `iterations` and the cooling
 *    schedule — and therefore the whole trajectory and the final shape —
 *    changes with it. A re-layout at a different budget is a *different* run.
 *
 * The settlement pass fixes both by cooling **exponentially and
 * independently of the budget**: `temperature(i) = half · decay^i`. The
 * trajectory is then a function of the iteration index alone, so:
 *
 * - the residual energy decays geometrically to zero — the configuration
 *   genuinely reaches equilibrium (`stable convergence`); and
 * - the settled configuration is **budget-independent**: any `maxIterations`
 *   past the point of convergence yields the byte-identical result
 *   (`reproducible re-layout`).
 *
 * It drives the *same* physics as {@link layoutTrace} via the shared core in
 * `./forceLayout.ts` ({@link prepareSimulation} / {@link relaxIteration} /
 * {@link buildLayout}), so the two can never drift apart.
 *
 * Pure and deterministic (PRD §5): no three.js, no DOM, no clock, no
 * `Math.random`, no model mutation. jsdom-safe; the look is human-reviewed
 * (M5-T5).
 *
 * ## The three pinned properties
 *
 * - **Stable convergence** — energy decreases to `<= energyTolerance` (true
 *   force balance) within `maxIterations`; {@link Settlement.converged} says
 *   whether it did. A degenerate run (0–1 agents) is settled by definition.
 * - **No jitter** — every step moves each node by at most that step's
 *   temperature, which decays geometrically, so movement vanishes and the
 *   shape cannot oscillate at the end. Movement history is recorded so a test
 *   can pin it.
 * - **Reproducible re-layout** — the pass is a pure function (byte-identical
 *   across calls, independent of array order) whose result does **not** depend
 *   on `maxIterations` once past convergence.
 */

import type { TraceModel } from '../model/index.ts'
import { buildLayout, prepareSimulation, relaxIteration } from './forceLayout.ts'
import type { ForceLayout } from './forceLayout.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Hard cap on relaxation iterations. The exponential cooling below makes the
 * four reference fixtures (and anything of comparable size) converge in well
 * under a thousand, so this is generous headroom rather than a working budget —
 * it exists only to bound the cost on a pathologically large or unresolvable
 * graph. See {@link Settlement.converged}.
 */
export const DEFAULT_MAX_ITERATIONS = 2000

/**
 * Per-iteration cooling factor. Each step's displacement cap is the previous
 * step's multiplied by this — the exponential decay that makes the trajectory
 * budget-independent. `0.98` settles the fixtures to floating-point zero in
 * ~1000 steps while still leaving the system enough room to relax into a good
 * configuration (a faster decay freezes it too early; a slower one costs time).
 */
export const DEFAULT_DECAY = 0.98

/**
 * Residual total force (`Σ ‖Fᵢ‖`) at or below which the configuration counts as
 * settled. At a true equilibrium every node's forces cancel, so the residual is
 * exactly zero; this is the "small enough to be floating-point noise" floor.
 * Absolute (not relative) because the fixture scale is pinned by
 * {@link DEFAULT_IDEAL_DISTANCE}.
 */
export const DEFAULT_ENERGY_TOLERANCE = 1e-6

/** Bounds clamp for a caller-supplied decay, kept strictly inside `(0, 1)`. */
const MIN_DECAY = 1e-9
const MAX_DECAY = 0.9999

function clampDecay(decay: number): number {
  if (!Number.isFinite(decay)) return DEFAULT_DECAY
  return Math.min(MAX_DECAY, Math.max(MIN_DECAY, decay))
}

// ── Public shapes ───────────────────────────────────────────────────────────

/** Optional overrides for {@link settleLayout}. All have deterministic defaults. */
export interface SettlementOptions {
  /** Iteration cap; default {@link DEFAULT_MAX_ITERATIONS}. */
  maxIterations?: number
  /** Per-iteration cooling factor in `(0, 1)`; default {@link DEFAULT_DECAY}. */
  decay?: number
  /** Energy at/below which the layout is settled; default {@link DEFAULT_ENERGY_TOLERANCE}. */
  energyTolerance?: number
  /** Ideal edge length; default {@link DEFAULT_IDEAL_DISTANCE}. */
  idealDistance?: number
  /** Seed override; default is the model's own `seed`. */
  seed?: number
}

/**
 * The outcome of a settlement: the settled {@link ForceLayout} plus the record
 * of how it converged. Everything here is derived data a test (or a debug HUD)
 * can read; the render layer only needs {@link Settlement.layout}.
 */
export interface Settlement {
  /** The settled layout — identical to a `layoutTrace` result in shape. */
  layout: ForceLayout
  /** `true` when the energy dropped to `<= energyTolerance` before the cap. */
  converged: boolean
  /** Iterations actually run (`0` for a degenerate 0/1-agent run). */
  iterations: number
  /** The iteration cap the run was bounded by. */
  maxIterations: number
  /** The cooling factor used. */
  decay: number
  /** The energy threshold considered "settled". */
  energyTolerance: number
  /** Residual energy after each iteration, in order (the convergence trace). */
  energyHistory: number[]
  /** Greatest node movement applied by each iteration, in order (the jitter trace). */
  movementHistory: number[]
  /** `energyHistory.at(-1)` (or `0` when nothing ran) — the final residual force. */
  finalEnergy: number
  /** `movementHistory.at(-1)` (or `0` when nothing ran) — the last step's motion. */
  finalMovement: number
}

// ── The settlement pass ─────────────────────────────────────────────────────

/**
 * Relax a normalized {@link TraceModel} until it settles, and report how.
 *
 * Runs {@link relaxIteration} with an exponentially-decaying temperature
 * (`half · decay^i`, independent of the budget), stopping as soon as the
 * residual energy falls to `<= energyTolerance` or after `maxIterations`.
 * Because the trajectory depends only on the iteration index, the settled
 * configuration is the same for any cap past convergence — this is what makes
 * a re-layout reproducible. Deterministic: the same model and options always
 * yield a byte-identical {@link Settlement}, whatever order the model's arrays
 * arrive in, and the model is never mutated.
 *
 * Degenerate runs (0 or 1 agent) settle immediately: an empty layout, or the
 * single agent at the origin, `converged: true`, `iterations: 0`.
 *
 * @param model a normalized trace (M1-T5).
 * @param options iteration cap, cooling factor, energy tolerance, ideal edge
 *        length and seed overrides — all deterministically defaulted.
 */
export function settleLayout(
  model: TraceModel,
  options: SettlementOptions = {},
): Settlement {
  const maxIterations = Math.max(
    0,
    Math.floor(options.maxIterations ?? DEFAULT_MAX_ITERATIONS),
  )
  const decay = clampDecay(options.decay ?? DEFAULT_DECAY)
  const energyTolerance = Math.max(
    0,
    options.energyTolerance ?? DEFAULT_ENERGY_TOLERANCE,
  )

  const state = prepareSimulation(model, options)

  const energyHistory: number[] = []
  const movementHistory: number[] = []
  let energy = 0
  let movement = 0
  let iterations = 0
  let converged = state.count < 2 // a 0/1-agent run is settled as it stands

  if (state.count >= 2) {
    let temperature = state.half
    for (let iter = 0; iter < maxIterations; iter += 1) {
      const step = relaxIteration(state, temperature)
      energy = step.energy
      movement = step.movement
      energyHistory.push(energy)
      movementHistory.push(movement)
      iterations = iter + 1
      temperature *= decay

      if (energy <= energyTolerance) {
        converged = true
        break
      }
    }
  }

  return {
    layout: buildLayout(state, iterations, energy),
    converged,
    iterations,
    maxIterations,
    decay,
    energyTolerance,
    energyHistory,
    movementHistory,
    finalEnergy: energy,
    finalMovement: movement,
  }
}

/**
 * `true` when a layout's recorded residual force is at or below `tolerance` —
 * i.e. the configuration is (to within floating-point noise) at equilibrium.
 * A convenience over reading `layout.energy` directly; note that a
 * fixed-budget {@link layoutTrace} result with a small `iterations` will
 * typically be `false`, while a {@link settleLayout} result is `true` whenever
 * it reported `converged`.
 */
export function isSettled(
  layout: ForceLayout,
  tolerance: number = DEFAULT_ENERGY_TOLERANCE,
): boolean {
  return layout.energy <= tolerance
}
