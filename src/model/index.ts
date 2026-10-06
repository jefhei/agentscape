/**
 * Public entry point for the TraceModel normalization pass (M1-T5).
 *
 * Import from `../model` (or `./model`), not from the deep module path — this
 * barrel is the seam that lets the normalizer grow (filters, timeline-derived
 * helpers) without touching every consumer.
 */
export { compareModelIds, normalizeTrace, TraceModelError } from './traceModel.ts'

export type { TraceModel } from './traceModel.ts'
