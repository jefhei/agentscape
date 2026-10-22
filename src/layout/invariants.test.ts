import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import type { FixtureShape, TraceFixture } from '../fixtures/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  InvariantError,
  assertInvariants,
  checkAttributeInvariants,
  checkEdgeInvariants,
  checkLayoutInvariants,
  checkSceneInvariants,
  deriveEdgeModel,
  findHandAuthoredCoordinates,
  layoutTrace,
  mapTraceAttributes,
  settleLayout,
} from './index.ts'
import type {
  EdgeModel,
  ForceLayout,
  InvariantViolation,
  TraceAttributes,
} from './index.ts'

/**
 * Cross-fixture invariant harness tests (M2-T5).
 *
 * The M2 exit criteria are "same trace → byte-identical layout; layout settles
 * without jitter; every node position and visual attribute derives from trace
 * data", and the machine gate adds "no hand-authored coordinates anywhere in
 * `src/`". These tests run the {@link checkLayoutInvariants} /
 * {@link checkAttributeInvariants} / {@link checkEdgeInvariants} harness over
 * **every** reference fixture — the whole point of M2-T5 — and then prove the
 * harness is not vacuous by feeding it deliberately broken layouts, attribute
 * maps and edge models and asserting it names the right rule.
 *
 * No visuals are asserted: jsdom has no GPU, and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

// ── helpers ─────────────────────────────────────────────────────────────────

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: Parameters<typeof parseAgentMessagesExport>[0]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

/** Violation codes, for compact assertions. */
function codes(violations: readonly InvariantViolation[]): string[] {
  return violations.map((violation) => violation.code)
}

/** A deep clone (tests mutate their own copy; NaN is set after cloning). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** The default fixed-budget layout for a fixture shape. */
function layoutOf(shape: FixtureShape): ForceLayout {
  return layoutTrace(buildFixture(shape).run)
}

/** The settled layout, mapped attributes and derived edges for a fixture. */
interface Scene {
  fixture: TraceFixture
  layout: ForceLayout
  attributes: TraceAttributes
  edges: EdgeModel
}

const SCENES: Scene[] = FIXTURES.map((fixture) => {
  const { layout } = settleLayout(fixture.run)
  return {
    fixture,
    layout,
    attributes: mapTraceAttributes(fixture.run),
    edges: deriveEdgeModel(fixture.run),
  }
})

/** A serializable snapshot of the whole M2 derivation for one model. */
function snapshot(model: TraceModel): string {
  const { layout } = settleLayout(model)
  return JSON.stringify({
    layout,
    attributes: mapTraceAttributes(model),
    edges: deriveEdgeModel(model),
  })
}

// ── layout invariants ───────────────────────────────────────────────────────

