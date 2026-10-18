import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES } from '../fixtures/index.ts'
import type { FixtureShape } from '../fixtures/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import { settleLayout } from '../layout/index.ts'
import { NODE_LAYER_DRAW_CALLS } from './nodes.ts'
import { ARC_LAYER_DRAW_CALLS } from './arcs.ts'
import { GLYPH_LAYER_DRAW_CALLS } from './glyphs.ts'
import { ENVIRONMENT_DRAW_CALLS } from './environment.ts'
import {
  DRAW_CALL_CEILING,
  DrawCallBudgetError,
  MAX_MESH_SITES_PER_COMPONENT,
  SCENE_LAYER_DRAW_CALLS,
  SCENE_LAYER_NAMES,
  assertDrawCallBudget,
  findMeshConstructionSites,
  layerBudget,
  measureSceneBudget,
} from './budget.ts'

/**
 * Tests for the scene draw-call budget (M3-T5).
 *
 * This is the machine gate behind the PRD's geometry budget — *"every repeated
 * element is instanced; the draw-call ceiling is a gate"*. Everything asserted
 * here is a **measurement**: the numbers come from the real layer plans, and the
 * ceiling is compared against them. Nothing about the rendered look is asserted
 * (jsdom has no GPU; the look is human-reviewed, M5-T5).
 *
 * The two halves of the gate are:
 *
 * 1. **Behaviour** — a fully populated run costs {@link DRAW_CALL_CEILING} calls,
 *    an empty one costs none, and a run forty times larger costs the same as a
 *    fixture. That last assertion is the property instancing exists for.
 * 2. **Structure** — each render-layer component declares at most one
 *    mesh-construction site ({@link findMeshConstructionSites}), so a mesh per
 *    message/agent/glyph cannot be added without failing.
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

/**
 * A synthetic run far larger than any fixture, built through the real ingest
 * path (a ring of `agents` workers, each sending `perAgent` action-bearing
 * messages to the next). Used to prove draw calls do not scale with the trace.
 */
