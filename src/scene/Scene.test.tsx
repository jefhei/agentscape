import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from './scenePlan.ts'
import Scene from './Scene.tsx'

/**
 * Wiring tests for the mounted scene (M3-T6).
 *
 * jsdom has no GPU, so the *rendered* scene cannot be inspected — the PRD §5 rule
 * is explicit that the look is human-reviewed (M5-T5). What *can* be asserted
 * headlessly is the wiring this task is about: that `<Scene>` hands each layer the
 * sub-plan of the **one** scene plan it was given, and that it mounts nothing else.
 * The four layers are replaced with recording stubs for exactly that reason.
 */

const seen = vi.hoisted(() => ({
  nodesPlan: null as unknown,
  arcsPlan: null as unknown,
  glyphsPlan: null as unknown,
  environmentPlan: null as unknown,
  nodeRun: null as unknown,
}))

vi.mock('./AgentNodeLayer.tsx', () => ({
  default: (props: { run?: unknown; plan?: unknown }) => {
    seen.nodesPlan = props.plan
    seen.nodeRun = props.run
    return createElement('div', { 'data-testid': 'layer-nodes' })
  },
}))

vi.mock('./MessageArcLayer.tsx', () => ({
  default: (props: { plan?: unknown }) => {
    seen.arcsPlan = props.plan
    return createElement('div', { 'data-testid': 'layer-arcs' })
  },
}))

vi.mock('./GlyphLayer.tsx', () => ({
  default: (props: { plan?: unknown }) => {
    seen.glyphsPlan = props.plan
    return createElement('div', { 'data-testid': 'layer-glyphs' })
  },
}))

vi.mock('./EnvironmentRig.tsx', () => ({
  default: (props: { plan?: unknown }) => {
    seen.environmentPlan = props.plan
    return createElement('div', { 'data-testid': 'layer-environment' })
  },
}))

const RUN = buildFixture('fan-out').run

describe('Scene — the mounted scene (M3-T6)', () => {
  it('hands each layer its own sub-plan of the one scene plan', () => {
    const plan = buildScenePlan(RUN)
    render(<Scene plan={plan} />)

    // Identity, not equality: the layers receive the very objects the scene
    // measured, so there is no second derivation that could drift.
    expect(seen.nodesPlan).toBe(plan.nodes)
    expect(seen.arcsPlan).toBe(plan.arcs)
    expect(seen.glyphsPlan).toBe(plan.glyphs)
    expect(seen.environmentPlan).toBe(plan.environment)
  })

  it('passes the plan’s own run through to the layers', () => {
    const plan = buildScenePlan(buildFixture('loop').run)
    render(<Scene plan={plan} />)
    expect(seen.nodeRun).toBe(plan.run)
  })

  it('mounts exactly four layers — rig, nodes, arcs, glyphs — and nothing else', () => {
    const plan = buildScenePlan(RUN)
    const { container } = render(<Scene plan={plan} />)

    expect(screen.getByTestId('layer-environment')).toBeInTheDocument()
    expect(screen.getByTestId('layer-nodes')).toBeInTheDocument()
    expect(screen.getByTestId('layer-arcs')).toBeInTheDocument()
    expect(screen.getByTestId('layer-glyphs')).toBeInTheDocument()
    // The scene creates no drawable object of its own (the budget gate depends on
    // exactly this: three drawables, one per instanced/batched layer).
    expect(container.querySelectorAll('[data-testid^="layer-"]')).toHaveLength(4)
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('instancedmesh')).toBeNull()
    expect(container.querySelector('mesh')).toBeNull()
  })

  it('mounts a scene for every fixture without touching the run', () => {
    for (const entry of ['fan-out', 'loop', 'dead-branch', 'handoff-chain'] as const) {
      const plan = buildScenePlan(buildFixture(entry).run)
      const before = JSON.stringify(plan.run)
      const { unmount } = render(<Scene plan={plan} />)
      expect(seen.nodesPlan).toBe(plan.nodes)
      expect(seen.glyphsPlan).toBe(plan.glyphs)
      unmount()
      expect(JSON.stringify(plan.run)).toBe(before)
    }
  })
})