describe('checkLayoutInvariants (M2-T5)', () => {
  it('is a data-layer checker returning violations (compile-checked)', () => {
    const violations = checkLayoutInvariants(
      buildFixture('fan-out').run,
      layoutOf('fan-out'),
    )
    expectTypeOf(violations).toEqualTypeOf<InvariantViolation[]>()
  })

  it('holds for the fixed-budget layout on every fixture', () => {
    for (const fixture of FIXTURES) {
      expect(
        checkLayoutInvariants(fixture.run, layoutTrace(fixture.run)),
        fixture.shape,
      ).toEqual([])
    }
  })

  it('holds for the settled layout on every fixture', () => {
    for (const scene of SCENES) {
      expect(
        checkLayoutInvariants(scene.fixture.run, scene.layout),
        scene.fixture.shape,
      ).toEqual([])
    }
  })

  it('holds for a lone agent fixed at the origin', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(checkLayoutInvariants(model, layoutTrace(model))).toEqual([])
  })

  it('catches a coincident pair (repulsion should have separated them)', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(layoutTrace(model))
    broken.nodes[1].position = { ...broken.nodes[0].position }
    expect(codes(checkLayoutInvariants(model, broken))).toContain(
      'layout-nodes-distinct',
    )
  })

  it('catches a non-finite position', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(layoutTrace(model))
    broken.nodes[0].position.x = Number.NaN
    expect(codes(checkLayoutInvariants(model, broken))).toContain('layout-node-finite')
  })

  it('catches a seed that is not the model seed', () => {
    const model = buildFixture('fan-out').run
    const layout = layoutTrace(model)
    const broken: ForceLayout = { ...layout, seed: layout.seed + 1 }
    expect(codes(checkLayoutInvariants(model, broken))).toContain('layout-seed')
  })

  it('catches a link list that was not derived from the trace', () => {
    const model = buildFixture('fan-out').run
    const broken: ForceLayout = { ...layoutTrace(model), links: [] }
    expect(codes(checkLayoutInvariants(model, broken))).toContain(
      'layout-links-derived',
    )
  })

  it('catches bounds that do not enclose the cloud', () => {
    const model = buildFixture('fan-out').run
    const layout = layoutTrace(model)
    const broken: ForceLayout = {
      ...layout,
      bounds: {
        ...layout.bounds,
        max: {
          x: layout.bounds.min.x - 1,
          y: layout.bounds.min.y - 1,
          z: layout.bounds.min.z - 1,
        },
      },
    }
    expect(codes(checkLayoutInvariants(model, broken))).toContain(
      'layout-bounds-enclose',
    )
  })

  it('catches an extra, un-backable node', () => {
    const model = buildFixture('fan-out').run
    const layout = layoutTrace(model)
    const broken: ForceLayout = {
      ...layout,
      nodes: [...layout.nodes, { agentId: 'a_ghost', position: { x: 9, y: 9, z: 9 } }],
    }
    expect(codes(checkLayoutInvariants(model, broken))).toContain('layout-node-count')
  })

  it('catches a relaxed degenerate run', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    const broken: ForceLayout = { ...layoutTrace(model), iterations: 5 }
    expect(codes(checkLayoutInvariants(model, broken))).toContain(
      'layout-iterations-degenerate',
    )
  })
})

// ── attribute invariants ────────────────────────────────────────────────────

describe('checkAttributeInvariants (M2-T5)', () => {
  it('holds for every fixture', () => {
    for (const scene of SCENES) {
      expect(
        checkAttributeInvariants(scene.fixture.run, scene.attributes),
        scene.fixture.shape,
      ).toEqual([])
    }
  })

  it('holds for an empty run', () => {
    const model = modelFrom([])
    expect(checkAttributeInvariants(model, mapTraceAttributes(model))).toEqual([])
  })

  it('catches an intensity outside [0, 1]', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(mapTraceAttributes(model))
    broken.nodes[0].intensity = 1.5
    expect(codes(checkAttributeInvariants(model, broken))).toContain(
      'attr-node-intensity-range',
    )
  })

  it('catches an activity figure that disagrees with the model', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(mapTraceAttributes(model))
    broken.nodes[0].activity.messagesSent += 1
    expect(codes(checkAttributeInvariants(model, broken))).toContain(
      'attr-activity-sent',
    )
  })

  it('catches a total that does not sum its parts', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(mapTraceAttributes(model))
    broken.nodes[0].activity.total = 0
    expect(codes(checkAttributeInvariants(model, broken))).toContain(
      'attr-activity-total',
    )
  })

  it('catches arcs that do not mirror the layout links', () => {
    const model = buildFixture('fan-out').run
    const broken: TraceAttributes = { ...mapTraceAttributes(model), links: [] }
    expect(codes(checkAttributeInvariants(model, broken))).toContain(
      'attr-links-derived',
    )
  })

  it('catches a recorded span that is not the true span', () => {
    const model = buildFixture('fan-out').run
    const broken: TraceAttributes = {
      ...mapTraceAttributes(model),
      activityRange: { min: 0, max: 0 },
    }
    expect(codes(checkAttributeInvariants(model, broken))).toContain(
      'attr-activity-range',
    )
  })
})

// ── edge invariants ─────────────────────────────────────────────────────────

