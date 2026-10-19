import { describe, expect, expectTypeOf, it } from 'vitest'
import { FIXTURES } from '../fixtures/index.ts'
import type { FixtureShape } from '../fixtures/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import { settleLayout } from '../layout/index.ts'
import type { Vec3 } from '../layout/index.ts'
import { DRAW_CALL_CEILING, measureSceneBudget } from './budget.ts'
import {
  DEFAULT_FOV,
  DEFAULT_VIEW_DISTANCE,
  ENVIRONMENT_DRAW_CALLS,
  buildEnvironmentPlan,
} from './environment.ts'
import { NODE_LAYER_DRAW_CALLS } from './nodes.ts'
import { ARC_LAYER_DRAW_CALLS } from './arcs.ts'
import { GLYPH_LAYER_DRAW_CALLS } from './glyphs.ts'
import {
  CAMERA_FAR_MARGIN,
  CAMERA_NEAR,
  buildScenePlan,
  sceneCamera,
} from './scenePlan.ts'
import type { ScenePlan } from './scenePlan.ts'

/**
 * Tests for the whole-scene plan (M3-T6) — the composition step that mounts a
 * trace end to end.
 *
 * What is gated here is the **pure half**: that one run composes into one scene
 * from **one** settlement and **one** attribute map, that the counts and the
 * measured budget come from the trace's own facts, that the camera frames the
 * settled cloud with the rig's own framing distance, and that the whole thing is
 * deterministic and order-independent.
 *
 * Nothing about the rendered look is asserted: jsdom has no GPU, and the look is
 * human-reviewed (M5-T5). The camera's *numbers* are a different matter — a camera
 * that misses the cloud, or clips it, is a data bug, and is checked as geometry.
 */

const ISO = '2026-10-01T09:00:00.000Z'

/** One of the four deterministic fixtures (M1-T6). */
function fixture(shape: FixtureShape): TraceModel {
  const entry = FIXTURES.find((item) => item.shape === shape)
  if (entry === undefined) throw new Error(`no fixture for shape ${shape}`)
  return entry.run
}

/** An empty run through the real ingest path — the degenerate case. */
function emptyRun(): TraceModel {
  return normalizeTrace(parseAgentMessagesExport([], { label: 'empty' }))
}

/** A one-agent run: a single broadcast from an agent nobody else hears. */
function soloRun(): TraceModel {
  const rows: AgentMessageRow[] = [
    { id: 1, from_agent: 'solo', to_agent: null, body: null, created_at: ISO },
  ]
  return normalizeTrace(parseAgentMessagesExport(rows, { label: 'solo' }))
}

/** The same model with every array reversed — the order-independence probe. */
function scrambled(model: TraceModel): TraceModel {
  return {
    ...model,
    agents: [...model.agents].reverse(),
    messages: [...model.messages].reverse(),
    toolCalls: [...model.toolCalls].reverse(),
    events: [...model.events].reverse(),
  }
}

/** Euclidean distance between two plain vectors. */
function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

/** Every node's settled position, in the layout's canonical order. */
function nodePositions(plan: ScenePlan): Vec3[] {
  return plan.layout.nodes.map((node) => node.position)
}

// ── composition ─────────────────────────────────────────────────────────────

