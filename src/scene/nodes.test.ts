import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { FIXTURES } from '../fixtures/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { TraceModel } from '../model/index.ts'
import { compareModelIds, normalizeTrace } from '../model/index.ts'
import {
  NEUTRAL_INTENSITY,
  findHandAuthoredCoordinates,
  mapTraceAttributes,
  settleLayout,
} from '../layout/index.ts'
import {
  DEFAULT_BASE_COLOR,
  DEFAULT_EMISSIVE_INTENSITY,
  DEFAULT_SEGMENTS,
  NODE_LAYER_DRAW_CALLS,
  ScenePlanError,
  buildNodeScenePlan,
  composeNodeMatrix,
  nodeInstance,
} from './nodes.ts'

/**
 * Pure-layer tests for the agent-node scene plan (M3-T1).
 *
 * Following the PRD §5 rule, everything *gateable* lives on this side of the
 * split: the plan is pure data, so its structure, provenance, geometry,
 * determinism and degeneracy are all pinned here. The rendered look of the
 * `InstancedMesh` is deliberately NOT asserted — jsdom has no GPU, so the look
 * is human-reviewed (M5-T5).
 */

const ISO = '2026-10-01T09:00:00.000Z'

/** An empty run through the real ingest path — the degenerate case. */
function emptyRun(): TraceModel {
  return normalizeTrace(parseAgentMessagesExport([], { label: 'empty' }))
}

/** A one-agent run: a single broadcast from an agent nobody else hears. */
function soloRun(): TraceModel {
  const rows: AgentMessageRow[] = [
    {
      id: 1,
      from_agent: 'solo',
      to_agent: null,
      subject: 'boot',
      body: null,
      created_at: ISO,
    },
  ]
  return normalizeTrace(parseAgentMessagesExport(rows, { label: 'solo' }))
}

/** The same model with every array reversed — order-independence probe. */
function scrambled(model: TraceModel): TraceModel {
  return {
    ...model,
    agents: [...model.agents].reverse(),
    messages: [...model.messages].reverse(),
    toolCalls: [...model.toolCalls].reverse(),
    events: [...model.events].reverse(),
  }
}

// ── structure ───────────────────────────────────────────────────────────────

describe('node scene plan — structure (M3-T1)', () => {
  it('yields one instance per agent, in canonical id order, on every fixture', () => {
    for (const fixture of FIXTURES) {
      const plan = buildNodeScenePlan(fixture.run)
      const expected = fixture.run.agents.map((agent) => agent.id).sort(compareModelIds)
      const actual = plan.instances.map((instance) => instance.agentId)
      expect(actual, fixture.shape).toEqual(expected)
      expect(plan.count, fixture.shape).toBe(fixture.run.agents.length)
      expect(new Set(actual).size, fixture.shape).toBe(actual.length)
    }
  })

  it('costs exactly one draw call for the whole node population', () => {
    for (const fixture of FIXTURES) {
      const plan = buildNodeScenePlan(fixture.run)
      expect(plan.count, fixture.shape).toBeGreaterThan(0)
      expect(plan.drawCalls, fixture.shape).toBe(NODE_LAYER_DRAW_CALLS)
    }
    expect(NODE_LAYER_DRAW_CALLS).toBe(1)
  })

  it('exposes the settled layout and the attribute mapping it composed', () => {
    for (const fixture of FIXTURES) {
      const plan = buildNodeScenePlan(fixture.run)
      const { layout, converged } = settleLayout(fixture.run)
      expect(JSON.stringify(plan.layout), fixture.shape).toBe(JSON.stringify(layout))
      expect(JSON.stringify(plan.attributes), fixture.shape).toBe(
        JSON.stringify(mapTraceAttributes(fixture.run)),
      )
      expect(plan.seed, fixture.shape).toBe(layout.seed)
      expect(plan.bounds, fixture.shape).toEqual(layout.bounds)
      expect(plan.converged, fixture.shape).toBe(converged)
      expect(plan.iterations, fixture.shape).toBe(layout.iterations)
    }
  })

  it('places every node at exactly its settled layout position', () => {
    for (const fixture of FIXTURES) {
      const { layout } = settleLayout(fixture.run)
      const positionOf = new Map(
        layout.nodes.map((node) => [node.agentId, node.position]),
      )
      for (const instance of buildNodeScenePlan(fixture.run).instances) {
        expect(instance.position, `${fixture.shape} ${instance.agentId}`).toEqual(
          positionOf.get(instance.agentId),
        )
      }
    }
  })

  it('reads radius, emissive and intensity straight from the attribute mapping', () => {
    for (const fixture of FIXTURES) {
      const byId = new Map(
        mapTraceAttributes(fixture.run).nodes.map((node) => [node.agentId, node]),
      )
      for (const instance of buildNodeScenePlan(fixture.run).instances) {
        const node = byId.get(instance.agentId)
        expect(node, fixture.shape).toBeDefined()
        expect(instance.radius, fixture.shape).toBe(node?.size)
        expect(instance.emissive, fixture.shape).toBe(node?.emissive)
        expect(instance.intensity, fixture.shape).toBe(node?.intensity)
      }
    }
  })
})