describe('checkEdgeInvariants (M2-T5)', () => {
  it('holds for every fixture', () => {
    for (const scene of SCENES) {
      expect(
        checkEdgeInvariants(scene.fixture.run, scene.edges),
        scene.fixture.shape,
      ).toEqual([])
    }
  })

  it('holds for an empty run', () => {
    const model = modelFrom([])
    expect(checkEdgeInvariants(model, deriveEdgeModel(model))).toEqual([])
  })

  it('catches a bogus parent', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(deriveEdgeModel(model))
    broken.agents[0].parentId = 'a_ghost'
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-parent-real')
  })

  it('catches a fan-out degree that disagrees with its children', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(deriveEdgeModel(model))
    broken.agents[1].fanOut += 1
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-fanout')
  })

  it('catches a maxFanOut that is not the true maximum', () => {
    const model = buildFixture('fan-out').run
    const broken: EdgeModel = { ...deriveEdgeModel(model), maxFanOut: 99 }
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-max-fanout')
  })

  it('catches a byKind group that no longer partitions the edges', () => {
    const model = buildFixture('fan-out').run
    const edges = deriveEdgeModel(model)
    const broken: EdgeModel = {
      ...edges,
      byKind: {
        ...edges.byKind,
        spawn: edges.byKind.spawn.slice(0, edges.byKind.spawn.length - 1),
      },
    }
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-partition')
  })

  it('catches a weight that disagrees with its message ids', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(deriveEdgeModel(model))
    broken.edges[0].weight = 99
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-weight')
  })

  it('catches a role that the classification rule does not yield', () => {
    const model = buildFixture('fan-out').run
    const broken = clone(deriveEdgeModel(model))
    broken.agents[1].role = 'coordinator'
    expect(codes(checkEdgeInvariants(model, broken))).toContain('edge-role')
  })
})

// ── the whole pipeline ──────────────────────────────────────────────────────

describe('checkSceneInvariants (M2-T5)', () => {
  it('holds end-to-end for every fixture', () => {
    for (const fixture of FIXTURES) {
      expect(checkSceneInvariants(fixture.run), fixture.shape).toEqual([])
    }
  })

  it('holds for degenerate runs (empty, lone agent)', () => {
    expect(checkSceneInvariants(modelFrom([]))).toEqual([])
    const lone = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(checkSceneInvariants(lone)).toEqual([])
  })

  it('is byte-identical across two full M2 derivations (determinism gate)', () => {
    for (const fixture of FIXTURES) {
      expect(snapshot(fixture.run), fixture.shape).toBe(snapshot(fixture.run))
    }
  })

  it('is independent of the order of the model arrays', () => {
    for (const fixture of FIXTURES) {
      const run = fixture.run
      const scrambled: TraceModel = {
        ...run,
        agents: [...run.agents].reverse(),
        messages: [...run.messages].reverse(),
        toolCalls: [...run.toolCalls].reverse(),
      }
      expect(snapshot(scrambled), fixture.shape).toBe(snapshot(run))
    }
  })

  it('assertInvariants is a no-op on a clean report', () => {
    expect(() => assertInvariants([])).not.toThrow()
    expect(() =>
      assertInvariants(checkSceneInvariants(buildFixture('loop').run)),
    ).not.toThrow()
  })

  it('assertInvariants throws an InvariantError carrying the violations', () => {
    const violations = checkLayoutInvariants(buildFixture('loop').run, {
      ...layoutTrace(buildFixture('loop').run),
      seed: -1,
    })
    expect(violations.length).toBeGreaterThan(0)
    let caught: unknown
    try {
      assertInvariants(violations)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvariantError)
    expect((caught as InvariantError).violations).toEqual(violations)
    expect((caught as InvariantError).message).toContain('layout-seed')
  })
})

// ── hand-authored coordinate scan (machine gate) ────────────────────────────

