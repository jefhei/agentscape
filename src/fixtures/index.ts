/**
 * Public entry point for the deterministic trace fixtures (M1-T6).
 *
 * Import from `../fixtures` (or `./fixtures`), not from the deep module path —
 * this barrel is the seam that lets the fixture set grow without touching
 * every consumer.
 */
export {
  buildFixture,
  FIXTURES,
  FIXTURE_EPOCH_MS,
  FIXTURE_SHAPES,
} from './traceFixtures.ts'

export type { FixtureShape, TraceFixture } from './traceFixtures.ts'