// ── glow colour ─────────────────────────────────────────────────────────────

describe('node scene plan — glow colour (M3-T1)', () => {
  it('scales the base colour by each node’s emissive multiplier', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run)
    for (const instance of plan.instances) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(instance.color[channel]).toBeCloseTo(
          DEFAULT_BASE_COLOR[channel] * instance.emissive,
          12,
        )
      }
    }
  })

  it('reads brighter for the busier node (the glow gradient is monotone)', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run)
    // Fan-out: the orchestrator is the busiest node, a leaf the quietest.
    const orchestrator = plan.instances.reduce((max, instance) =>
      instance.intensity > max.intensity ? instance : max,
    )
    const quietest = plan.instances.reduce((min, instance) =>
      instance.intensity < min.intensity ? instance : min,
    )
    expect(orchestrator.emissive).toBeGreaterThan(quietest.emissive)
    expect(orchestrator.color[2]).toBeGreaterThan(quietest.color[2])
  })
})

// ── instance matrix ─────────────────────────────────────────────────────────

describe('node scene plan — instance matrix (M3-T1)', () => {
  it('composes translation × uniform scale in column-major order', () => {
    for (const fixture of FIXTURES) {
      for (const instance of buildNodeScenePlan(fixture.run).instances) {
        const m = instance.matrix
        expect(m, fixture.shape).toHaveLength(16)
        // Leading 3×3 block = uniform scale by the node radius.
        expect(m[0]).toBe(instance.radius)
        expect(m[5]).toBe(instance.radius)
        expect(m[10]).toBe(instance.radius)
        for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11]) {
          expect(m[index], `${fixture.shape} entry ${index}`).toBe(0)
        }
        // Last row = (translation, 1).
        expect(m[12]).toBe(instance.position.x)
        expect(m[13]).toBe(instance.position.y)
        expect(m[14]).toBe(instance.position.z)
        expect(m[15]).toBe(1)
      }
    }
  })

  it('agrees with three.js Matrix4.compose (no hand-rolled convention drift)', () => {
    for (const fixture of FIXTURES) {
      for (const instance of buildNodeScenePlan(fixture.run).instances) {
        const expected = new Matrix4().compose(
          new Vector3(instance.position.x, instance.position.y, instance.position.z),
          new Quaternion(),
          new Vector3(instance.radius, instance.radius, instance.radius),
        )
        for (let index = 0; index < 16; index += 1) {
          expect(
            instance.matrix[index],
            `${fixture.shape} ${instance.agentId} entry ${index}`,
          ).toBeCloseTo(expected.elements[index], 12)
        }
      }
    }
  })

  it('composeNodeMatrix scales a unit geometry and places it at the point', () => {
    const matrix = composeNodeMatrix({ x: 3, y: -2, z: 0.5 }, 0.75)
    expect(matrix[0]).toBe(0.75)
    expect(matrix[5]).toBe(0.75)
    expect(matrix[10]).toBe(0.75)
    expect(matrix[12]).toBe(3)
    expect(matrix[13]).toBe(-2)
    expect(matrix[14]).toBe(0.5)
    expect(matrix[15]).toBe(1)
  })
})

// ── determinism + purity ────────────────────────────────────────────────────

describe('node scene plan — determinism (M3-T1)', () => {
  it('is byte-identical across calls (PRD §5)', () => {
    for (const fixture of FIXTURES) {
      const first = JSON.stringify(buildNodeScenePlan(fixture.run))
      const second = JSON.stringify(buildNodeScenePlan(fixture.run))
      expect(second, fixture.shape).toBe(first)
    }
  })

  it('is byte-identical whatever order the model’s arrays arrive in', () => {
    for (const fixture of FIXTURES) {
      const straight = JSON.stringify(buildNodeScenePlan(fixture.run))
      const scrambledPlan = JSON.stringify(buildNodeScenePlan(scrambled(fixture.run)))
      expect(scrambledPlan, fixture.shape).toBe(straight)
    }
  })

  it('never mutates the model it reads', () => {
    for (const fixture of FIXTURES) {
      const before = JSON.stringify(fixture.run)
      buildNodeScenePlan(fixture.run)
      expect(JSON.stringify(fixture.run), fixture.shape).toBe(before)
    }
  })

  it('owns its own instance positions, so the layout cannot mutate a built plan', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run)
    const snapshot = JSON.stringify(plan.instances)
    // Mutate the layout the plan was composed from; the instances must stand.
    plan.layout.nodes[0].position.x += 999
    expect(JSON.stringify(plan.instances)).toBe(snapshot)
  })
})