describe('findHandAuthoredCoordinates (M2-T5)', () => {
  it('flags a hand-authored position array', () => {
    const source = "const node = { agentId: 'a', position: [1.2, 0, -3] }"
    expect(findHandAuthoredCoordinates(source)).not.toEqual([])
  })

  it('flags a coordinate constructor', () => {
    expect(findHandAuthoredCoordinates('const p = new Vector3(1, 2, 3)')).not.toEqual(
      [],
    )
  })

  it('flags a non-zero coordinate triple', () => {
    expect(
      findHandAuthoredCoordinates('const p = { x: 1.5, y: -2, z: 0.5 }'),
    ).not.toEqual([])
  })

  it('allows a symbolically-zero origin sentinel', () => {
    expect(findHandAuthoredCoordinates('const origin = { x: 0, y: 0, z: 0 }')).toEqual(
      [],
    )
  })

  it('ignores coordinates inside comments', () => {
    const source =
      '// position: [1, 2, 3]\n/* const p = new Vector3(1, 2, 3) */\nconst keep = 1'
    expect(findHandAuthoredCoordinates(source)).toEqual([])
    expect(findHandAuthoredCoordinates('const keep = 1')).toEqual([])
  })

  it('finds no hand-authored coordinates in the pure data layer', () => {
    const root = findRepoRoot(process.cwd())
    // The pure half of src/ — no coordinates may be authored here. The render
    // layer (App.tsx / Viewport.tsx) legitimately configures a *camera*, so it
    // is out of scope for this gate.
    const dataLayer = [
      'src/types/trace.ts',
      'src/adapter/agentMessages.ts',
      'src/model/traceModel.ts',
      'src/fixtures/traceFixtures.ts',
      'src/timeline/timeline.ts',
      'src/layout/forceLayout.ts',
      'src/layout/settlement.ts',
      'src/layout/attributes.ts',
      'src/layout/edges.ts',
      'src/layout/invariants.ts',
      // The scene layer's pure half (M3-T1): the node plan composes positions
      // from the layout and must author none of its own either.
      'src/scene/nodes.ts',
      // The scene layer's arc half (M3-T2): the arc plan sweeps tubes along the
      // settled positions, and the shader module carries no coordinates at all.
      'src/scene/arcs.ts',
      'src/scene/arcShader.ts',
      // The scene layer's glyph half (M3-T3): every glyph orbits the settled
      // position of the agent that made the call, so it authors none of its own.
      'src/scene/glyphs.ts',
      // The scene layer's rig (M3-T4): the light offsets and the fog band are
      // derived from the settled cloud's extent (spherical angles, never a
      // literal triple), and the calibration emits colour, not position.
      'src/scene/environment.ts',
      'src/scene/color.ts',
      'src/scene/toneMapping.ts',
      // The draw-call budget (M3-T5) measures the plans above; it composes no
      // geometry of its own, so it must author no coordinates either.
      'src/scene/budget.ts',
      // The whole-scene plan (M3-T6) composes those plans and frames the cloud
      // with the rig's own distance: the camera direction comes from spherical
      // angles and the target from the settled bounds' centre, so — like the
      // rig — it carries no hand-placed coordinate.
      'src/scene/scenePlan.ts',
      // The playback transport (M4-T1) chooses *when*, never *where*: it reads
      // the run's time axis and emits no position at all.
      'src/playback/playback.ts',
      // The reveal (M4-T1) scales magnitudes the scene plan already derived —
      // one glow factor per node, one intensity per arc — and places nothing.
      'src/scene/reveal.ts',
      // The camera layer (M4-T2): the orbit model's eye position is the settled
      // target plus a spherical direction times the dolly distance — it authors
      // no coordinate of its own, and it is pure data (no three.js, no DOM).
      'src/camera/orbit.ts',
      // The fly camera (M4-T3) is seeded from a pose the mode switch hands over and
      // then moved by its own arithmetic: the eye is the state, so it places nothing
      // by hand either — and the look direction comes from `directionFromAngles`.
      'src/camera/fly.ts',
      // The mode vocabulary (M4-T3) is a leaf: two names, two labels, one hint.
      'src/camera/modes.ts',
      // The active-mode seam (M4-T3) only dispatches to the two pose rules above;
      // it composes no geometry of its own.
      'src/camera/cameraState.ts',
    ]
    for (const relative of dataLayer) {
      const source = readFileSync(resolve(root, relative), 'utf8')
      expect(findHandAuthoredCoordinates(source), relative).toEqual([])
    }
  })
})

// ── purity guard ──────────────────────────────────────────────────────────

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

describe('invariants — purity (M2-T5)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/layout/invariants.ts'),
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

  it('leans on the natural id comparator rather than a lexical sort', () => {
    expect(source).toMatch(/compareModelIds/)
  })
})