describe('scene plan — composition (M3-T6)', () => {
  it('builds a fully-formed plan for a run', () => {
    const model = fixture('fan-out')
    const plan = buildScenePlan(model)

    expectTypeOf(plan).toEqualTypeOf<ScenePlan>()
    expectTypeOf(plan.camera.near).toEqualTypeOf<number>()
    expectTypeOf(plan.counts.elements).toEqualTypeOf<number>()

    expect(plan.run).toBe(model)
    expect(plan.runId).toBe(model.id)
    expect(plan.label).toBe(model.label)
    expect(plan.seed).toBe(model.seed)
    expect(plan.layout).toBe(plan.nodes.layout)
    expect(plan.attributeMap).toBe(plan.nodes.attributes)
    expect(plan.camera.distance).toBeGreaterThan(0)
    expect(plan.withinBudget).toBe(true)
  })

  it('counts what it draws from the trace facts, layer by layer', () => {
    for (const entry of FIXTURES) {
      const plan = buildScenePlan(entry.run)
      expect(plan.counts.agents, entry.shape).toBe(entry.run.meta.agentCount)
      expect(plan.counts.messages, entry.shape).toBe(entry.run.meta.messageCount)
      expect(plan.counts.toolCalls, entry.shape).toBe(entry.run.meta.toolCallCount)
      // One node per agent, one arc per derived link, one glyph per tool call.
      expect(plan.counts.nodes, entry.shape).toBe(plan.nodes.count)
      expect(plan.counts.arcs, entry.shape).toBe(plan.arcs.count)
      expect(plan.counts.glyphs, entry.shape).toBe(plan.glyphs.count)
      expect(plan.counts.links, entry.shape).toBe(plan.arcs.count)
      expect(plan.counts.elements, entry.shape).toBe(
        plan.nodes.count + plan.arcs.count + plan.glyphs.count,
      )
    }
  })

  it('draws the shape each fixture is named for', () => {
    // The four fixtures' element counts were pinned by M3-T5's measurement; the
    // scene plan must not change what is drawn, only how it is composed.
    const counts = (shape: FixtureShape) => {
      const plan = buildScenePlan(fixture(shape))
      return [plan.counts.nodes, plan.counts.arcs, plan.counts.glyphs]
    }
    expect(counts('fan-out')).toEqual([6, 5, 5])
    expect(counts('loop')).toEqual([3, 2, 7])
    expect(counts('dead-branch')).toEqual([3, 2, 3])
    expect(counts('handoff-chain')).toEqual([4, 3, 3])
  })

  it('composes every layer from one settled layout and one attribute map', () => {
    const model = fixture('handoff-chain')
    const plan = buildScenePlan(model)
    const settled = settleLayout(model)

    // Identity, not just equality: all three scene layers share the one object.
    expect(plan.nodes.layout).toBe(plan.layout)
    expect(plan.arcs.layout).toBe(plan.layout)
    expect(plan.glyphs.layout).toBe(plan.layout)
    expect(plan.nodes.attributes).toBe(plan.attributeMap)
    expect(plan.arcs.attributes).toBe(plan.attributeMap)
    expect(plan.glyphs.attributes).toBe(plan.attributeMap)

    // ...and that object is the settlement M2-T2 produces for this run.
    expect(JSON.stringify(plan.layout)).toBe(JSON.stringify(settled.layout))
    expect(plan.settled.iterations).toBe(settled.iterations)
    expect(plan.settled.converged).toBe(settled.converged)

    // The rig was framed from the same layout rather than settling again.
    expect(plan.environment.seed).toBe(plan.seed)
    expect(plan.environment.settlement).toBeNull()
    expect(plan.environment.bounds).toBe(plan.layout.bounds)
  })

  it('hands the renderer the plans the budget gate measured', () => {
    const model = fixture('loop')
    const plan = buildScenePlan(model)
    const measured = measureSceneBudget(model)

    // The gate measures the very objects the scene will draw — there is no
    // second derivation the budget could disagree with.
    expect(JSON.stringify(plan.nodes)).toBe(JSON.stringify(measured.plans.nodes))
    expect(JSON.stringify(plan.arcs)).toBe(JSON.stringify(measured.plans.arcs))
    expect(JSON.stringify(plan.glyphs)).toBe(JSON.stringify(measured.plans.glyphs))
    expect(JSON.stringify(plan.environment)).toBe(
      JSON.stringify(measured.plans.environment),
    )
    expect(plan.drawCalls).toBe(measured.drawCalls)
    expect(plan.ceiling).toBe(measured.ceiling)
  })

  it('reports the draw calls the layers really cost, at the ceiling', () => {
    for (const entry of FIXTURES) {
      const plan = buildScenePlan(entry.run)
      const layerSum =
        plan.nodes.drawCalls +
        plan.arcs.drawCalls +
        plan.glyphs.drawCalls +
        plan.environment.drawCalls
      expect(plan.drawCalls, entry.shape).toBe(layerSum)
      expect(plan.drawCalls, entry.shape).toBe(DRAW_CALL_CEILING)
      expect(plan.nodes.drawCalls, entry.shape).toBe(NODE_LAYER_DRAW_CALLS)
      expect(plan.arcs.drawCalls, entry.shape).toBe(ARC_LAYER_DRAW_CALLS)
      expect(plan.glyphs.drawCalls, entry.shape).toBe(GLYPH_LAYER_DRAW_CALLS)
      expect(plan.environment.drawCalls, entry.shape).toBe(ENVIRONMENT_DRAW_CALLS)
      expect(plan.withinBudget, entry.shape).toBe(true)
    }
  })

  it('keeps post-processing out of the geometry ceiling', () => {
    const plan = buildScenePlan(fixture('fan-out'))
    expect(plan.bloom).toBe(true)
    expect(plan.postProcessPasses).toBe(1)
    // The bloom pass is real, and deliberately not part of the geometry budget.
    expect(plan.drawCalls + plan.postProcessPasses).toBeGreaterThan(plan.ceiling)
    expect(plan.environment.bloom.enabled).toBe(plan.bloom)
  })

  it('carries the settlement outcome, not just the shape', () => {
    const plan = buildScenePlan(fixture('dead-branch'))
    expect(plan.settled.converged).toBe(true)
    expect(plan.settled.iterations).toBe(plan.layout.iterations)
    expect(plan.settled.iterations).toBeGreaterThan(0)
  })
})