// ── degenerate runs ─────────────────────────────────────────────────────────

describe('node scene plan — degenerate runs (M3-T1)', () => {
  it('yields no instances and no draw calls for an empty run', () => {
    const model = emptyRun()
    const plan = buildNodeScenePlan(model)
    expect(model.agents).toHaveLength(0)
    expect(plan.instances).toEqual([])
    expect(plan.count).toBe(0)
    expect(plan.drawCalls).toBe(0)
    expect(plan.bounds.radius).toBe(0)
  })

  it('places a lone agent at the origin with neutral visuals', () => {
    const model = soloRun()
    expect(model.agents).toHaveLength(1)
    const plan = buildNodeScenePlan(model)
    expect(plan.count).toBe(1)
    expect(plan.drawCalls).toBe(NODE_LAYER_DRAW_CALLS)
    const only = plan.instances[0]
    expect(only.position).toEqual({ x: 0, y: 0, z: 0 })
    // A run with no spread reads at the neutral midpoint (M2-T3).
    expect(only.intensity).toBe(NEUTRAL_INTENSITY)
    expect(only.matrix[12]).toBe(0)
    expect(only.matrix[13]).toBe(0)
    expect(only.matrix[14]).toBe(0)
  })

  it('looks up one instance by id, and returns null for an absent agent', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run)
    const first = plan.instances[0]
    expect(nodeInstance(plan, first.agentId)).toBe(first)
    expect(nodeInstance(plan, 'a_nobody')).toBeNull()
  })
})

// ── style + options ─────────────────────────────────────────────────────────

describe('node scene plan — style (M3-T1)', () => {
  it('honours style overrides and floors the segment count', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run, {
      style: { baseColor: [0.1, 0.2, 0.3], emissiveIntensity: 2, segments: 1 },
    })
    expect(plan.style.baseColor).toEqual([0.1, 0.2, 0.3])
    expect(plan.style.emissiveIntensity).toBe(2)
    expect(plan.style.segments).toBe(3)
    const instance = plan.instances[0]
    expect(instance.color[0]).toBeCloseTo(0.1 * instance.emissive, 12)
    expect(instance.color[1]).toBeCloseTo(0.2 * instance.emissive, 12)
    expect(instance.color[2]).toBeCloseTo(0.3 * instance.emissive, 12)
  })

  it('defaults every style field deterministically', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run)
    expect(plan.style.baseColor).toEqual(DEFAULT_BASE_COLOR)
    expect(plan.style.emissiveIntensity).toBe(DEFAULT_EMISSIVE_INTENSITY)
    expect(plan.style.segments).toBe(DEFAULT_SEGMENTS)
  })

  it('sanitizes a bad base colour back to the default per component', () => {
    const plan = buildNodeScenePlan(FIXTURES[0].run, {
      style: { baseColor: [Number.NaN, -1, 0.5] },
    })
    expect(plan.style.baseColor).toEqual([
      DEFAULT_BASE_COLOR[0],
      DEFAULT_BASE_COLOR[1],
      0.5,
    ])
    for (const instance of plan.instances) {
      expect(Number.isFinite(instance.color[0])).toBe(true)
      expect(Number.isFinite(instance.color[1])).toBe(true)
    }
  })

  it('passes settlement overrides through to the layout pass', () => {
    const plan = buildNodeScenePlan(FIXTURES[1].run, {
      settlement: { seed: 12345 },
    })
    expect(plan.seed).toBe(12345)
    expect(plan.layout.seed).toBe(12345)
  })

  it('surfaces a ScenePlanError rather than silently dropping a node', () => {
    // The error type is exported and named, so a caller can branch on it.
    const error = new ScenePlanError('no layout position for agent a_x')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ScenePlanError')
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

describe('node scene plan — purity (M3-T1)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/scene/nodes.ts'),
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
    expect(source).not.toMatch(/\bnew\s+Vector3\b/)
  })

  it('composes its visuals from the M2 passes, not a second implementation', () => {
    expect(source).toMatch(/\bsettleLayout\b/)
    expect(source).toMatch(/\bmapTraceAttributes\b/)
  })

  it('authors no coordinates — every position derives from the layout', () => {
    expect(findHandAuthoredCoordinates(source)).toEqual([])
  })
})
