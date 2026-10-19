import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import AgentNodeLayer from './AgentNodeLayer.tsx'
import MessageArcLayer from './MessageArcLayer.tsx'
import GlyphLayer from './GlyphLayer.tsx'
import { buildScenePlan } from './scenePlan.ts'

/**
 * Each layer must *use* the plan the scene hands it rather than re-deriving its
 * own (M3-T6) — that is what makes "one settlement per scene" a fact instead of an
 * intention.
 *
 * The discriminator is behavioural, not structural: a layer given a plan with **no
 * elements** draws nothing. A layer that ignored the prop and rebuilt from `run`
 * would draw the run's real nodes / arcs / glyphs instead. jsdom cannot render
 * WebGL, but it does render the JSX elements a component emits, so "nothing
 * rendered" versus "elements rendered" is observable — and that is the whole claim.
 *
 * `useFrame` is stubbed because these three components are R3F scene children,
 * which only have a frame loop inside a real `<Canvas>` (jsdom has none).
 */

vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>()
  return { ...actual, useFrame: () => undefined }
})

const RUN = buildFixture('fan-out').run

describe('scene layers — reuse the supplied plan (M3-T6)', () => {
  it('draws nothing when the supplied node plan has no instances', () => {
    const plan = buildScenePlan(RUN)
    expect(plan.nodes.count).toBeGreaterThan(0)
    const { container } = render(
      <AgentNodeLayer run={RUN} plan={{ ...plan.nodes, count: 0, instances: [] }} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('draws nothing when the supplied arc plan has no arcs', () => {
    const plan = buildScenePlan(RUN)
    expect(plan.arcs.count).toBeGreaterThan(0)
    const { container } = render(
      <MessageArcLayer run={RUN} plan={{ ...plan.arcs, count: 0 }} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('draws nothing when the supplied glyph plan has no glyphs', () => {
    const plan = buildScenePlan(RUN)
    expect(plan.glyphs.count).toBeGreaterThan(0)
    const { container } = render(
      <GlyphLayer run={RUN} plan={{ ...plan.glyphs, count: 0, glyphs: [] }} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('is not vacuous: a layer that derives its own plan still draws its element', () => {
    // Same run, no plan prop: the standalone path rebuilds and emits one mesh. If
    // this rendered nothing too, the three tests above would prove nothing about
    // the `plan` prop. (The arc layer is the one of the three whose effects do not
    // call InstancedMesh methods, which a DOM element in jsdom does not have.)
    const { container } = render(<MessageArcLayer run={RUN} />)
    expect(container.querySelector('mesh')).not.toBeNull()
  })
})