// ── camera framing ──────────────────────────────────────────────────────────

describe('scene plan — camera framing (M3-T6)', () => {
  it('aims at the settled cloud’s centre, not blindly at the origin', () => {
    for (const entry of FIXTURES) {
      const plan = buildScenePlan(entry.run)
      const { center } = plan.layout.bounds
      expect(plan.camera.target, entry.shape).toEqual(center)
      // The eye is exactly the framing distance from the point it looks at.
      expect(
        distance(plan.camera.position, plan.camera.target),
        entry.shape,
      ).toBeCloseTo(plan.camera.distance, 9)
    }
  })

  it('sits on a derived survey direction, above the horizon and off +Z', () => {
    const plan = buildScenePlan(fixture('fan-out'))
    const offset = {
      x: plan.camera.position.x - plan.camera.target.x,
      y: plan.camera.position.y - plan.camera.target.y,
      z: plan.camera.position.z - plan.camera.target.z,
    }
    // An 18° elevation puts the eye above the cloud, which is what makes a
    // force-directed layout read as a volume rather than a wall.
    expect(offset.y).toBeGreaterThan(0)
    expect(offset.z).toBeGreaterThan(0)
    expect(Math.abs(offset.x)).toBeLessThan(1e-9)
    expect(distance(offset, { x: 0, y: 0, z: 0 })).toBeCloseTo(plan.camera.distance, 9)
  })

  it('takes its framing distance and field of view from the rig', () => {
    const plan = buildScenePlan(fixture('loop'))
    expect(plan.camera.distance).toBe(plan.environment.viewDistance)
    expect(plan.camera.fov).toBe(plan.environment.fov)
    expect(plan.camera.fov).toBe(DEFAULT_FOV)
    expect(plan.camera.near).toBe(CAMERA_NEAR)
    expect(plan.camera.far).toBe(
      plan.environment.viewDistance + plan.environment.extentRadius * CAMERA_FAR_MARGIN,
    )
    expect(plan.camera.near).toBeLessThan(plan.camera.far)
  })

  it('brackets every node between the near and far planes', () => {
    for (const entry of FIXTURES) {
      const plan = buildScenePlan(entry.run)
      for (const position of nodePositions(plan)) {
        const depth = distance(plan.camera.position, position)
        expect(depth, entry.shape).toBeGreaterThan(plan.camera.near)
        expect(depth, entry.shape).toBeLessThan(plan.camera.far)
      }
    }
  })

  it('frames the cloud past the far edge of the fog band', () => {
    const plan = buildScenePlan(fixture('fan-out'))
    // Fog ends before the frustum does, so the cloud fades rather than being cut.
    expect(plan.environment.fog.far).toBeLessThan(plan.camera.far)
    expect(plan.camera.far).toBeGreaterThan(
      plan.camera.distance + plan.layout.bounds.radius,
    )
  })

  it('frames an empty scene on the origin with the rig defaults', () => {
    const environment = buildEnvironmentPlan()
    const camera = sceneCamera(environment, null)
    expect(camera.target).toEqual({ x: 0, y: 0, z: 0 })
    expect(camera.distance).toBe(DEFAULT_VIEW_DISTANCE)
    expect(camera.fov).toBe(DEFAULT_FOV)
    expect(camera.near).toBe(CAMERA_NEAR)
    expect(camera.far).toBe(
      DEFAULT_VIEW_DISTANCE + environment.extentRadius * CAMERA_FAR_MARGIN,
    )
    // A camera plan is well-formed even with nothing to frame.
    expect(Number.isFinite(camera.position.x)).toBe(true)
    expect(Number.isFinite(camera.position.y)).toBe(true)
    expect(Number.isFinite(camera.position.z)).toBe(true)
  })

  it('is a pure function of the rig plan and the bounds', () => {
    const environment = buildEnvironmentPlan(fixture('fan-out'))
    const plan = buildScenePlan(fixture('fan-out'))
    const first = sceneCamera(environment, plan.layout.bounds)
    const second = sceneCamera(environment, plan.layout.bounds)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // The bounds object is read, never kept or mutated.
    expect(first.target).toEqual(plan.layout.bounds.center)
  })
})

// ── determinism ─────────────────────────────────────────────────────────────