function scaledRun(agents: number, perAgent: number): TraceModel {
  const rows: AgentMessageRow[] = []
  let id = 1
  for (let agent = 0; agent < agents; agent += 1) {
    const from = `agent_${String(agent).padStart(3, '0')}`
    const to = `agent_${String((agent + 1) % agents).padStart(3, '0')}`
    for (let index = 0; index < perAgent; index += 1) {
      rows.push({
        id,
        from_agent: from,
        to_agent: to,
        created_at: new Date(Date.parse(ISO) + id * 1000).toISOString(),
        body: JSON.stringify({ action: 'assign_task', index }),
      })
      id += 1
    }
  }
  return normalizeTrace(parseAgentMessagesExport(rows, { label: 'scaled' }))
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

// ── the declared costs ──────────────────────────────────────────────────────

describe('scene budget — the declared ceiling (M3-T5)', () => {
  it('joins the layers’ own constants instead of restating them', () => {
    expect(SCENE_LAYER_NAMES).toEqual(['nodes', 'arcs', 'glyphs', 'environment'])
    expect(SCENE_LAYER_DRAW_CALLS).toEqual({
      nodes: NODE_LAYER_DRAW_CALLS,
      arcs: ARC_LAYER_DRAW_CALLS,
      glyphs: GLYPH_LAYER_DRAW_CALLS,
      environment: ENVIRONMENT_DRAW_CALLS,
    })
    // The scene layer's three drawable layers plus a rig that draws nothing.
    expect(NODE_LAYER_DRAW_CALLS).toBe(1)
    expect(ARC_LAYER_DRAW_CALLS).toBe(1)
    expect(GLYPH_LAYER_DRAW_CALLS).toBe(1)
    expect(ENVIRONMENT_DRAW_CALLS).toBe(0)
    expect(DRAW_CALL_CEILING).toBe(
      NODE_LAYER_DRAW_CALLS +
        ARC_LAYER_DRAW_CALLS +
        GLYPH_LAYER_DRAW_CALLS +
        ENVIRONMENT_DRAW_CALLS,
    )
    expect(DRAW_CALL_CEILING).toBe(3)
  })

  it('allows exactly one drawable object per render-layer component', () => {
    expect(MAX_MESH_SITES_PER_COMPONENT).toBe(1)
  })
})

// ── measured behaviour ──────────────────────────────────────────────────────

describe('scene budget — measured per fixture (M3-T5)', () => {
  it('measures one draw call per active layer on every fixture', () => {
    for (const entry of Object.values(FIXTURES)) {
      const budget = measureSceneBudget(entry.run)
      expect(budget.drawCalls, entry.shape).toBe(DRAW_CALL_CEILING)
      expect(budget.withinBudget, entry.shape).toBe(true)
      expect(budget.headroom, entry.shape).toBe(0)
      expect(budget.ceiling, entry.shape).toBe(DRAW_CALL_CEILING)

      for (const layer of budget.layers) {
        expect(layer.drawCalls, `${entry.shape} ${layer.layer}`).toBe(
          layer.active ? layer.maxDrawCalls : 0,
        )
      }
      // All four fixtures use all three drawable layers.
      expect(
        budget.layers.filter((layer) => layer.active).map((layer) => layer.layer),
        entry.shape,
      ).toEqual(['nodes', 'arcs', 'glyphs'])
    }
  })

  it('reads each layer’s number from that layer’s own plan', () => {
    for (const entry of Object.values(FIXTURES)) {
      const budget = measureSceneBudget(entry.run)
      expect(layerBudget(budget, 'nodes')?.drawCalls, entry.shape).toBe(
        budget.plans.nodes.drawCalls,
      )
      expect(layerBudget(budget, 'arcs')?.drawCalls, entry.shape).toBe(
        budget.plans.arcs.drawCalls,
      )
      expect(layerBudget(budget, 'glyphs')?.drawCalls, entry.shape).toBe(
        budget.plans.glyphs.drawCalls,
      )
      expect(layerBudget(budget, 'environment')?.drawCalls, entry.shape).toBe(
        budget.plans.environment.drawCalls,
      )
      // ...and each of those plans is the layer's declared single call.
      expect(budget.plans.nodes.drawCalls, entry.shape).toBe(NODE_LAYER_DRAW_CALLS)
      expect(budget.plans.arcs.drawCalls, entry.shape).toBe(ARC_LAYER_DRAW_CALLS)
      expect(budget.plans.glyphs.drawCalls, entry.shape).toBe(GLYPH_LAYER_DRAW_CALLS)
      expect(budget.plans.environment.drawCalls, entry.shape).toBe(
        ENVIRONMENT_DRAW_CALLS,
      )
    }
  })

  it('counts the elements behind those calls from the trace', () => {
    for (const entry of Object.values(FIXTURES)) {
      const budget = measureSceneBudget(entry.run)
      const nodes = budget.plans.nodes.count
      const arcs = budget.plans.arcs.count
      const glyphs = budget.plans.glyphs.count
      expect(nodes, entry.shape).toBe(entry.run.agents.length)
      expect(arcs, entry.shape).toBeGreaterThan(0)
      expect(glyphs, entry.shape).toBe(entry.run.toolCalls.length)
      expect(budget.elements, entry.shape).toBe(nodes + arcs + glyphs)
      expect(budget.elements, entry.shape).toBeGreaterThan(budget.drawCalls)
    }
  })

  it('does not grow with the size of the run', () => {
    const small = measureSceneBudget(fixture('fan-out'))
    const large = measureSceneBudget(scaledRun(40, 12))

    // Forty agents, 480 messages and 480 tool calls...
    expect(large.plans.nodes.count).toBe(40)
    expect(large.plans.glyphs.count).toBe(480)
    expect(large.plans.arcs.count).toBe(40)
    expect(large.elements).toBe(560)
    expect(large.elements).toBeGreaterThan(small.elements * 20)

    // ...still three draw calls. This is the property the budget exists for.
    expect(large.drawCalls).toBe(small.drawCalls)
    expect(large.drawCalls).toBe(DRAW_CALL_CEILING)
    expect(large.headroom).toBe(0)
    expect(large.withinBudget).toBe(true)
  })

  it('is deterministic and independent of array order', () => {
    const model = fixture('loop')
    const first = measureSceneBudget(model)
    const second = measureSceneBudget(model)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(JSON.stringify(measureSceneBudget(scrambled(model)))).toBe(
      JSON.stringify(first),
    )
  })

  it('settles the layout once and hands it to every layer', () => {
    const model = fixture('handoff-chain')
    const budget = measureSceneBudget(model)
    const settled = settleLayout(model)

    // One shape object shared by all three scene plans.
    expect(budget.plans.nodes.layout).toBe(budget.plans.arcs.layout)
    expect(budget.plans.arcs.layout).toBe(budget.plans.glyphs.layout)
    expect(JSON.stringify(budget.plans.nodes.layout)).toBe(
      JSON.stringify(settled.layout),
    )
    for (const plan of [budget.plans.nodes, budget.plans.arcs, budget.plans.glyphs]) {
      expect(plan.iterations).toBe(budget.iterations)
      expect(plan.seed).toBe(budget.seed)
      expect(plan.converged).toBe(budget.converged)
    }
    expect(budget.iterations).toBe(settled.iterations)
    expect(budget.converged).toBe(true)
    expect(budget.seed).toBe(settled.layout.seed)
    // The rig was framed from that same layout rather than settling again.
    expect(budget.plans.environment.seed).toBe(budget.seed)
    expect(budget.plans.environment.settlement).toBeNull()
  })

  it('reports post-processing separately from the geometry ceiling', () => {
    const withRun = measureSceneBudget(fixture('dead-branch'))
    expect(withRun.postProcessPasses).toBe(1)
    expect(withRun.drawCalls).toBe(DRAW_CALL_CEILING)
    // The pass is real, and it is deliberately NOT part of the ceiling.
    expect(withRun.drawCalls + withRun.postProcessPasses).toBeGreaterThan(
      withRun.ceiling,
    )
    expect(measureSceneBudget(emptyRun()).postProcessPasses).toBe(0)
  })
})

// ── the gate ────────────────────────────────────────────────────────────────

describe('scene budget — the enforced gate (M3-T5)', () => {
  it('passes a scene measured at the ceiling', () => {
    const budget = measureSceneBudget(fixture('loop'))
    expect(() => assertDrawCallBudget(budget)).not.toThrow()
  })

  it('throws a typed error naming the layers when a scene is over budget', () => {
    const tightened = measureSceneBudget(fixture('loop'), { ceiling: 2 })
    expect(tightened.drawCalls).toBe(3)
    expect(tightened.withinBudget).toBe(false)
    expect(tightened.headroom).toBe(-1)
    expect(() => assertDrawCallBudget(tightened)).toThrow(DrawCallBudgetError)
    expect(() => assertDrawCallBudget(tightened)).toThrow(/3 > 2/)
    expect(() => assertDrawCallBudget(tightened)).toThrow(/nodes: 1\/1/)

    const error = new DrawCallBudgetError('draw-call budget exceeded')
    expect(error.name).toBe('DrawCallBudgetError')
    expect(error).toBeInstanceOf(Error)
  })

  it('sanitizes a nonsense ceiling back to the declared one', () => {
    const model = fixture('fan-out')
    for (const ceiling of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const budget = measureSceneBudget(model, { ceiling })
      expect(budget.ceiling).toBe(DRAW_CALL_CEILING)
      expect(budget.withinBudget).toBe(true)
    }
    // A usable override is floored, not rounded away.
    expect(measureSceneBudget(model, { ceiling: 2.9 }).ceiling).toBe(2)
  })
})

// ── degenerate runs ─────────────────────────────────────────────────────────

describe('scene budget — degenerate runs (M3-T5)', () => {
  it('measures no draw calls and no elements for an empty run', () => {
    const budget = measureSceneBudget(emptyRun())
    expect(budget.drawCalls).toBe(0)
    expect(budget.elements).toBe(0)
    expect(budget.headroom).toBe(DRAW_CALL_CEILING)
    expect(budget.withinBudget).toBe(true)
    for (const layer of budget.layers) {
      expect(layer.drawCalls, layer.layer).toBe(0)
      expect(layer.active, layer.layer).toBe(false)
    }
    // No extent, no bloom: the rig must not buy a full-screen pass for an empty
    // scene (the defect the M3-T5 measurement surfaced — a reused empty layout
    // used to switch bloom on).
    expect(budget.plans.environment.bloom.enabled).toBe(false)
    expect(budget.postProcessPasses).toBe(0)
    expect(() => assertDrawCallBudget(budget)).not.toThrow()
  })

  it('measures one call for an agent that has nothing to say', () => {
    const budget = measureSceneBudget(soloRun())
    expect(budget.plans.nodes.count).toBe(1)
    expect(budget.plans.arcs.count).toBe(0)
    expect(budget.plans.glyphs.count).toBe(0)
    expect(budget.drawCalls).toBe(NODE_LAYER_DRAW_CALLS)
    expect(layerBudget(budget, 'nodes')?.active).toBe(true)
    expect(layerBudget(budget, 'arcs')?.active).toBe(false)
    expect(layerBudget(budget, 'glyphs')?.active).toBe(false)
    // A lone node has no extent to bloom, so no post-processing pass either.
    expect(budget.postProcessPasses).toBe(0)
  })
})

// ── options pass-through ────────────────────────────────────────────────────

describe('scene budget — measures the plans it is given (M3-T5)', () => {
  it('carries per-layer style overrides into the measured plans', () => {
    const budget = measureSceneBudget(fixture('fan-out'), {
      nodeStyle: { segments: 8 },
      arcStyle: { segments: 4, sides: 5 },
      glyphStyle: { sizeRatio: 0.2 },
      rig: { fov: 40 },
    })
    expect(budget.plans.nodes.style.segments).toBe(8)
    expect(budget.plans.arcs.style.segments).toBe(4)
    expect(budget.plans.arcs.style.sides).toBe(5)
    expect(budget.plans.glyphs.style.sizeRatio).toBe(0.2)
    expect(budget.plans.environment.fov).toBe(40)
    // Retuning geometry does not buy a draw call.
    expect(budget.drawCalls).toBe(DRAW_CALL_CEILING)
  })

  it('looks up a layer by name and returns null for an unknown one', () => {
    const budget = measureSceneBudget(fixture('fan-out'))
    expect(layerBudget(budget, 'glyphs')?.layer).toBe('glyphs')
    expect(layerBudget(budget, 'nope' as never)).toBeNull()
  })
})

// ── structural gate: no per-element mesh ────────────────────────────────────

describe('scene budget — no per-element mesh (M3-T5)', () => {
  it('finds JSX and constructor mesh sites, in source order', () => {
    expect(findMeshConstructionSites('<mesh geometry={geometry} />')).toEqual([
      { kind: 'jsx', tag: 'mesh', line: 1 },
    ])
    expect(
      findMeshConstructionSites('<instancedMesh args={[undefined, undefined, n]} />'),
    ).toEqual([{ kind: 'jsx', tag: 'instancedMesh', line: 1 }])
    expect(
      findMeshConstructionSites('const mesh = new THREE.InstancedMesh(g, m, count)'),
    ).toEqual([{ kind: 'constructor', tag: 'InstancedMesh', line: 1 }])
    expect(findMeshConstructionSites('const mesh = new Mesh(g, m)')).toEqual([
      { kind: 'constructor', tag: 'Mesh', line: 1 },
    ])

    const both = '<mesh />\nconst m = new THREE.Mesh(g, m)'
    expect(findMeshConstructionSites(both).map((site) => site.kind)).toEqual([
      'jsx',
      'constructor',
    ])
  })

  it('ignores comments and material tags', () => {
    const source = [
      '// <mesh geometry={geometry} />',
      '/* const mesh = new THREE.Mesh(g, m) */',
      '<meshBasicMaterial color="#ffffff" />',
      '<meshStandardMaterial color="white" />',
      'const keep = 1',
    ].join('\n')
    expect(findMeshConstructionSites(source)).toEqual([])
  })

  it('flags a mesh built per message — the rule is not vacuous', () => {
    // The shape a "one mesh per message" implementation would take. It declares
    // a different number of *sites*, which is what the gate counts.
    const perMessage = [
      'const arcs = messages.map((message) => (',
      '  <mesh key={message.id}>',
      '    <sphereGeometry />',
      '  </mesh>',
      '))',
    ].join('\n')
    const sites = findMeshConstructionSites(perMessage)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ kind: 'jsx', tag: 'mesh' })
    // A batched version has the same one site — but it draws one mesh for the
    // whole population, which is exactly what the plan counts measure.
    expect(
      findMeshConstructionSites(
        '<instancedMesh args={[undefined, undefined, count]} />',
      ),
    ).toHaveLength(1)
  })

  it('every render-layer component declares at most one drawable object', () => {
    const root = findRepoRoot(process.cwd())
    const components = [
      'src/scene/AgentNodeLayer.tsx',
      'src/scene/MessageArcLayer.tsx',
      'src/scene/GlyphLayer.tsx',
      'src/scene/EnvironmentRig.tsx',
      // The shell mounts layers; it must not create geometry of its own either.
      'src/Viewport.tsx',
    ]
    let total = 0
    for (const relative of components) {
      const sites = findMeshConstructionSites(
        readFileSync(resolve(root, relative), 'utf8'),
      )
      expect(sites.length, `${relative}: ${JSON.stringify(sites)}`).toBeLessThanOrEqual(
        MAX_MESH_SITES_PER_COMPONENT,
      )
      total += sites.length
    }
    // Three drawable objects for the whole scene: one per instanced/batched
    // layer. Nothing else in the render path creates a mesh.
    expect(total).toBe(DRAW_CALL_CEILING)
  })
})

// ── purity guard ────────────────────────────────────────────────────────────

/** Walk up from cwd until the package manifest is found. */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package.json not found above cwd')
    dir = parent
  }
}

describe('scene budget — purity (M3-T5)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/scene/budget.ts'),
    'utf8',
  )
    // Drop comments so the module's own prose cannot trip the scan.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
  })

  it('is a data-layer module — no three.js or DOM', () => {
    expect(source).not.toMatch(/from ['"]three['"]/)
    expect(source).not.toMatch(/@react-three/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })
})