describe('scene plan — determinism (M3-T6)', () => {
  it('is byte-identical across calls', () => {
    const model = fixture('loop')
    const first = buildScenePlan(model)
    const second = buildScenePlan(model)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('derives everything identically whatever order the model’s arrays arrive in', () => {
    const model = fixture('handoff-chain')
    const plan = buildScenePlan(model)
    // The plan carries the run itself by reference, so the run's own arrays keep
    // whatever order they arrived in; everything the scene *derives* from those
    // arrays must be identical.
    const derived = (value: ScenePlan) => JSON.stringify({ ...value, run: undefined })
    expect(derived(buildScenePlan(scrambled(model)))).toBe(derived(plan))
    expect(derived(buildScenePlan(model))).toBe(derived(plan))
  })

  it('does not mutate the model or the plans it composes', () => {
    const model = fixture('dead-branch')
    const before = JSON.stringify(model)
    const plan = buildScenePlan(model)
    const after = JSON.stringify(plan)
    expect(JSON.stringify(model)).toBe(before)
    expect(JSON.stringify(plan)).toBe(after)
    expect(JSON.stringify(buildScenePlan(model))).toBe(after)
  })

  it('pins the shape to the run’s own seed', () => {
    const model = fixture('fan-out')
    const plan = buildScenePlan(model)
    expect(plan.seed).toBe(model.seed)
    expect(plan.layout.seed).toBe(model.seed)
  })
})

// ── degenerate runs ─────────────────────────────────────────────────────────

describe('scene plan — degenerate runs (M3-T6)', () => {
  it('composes an empty scene for an empty run', () => {
    const plan = buildScenePlan(emptyRun())
    expect(plan.counts).toEqual({
      agents: 0,
      messages: 0,
      toolCalls: 0,
      links: 0,
      nodes: 0,
      arcs: 0,
      glyphs: 0,
      elements: 0,
    })
    expect(plan.drawCalls).toBe(0)
    expect(plan.withinBudget).toBe(true)
    expect(plan.bloom).toBe(false)
    expect(plan.postProcessPasses).toBe(0)
    // Nothing to frame: the camera looks at the origin with the rig's defaults.
    expect(plan.camera.target).toEqual({ x: 0, y: 0, z: 0 })
    expect(plan.camera.distance).toBe(plan.environment.viewDistance)
  })

  it('composes one node and nothing else for a lone agent', () => {
    const plan = buildScenePlan(soloRun())
    expect(plan.counts.agents).toBe(1)
    expect(plan.counts.nodes).toBe(1)
    expect(plan.counts.arcs).toBe(0)
    expect(plan.counts.glyphs).toBe(0)
    expect(plan.counts.elements).toBe(1)
    expect(plan.drawCalls).toBe(NODE_LAYER_DRAW_CALLS)
    // No extent, so the rig enables no bloom pass (M3-T5's fix).
    expect(plan.bloom).toBe(false)
    expect(plan.postProcessPasses).toBe(0)
  })
})

// ── overrides ───────────────────────────────────────────────────────────────

describe('scene plan — overrides (M3-T6)', () => {
  it('carries per-layer style overrides into the plans it hands over', () => {
    const plan = buildScenePlan(fixture('fan-out'), {
      nodeStyle: { segments: 8 },
      arcStyle: { segments: 8, sides: 4, bulge: 0.1 },
      glyphStyle: { detail: 1 },
    })
    expect(plan.nodes.style.segments).toBe(8)
    expect(plan.arcs.style.segments).toBe(8)
    expect(plan.arcs.style.sides).toBe(4)
    expect(plan.arcs.style.bulge).toBe(0.1)
    expect(plan.glyphs.style.detail).toBe(1)
    // Overrides retune the look, not the shape.
    expect(plan.seed).toBe(fixture('fan-out').seed)
  })

  it('carries rig overrides into the camera it frames with', () => {
    const plan = buildScenePlan(fixture('loop'), {
      rig: { viewDistance: 20, fov: 40 },
    })
    expect(plan.camera.distance).toBe(20)
    expect(plan.camera.fov).toBe(40)
    expect(plan.camera.far).toBe(20 + plan.environment.extentRadius * CAMERA_FAR_MARGIN)
  })

  it('judges the scene against a supplied ceiling', () => {
    const tight = buildScenePlan(fixture('fan-out'), { ceiling: 2 })
    expect(tight.drawCalls).toBe(DRAW_CALL_CEILING)
    expect(tight.ceiling).toBe(2)
    expect(tight.withinBudget).toBe(false)
    // A nonsense ceiling falls back to the declared one rather than disabling the gate.
    const fallback = buildScenePlan(fixture('fan-out'), { ceiling: Number.NaN })
    expect(fallback.ceiling).toBe(DRAW_CALL_CEILING)
    expect(fallback.withinBudget).toBe(true)
  })
})
