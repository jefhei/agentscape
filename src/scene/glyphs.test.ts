import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { FIXTURES } from '../fixtures/index.ts'
import type { FixtureShape, TraceFixture } from '../fixtures/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'
import {
  EDGE_KINDS,
  classifyAction,
  findHandAuthoredCoordinates,
  isSettled,
  mapTraceAttributes,
  settleLayout,
} from '../layout/index.ts'
import type { Vec3 } from '../layout/index.ts'
import { ScenePlanError } from './nodes.ts'
import {
  DEFAULT_GLYPH_BASE_COLOR,
  DEFAULT_GLYPH_DETAIL,
  DEFAULT_GLYPH_EMISSIVE_INTENSITY,
  DEFAULT_GLYPH_KIND_COLORS,
  DEFAULT_GLYPH_KIND_SCALE,
  DEFAULT_GLYPH_ORBIT_GAP,
  DEFAULT_GLYPH_RING_GAP,
  DEFAULT_GLYPH_SIZE_RATIO,
  DEFAULT_GLYPHS_PER_RING,
  DEFAULT_MAX_ORBIT_HZ,
  DEFAULT_MAX_TILT,
  DEFAULT_MIN_ORBIT_HZ,
  DEFAULT_MIN_TILT,
  GLYPH_KINDS,
  GLYPH_LAYER_DRAW_CALLS,
  buildGlyphScenePlan,
  glyphInstance,
  glyphMatrixAt,
  glyphOrbitAngle,
  glyphPositionAt,
  glyphsForAgent,
  writeGlyphMatrices,
} from './glyphs.ts'
import type { GlyphInstance, GlyphScenePlan, GlyphSceneStyle } from './glyphs.ts'

/**
 * Pure-layer tests for the tool-call glyph scene plan (M3-T3).
 *
 * Following the PRD §5 rule, everything *gateable* lives on this side of the
 * split: the plan is pure data, so its structure, provenance, orbit geometry,
 * animation rule, determinism, degeneracy and the draw-call seam are pinned
 * here. The rendered look of the glyphs is deliberately NOT asserted: jsdom has
 * no GPU, so the look is human-reviewed (M5-T5).
 */

const ISO = '2026-10-01T09:00:00.000Z'

// ── helpers ─────────────────────────────────────────────────────────────────

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: AgentMessageRow[], label = 'custom'): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows, { label }))
}

/** One `agent_messages` row, defaulted to a bare unread message. */
function row(
  id: number,
  from: string,
  to: string | null,
  offsetMinutes = 0,
  action?: string,
): AgentMessageRow {
  return {
    id,
    from_agent: from,
    to_agent: to,
    subject: `m${id}`,
    body: action === undefined ? null : JSON.stringify({ action }),
    created_at: new Date(Date.parse(ISO) + offsetMinutes * 60_000).toISOString(),
  }
}

/** An empty run — the degenerate case. */
function emptyRun(): TraceModel {
  return modelFrom([], 'empty')
}

/** A run with conversation but *no* tool calls (no row declares an action). */
function actionlessRun(): TraceModel {
  return modelFrom([row(1, 'a', 'b'), row(2, 'b', 'a', 1)], 'actionless')
}

/** A one-agent run whose single broadcast carries an action. */
function soloRun(): TraceModel {
  return modelFrom([row(1, 'solo', null, 0, 'tick')], 'solo')
}

/**
 * One agent that makes three calls, one per relationship kind: a handoff, a
 * coordination act (spawn) and ordinary chatter (message). Used to pin the
 * kind-driven size/hue mapping against a single node.
 */
function threeKindRun(): TraceModel {
  return modelFrom(
    [
      row(1, 'worker', 'boss', 0, 'handoff'),
      row(2, 'worker', 'boss', 1, 'assign_task'),
      row(3, 'worker', 'boss', 2, 'task_complete'),
    ],
    'three-kind',
  )
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

/** A fixture by shape (the registry is the source of the reference runs). */
function fixture(shape: FixtureShape): TraceFixture {
  const found = FIXTURES.find((entry) => entry.shape === shape)
  if (found === undefined) throw new Error(`missing fixture: ${shape}`)
  return found
}

/**
 * The plans for the four fixtures, settled once — the relaxation is the
 * expensive part of building a plan and it is deterministic, so sharing it
 * between tests is safe as long as no test mutates a cached plan.
 */
const PLAN_CACHE = new Map<FixtureShape, GlyphScenePlan>()
function planOf(shape: FixtureShape): GlyphScenePlan {
  const cached = PLAN_CACHE.get(shape)
  if (cached !== undefined) return cached
  const plan = buildGlyphScenePlan(fixture(shape).run)
  PLAN_CACHE.set(shape, plan)
  return plan
}

const SAMPLED_TIMES = [0, 250, 1000, 5000, 12_345.6, 60_000]

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function length(v: Vec3): number {
  return Math.sqrt(dot(v, v))
}

function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b))
}

/** The glyph for a tool call, or a thrown error naming it. */
function glyphFor(plan: GlyphScenePlan, toolCallId: string): GlyphInstance {
  const glyph = glyphInstance(plan, toolCallId)
  if (glyph === null) throw new Error(`no glyph for ${toolCallId}`)
  return glyph
}

/** Fold an angle into `(−π, π]` so ring spacing can be compared directly. */
function wrap(angle: number): number {
  const twoPi = Math.PI * 2
  const folded = angle - Math.floor(angle / twoPi + 0.5) * twoPi
  return folded === -Math.PI ? Math.PI : folded
}

/** The node's mapped visuals for an agent, from the plan's own attributes. */
function nodeVisuals(plan: GlyphScenePlan, agentId: string) {
  const node = plan.attributes.nodes.find((entry) => entry.agentId === agentId)
  if (node === undefined) throw new Error(`no mapped node for ${agentId}`)
  return node
}

// ── structure ───────────────────────────────────────────────────────────────

describe('glyph scene plan — structure (M3-T3)', () => {
  it('yields one glyph per tool call, in canonical order, on every fixture', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      expect(plan.count, entry.shape).toBe(entry.run.toolCalls.length)
      expect(plan.count, entry.shape).toBeGreaterThan(0)
      expect(
        plan.glyphs.map((glyph) => glyph.toolCallId),
        entry.shape,
      ).toEqual(
        [...entry.run.toolCalls]
          .sort(
            (a, b) =>
              (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
              a.at - b.at ||
              a.id.localeCompare(b.id),
          )
          .map((call) => call.id),
      )
    }
  })

  it('marks each call with its own caller, name and backing message', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      const byId = new Map(entry.run.toolCalls.map((call) => [call.id, call]))
      for (const glyph of plan.glyphs) {
        const call = byId.get(glyph.toolCallId)
        expect(call, `${entry.shape} ${glyph.toolCallId}`).toBeDefined()
        expect(glyph.agentId, entry.shape).toBe(call?.agentId)
        expect(glyph.name, entry.shape).toBe(call?.name)
        expect(glyph.messageId, entry.shape).toBe(call?.messageId)
      }
      // Nothing is invented: no glyph for a call that does not exist.
      expect(plan.glyphs, entry.shape).toHaveLength(entry.run.toolCalls.length)
    }
  })

  it('derives each glyph kind from M2-T4’s classification of the call’s action', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        expect(glyph.kind, `${entry.shape} ${glyph.name}`).toBe(
          classifyAction(glyph.name),
        )
      }
    }
  })

  it('reads the four fixture shapes as the trace states them', () => {
    // Fan-out: the orchestrator's five assignments are all coordination acts.
    const fanOut = planOf('fan-out')
    expect(fanOut.glyphs.every((glyph) => glyph.kind === 'spawn')).toBe(true)
    expect(fanOut.glyphs.every((glyph) => glyph.agentId === 'a_orchestrator')).toBe(
      true,
    )
    expect(fanOut.glyphs).toHaveLength(5)

    // Loop: one kickoff that spawns, then chatter both ways.
    const loop = planOf('loop')
    const loopKinds = Object.fromEntries(
      loop.glyphs.map((glyph) => [glyph.name, glyph.kind]),
    )
    expect(loopKinds).toEqual({
      start_loop: 'spawn',
      draft: 'message',
      revise: 'message',
    })
    expect(glyphsForAgent(loop, 'a_researcher')).toHaveLength(3)

    // Handoff chain: every link passes the baton on.
    const handoff = planOf('handoff-chain')
    expect(handoff.glyphs.map((glyph) => glyph.kind)).toEqual([
      'handoff',
      'handoff',
      'handoff',
    ])

    // Dead branch: the two assignments spawn, the completion is chatter.
    const dead = planOf('dead-branch')
    expect(glyphsForAgent(dead, 'a_orchestrator').map((glyph) => glyph.kind)).toEqual([
      'spawn',
      'spawn',
    ])
    expect(glyphsForAgent(dead, 'a_worker_ok')[0].kind).toBe('message')
  })

  it('costs exactly one draw call for the whole glyph population', () => {
    for (const entry of FIXTURES) {
      expect(planOf(entry.shape).drawCalls, entry.shape).toBe(GLYPH_LAYER_DRAW_CALLS)
    }
    expect(GLYPH_LAYER_DRAW_CALLS).toBe(1)
  })

  it('exposes the settled layout, the attribute mapping and the settlement facts', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      const { layout, converged, iterations } = settleLayout(entry.run)
      expect(JSON.stringify(plan.layout), entry.shape).toBe(JSON.stringify(layout))
      expect(JSON.stringify(plan.attributes), entry.shape).toBe(
        JSON.stringify(mapTraceAttributes(entry.run)),
      )
      expect(plan.seed, entry.shape).toBe(layout.seed)
      expect(plan.bounds, entry.shape).toEqual(layout.bounds)
      expect(plan.converged, entry.shape).toBe(converged)
      expect(plan.iterations, entry.shape).toBe(iterations)
    }
  })

  it('orbits the position the node layer actually drew, for every glyph', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      const positionOf = new Map(
        plan.layout.nodes.map((node) => [node.agentId, node.position]),
      )
      for (const glyph of plan.glyphs) {
        expect(glyph.center, `${entry.shape} ${glyph.toolCallId}`).toEqual(
          positionOf.get(glyph.agentId),
        )
      }
    }
  })

  it('reuses a supplied layout/attribute map by identity instead of re-deriving', () => {
    const entry = fixture('loop')
    const { layout } = settleLayout(entry.run)
    const attributes = mapTraceAttributes(entry.run)
    const plan = buildGlyphScenePlan(entry.run, { layout, attributeMap: attributes })
    expect(plan.layout).toBe(layout)
    expect(plan.attributes).toBe(attributes)
    expect(JSON.stringify(plan.glyphs)).toBe(
      JSON.stringify(buildGlyphScenePlan(entry.run).glyphs),
    )
    expect(plan.converged).toBe(isSettled(layout))
  })

  it('looks one glyph up by tool-call id, and groups them by agent', () => {
    const plan = planOf('handoff-chain')
    const first = glyphFor(plan, plan.glyphs[0].toolCallId)
    expect(first).toBe(plan.glyphs[0])
    expect(glyphInstance(plan, first.toolCallId)).toBe(first)
    expect(glyphInstance(plan, 'tc_nope')).toBeNull()
    expect(glyphsForAgent(plan, 'a_agent_b')).toHaveLength(1)
    expect(glyphsForAgent(plan, 'a_nobody')).toEqual([])
  })
})

// ── the derived orbit ───────────────────────────────────────────────────────

describe('glyph scene plan — orbit geometry (M3-T3)', () => {
  it('places every glyph exactly its orbit radius from the centre, at any time', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        for (const time of SAMPLED_TIMES) {
          expect(
            distance(glyphPositionAt(glyph, time), glyph.center),
            `${entry.shape} ${glyph.toolCallId} @${time}`,
          ).toBeCloseTo(glyph.orbitRadius, 9)
        }
      }
    }
  })

  it('keeps every glyph in its own orbit plane', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        for (const time of SAMPLED_TIMES) {
          const offset = sub(glyphPositionAt(glyph, time), glyph.center)
          expect(dot(offset, glyph.normal), `${entry.shape} @${time}`).toBeCloseTo(0, 9)
        }
      }
    }
  })

  it('gives every orbit an orthonormal frame, consistent with its normal', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        expect(length(glyph.basisU), entry.shape).toBeCloseTo(1, 12)
        expect(length(glyph.basisV), entry.shape).toBeCloseTo(1, 12)
        expect(length(glyph.normal), entry.shape).toBeCloseTo(1, 12)
        expect(dot(glyph.basisU, glyph.basisV), entry.shape).toBeCloseTo(0, 12)
        expect(dot(glyph.basisU, glyph.normal), entry.shape).toBeCloseTo(0, 12)
        expect(dot(glyph.basisV, glyph.normal), entry.shape).toBeCloseTo(0, 12)
        // basisV is the normal turned onto basisU — one handedness, no mirroring.
        const turned = cross(glyph.normal, glyph.basisU)
        expect(turned.x, entry.shape).toBeCloseTo(glyph.basisV.x, 12)
        expect(turned.y, entry.shape).toBeCloseTo(glyph.basisV.y, 12)
        expect(turned.z, entry.shape).toBeCloseTo(glyph.basisV.z, 12)
      }
    }
  })

  it('tilts every agent’s plane inside the configured window', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        const tilt = Math.acos(glyph.normal.y)
        expect(tilt, `${entry.shape} tilt`).toBeGreaterThanOrEqual(
          DEFAULT_MIN_TILT - 1e-12,
        )
        expect(tilt, `${entry.shape} tilt`).toBeLessThanOrEqual(
          DEFAULT_MAX_TILT + 1e-12,
        )
      }
    }
  })

  it('de-synchronises agents: no two agents share an orbit plane', () => {
    const plan = planOf('loop')
    const planes = ['a_critic', 'a_orchestrator', 'a_researcher'].map(
      (agentId) => glyphsForAgent(plan, agentId)[0],
    )
    expect(planes).toHaveLength(3)
    const normals = planes.map((glyph) => glyph.normal)
    for (let i = 0; i < normals.length; i += 1) {
      for (let j = i + 1; j < normals.length; j += 1) {
        expect(Math.abs(dot(normals[i], normals[j])), `agents ${i}/${j}`).toBeLessThan(
          0.999,
        )
      }
    }
    // ... and each agent's phase differs too, so rings are not aligned.
    const angles = planes.map((glyph) => glyph.orbit.angle)
    expect(new Set(angles).size).toBe(3)
  })

  it('spaces an agent’s calls evenly around their ring', () => {
    const plan = planOf('fan-out')
    const angles = plan.glyphs.map((glyph) => wrap(glyph.orbit.angle))
    for (let index = 1; index < angles.length; index += 1) {
      const step = wrap(angles[index] - angles[index - 1])
      expect(step, `slot ${index}`).toBeCloseTo(
        (Math.PI * 2) / DEFAULT_GLYPHS_PER_RING,
        9,
      )
    }
  })

  it('fills a ring before moving to the next, ring by ring', () => {
    const plan = planOf('fan-out')
    // Five calls, six slots per ring: every call is on the innermost ring.
    expect(plan.glyphs.map((glyph) => glyph.ring)).toEqual([0, 0, 0, 0, 0])
    expect(plan.glyphs.map((glyph) => glyph.slot)).toEqual([0, 1, 2, 3, 4])
    const perRing = buildGlyphScenePlan(fixture('fan-out').run, {
      style: { perRing: 2 },
    })
    expect(perRing.glyphs.map((glyph) => `${glyph.ring}:${glyph.slot}`)).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '1:1',
      '2:0',
    ])
  })

  it('steps each further ring out by exactly one ring gap', () => {
    const plan = buildGlyphScenePlan(fixture('fan-out').run, {
      style: { perRing: 2 },
    })
    const inner = plan.glyphs[0].orbitRadius
    expect(plan.glyphs[1].orbitRadius).toBe(inner)
    expect(plan.glyphs[2].orbitRadius - plan.glyphs[1].orbitRadius).toBeCloseTo(
      DEFAULT_GLYPH_RING_GAP,
      12,
    )
    expect(plan.glyphs[4].orbitRadius - plan.glyphs[1].orbitRadius).toBeCloseTo(
      2 * DEFAULT_GLYPH_RING_GAP,
      12,
    )
  })

  it('derives the orbit radius from the node’s own mapped radius', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      for (const glyph of plan.glyphs) {
        const node = nodeVisuals(plan, glyph.agentId)
        expect(glyph.orbitRadius, entry.shape).toBeCloseTo(
          node.size +
            plan.style.orbitGap +
            glyph.size / 2 +
            glyph.ring * plan.style.ringGap,
          12,
        )
      }
    }
  })

  it('clears the node surface by the orbit gap on the innermost ring', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      for (const glyph of plan.glyphs) {
        const node = nodeVisuals(plan, glyph.agentId)
        const innerEdge = glyph.orbitRadius - glyph.size / 2
        expect(innerEdge, `${entry.shape} ${glyph.toolCallId}`).toBeGreaterThanOrEqual(
          node.size + plan.style.orbitGap - 1e-12,
        )
      }
    }
  })
})

// ── derived size and colour ─────────────────────────────────────────────────

describe('glyph scene plan — derived visuals (M3-T3)', () => {
  it('sizes a glyph from its node’s radius and its kind', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      for (const glyph of plan.glyphs) {
        const node = nodeVisuals(plan, glyph.agentId)
        expect(glyph.size, entry.shape).toBeCloseTo(
          node.size * plan.style.sizeRatio * plan.style.kindScale[glyph.kind],
          12,
        )
        expect(glyph.size, entry.shape).toBeGreaterThan(0)
      }
    }
  })

  it('reads a coordination act larger than a handoff, and a handoff larger than chatter', () => {
    const plan = buildGlyphScenePlan(threeKindRun())
    const kinds = plan.glyphs.map((glyph) => glyph.kind)
    expect(kinds).toEqual(['handoff', 'spawn', 'message'])
    // One node, three kinds: the only difference is the kind.
    const [handoff, spawn, message] = plan.glyphs
    expect(spawn.size).toBeGreaterThan(handoff.size)
    expect(handoff.size).toBeGreaterThan(message.size)
    expect(spawn.agentId).toBe(handoff.agentId)
    expect(handoff.agentId).toBe(message.agentId)
  })

  it('hues a glyph by its kind, scaled by the caller’s own emissive', () => {
    const plan = buildGlyphScenePlan(threeKindRun())
    const colorOf = (kind: string) => {
      const glyph = plan.glyphs.find((entry) => entry.kind === kind)
      if (glyph === undefined) throw new Error(`no ${kind} glyph`)
      return glyph.color
    }
    const node = nodeVisuals(plan, 'a_worker')
    for (const kind of GLYPH_KINDS) {
      const glyph = colorOf(kind)
      const base = DEFAULT_GLYPH_KIND_COLORS[kind]
      expect(glyph[0], kind).toBeCloseTo(base[0] * node.emissive, 12)
      expect(glyph[1], kind).toBeCloseTo(base[1] * node.emissive, 12)
      expect(glyph[2], kind).toBeCloseTo(base[2] * node.emissive, 12)
    }
    // The three kinds are visually distinct (the hue channel is not a no-op).
    const hues = plan.glyphs.map((glyph) => glyph.color.join(','))
    expect(new Set(hues).size).toBe(3)
  })

  it('makes a hot agent’s glyph brighter than a quiet agent’s, kind for kind', () => {
    // The loop's researcher is at full activity, its critic just below it.
    const plan = planOf('loop')
    const researcher = glyphsForAgent(plan, 'a_researcher')[0]
    const critic = glyphsForAgent(plan, 'a_critic')[0]
    expect(researcher.kind).toBe(critic.kind)
    const hot = nodeVisuals(plan, 'a_researcher').emissive
    const cool = nodeVisuals(plan, 'a_critic').emissive
    expect(hot).toBeGreaterThan(cool)
    expect(researcher.color[0]).toBeGreaterThan(critic.color[0])
    expect(researcher.color[1]).toBeGreaterThan(critic.color[1])
  })
})

// ── the motion rule ─────────────────────────────────────────────────────────

describe('glyph scene plan — the orbit rule (M3-T3)', () => {
  it('advances the angle at the glyph’s own rate, from its own start angle', () => {
    const glyph = planOf('fan-out').glyphs[0]
    expect(glyphOrbitAngle(glyph.orbit, 0)).toBe(glyph.orbit.angle)
    expect(glyphOrbitAngle(glyph.orbit, 1000)).toBeCloseTo(
      glyph.orbit.angle + glyph.orbit.angularSpeed,
      12,
    )
    expect(glyphOrbitAngle(glyph.orbit, 4000)).toBeCloseTo(
      glyph.orbit.angle + 4 * glyph.orbit.angularSpeed,
      12,
    )
  })

  it('returns to the same place after one full revolution', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        const periodMs = ((Math.PI * 2) / glyph.orbit.angularSpeed) * 1000
        const before = glyphPositionAt(glyph, 750)
        const after = glyphPositionAt(glyph, 750 + periodMs)
        expect(distance(before, after), entry.shape).toBeLessThan(1e-9)
      }
    }
  })

  it('always moves — no glyph is parked', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        expect(glyph.orbit.angularSpeed, entry.shape).toBeGreaterThan(0)
        expect(
          distance(glyphPositionAt(glyph, 0), glyphPositionAt(glyph, 5000)),
          entry.shape,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('takes its rate from the caller’s normalized activity, like the arc pulse', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      for (const glyph of plan.glyphs) {
        const node = nodeVisuals(plan, glyph.agentId)
        const rate =
          DEFAULT_MIN_ORBIT_HZ +
          (DEFAULT_MAX_ORBIT_HZ - DEFAULT_MIN_ORBIT_HZ) * node.intensity
        expect(glyph.orbit.angularSpeed, entry.shape).toBeCloseTo(
          rate * Math.PI * 2,
          12,
        )
      }
    }
    // The loop's busiest agent rotates fastest, its quietest slowest.
    const plan = planOf('loop')
    const fast = glyphsForAgent(plan, 'a_researcher')[0].orbit.angularSpeed
    const slow = glyphsForAgent(plan, 'a_orchestrator')[0].orbit.angularSpeed
    expect(fast).toBeGreaterThan(slow)
    expect(slow).toBeCloseTo(DEFAULT_MIN_ORBIT_HZ * Math.PI * 2, 12)
  })

  it('takes the clock as a parameter — the same time always yields the same place', () => {
    const glyph = planOf('handoff-chain').glyphs[0]
    expect(glyphPositionAt(glyph, 1234)).toEqual(glyphPositionAt(glyph, 1234))
    expect(glyphMatrixAt(glyph, 1234)).toEqual(glyphMatrixAt(glyph, 1234))
  })
})

// ── the instance matrix ─────────────────────────────────────────────────────

describe('glyph scene plan — instance matrix (M3-T3)', () => {
  it('composes translation × uniform scale in column-major order', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        const time = 4321
        const position = glyphPositionAt(glyph, time)
        const m = glyphMatrixAt(glyph, time)
        expect(m, entry.shape).toHaveLength(16)
        expect(m[0]).toBe(glyph.size)
        expect(m[5]).toBe(glyph.size)
        expect(m[10]).toBe(glyph.size)
        for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11]) {
          expect(m[index], `${entry.shape} entry ${index}`).toBe(0)
        }
        expect(m[12]).toBe(position.x)
        expect(m[13]).toBe(position.y)
        expect(m[14]).toBe(position.z)
        expect(m[15]).toBe(1)
      }
    }
  })

  it('agrees with three.js Matrix4.compose (no hand-rolled convention drift)', () => {
    for (const entry of FIXTURES) {
      for (const glyph of planOf(entry.shape).glyphs) {
        const m = glyphMatrixAt(glyph, 800)
        const expected = new Matrix4().compose(
          new Vector3(
            glyphPositionAt(glyph, 800).x,
            glyphPositionAt(glyph, 800).y,
            glyphPositionAt(glyph, 800).z,
          ),
          new Quaternion(),
          new Vector3(glyph.size, glyph.size, glyph.size),
        )
        expect(m, entry.shape).toEqual([...expected.elements])
      }
    }
  })

  it('writes the whole batch into an InstancedMesh-shaped buffer', () => {
    for (const entry of FIXTURES) {
      const plan = planOf(entry.shape)
      const target = new Float32Array(plan.count * 16)
      expect(writeGlyphMatrices(plan.glyphs, 900, target)).toBe(plan.count)
      plan.glyphs.forEach((glyph, index) => {
        const expected = glyphMatrixAt(glyph, 900)
        for (let element = 0; element < 16; element += 1) {
          // The buffer is float32, the plan float64 — same numbers, GPU width.
          expect(
            target[index * 16 + element],
            `${entry.shape} glyph ${index} element ${element}`,
          ).toBeCloseTo(expected[element], 5)
        }
      })
    }
  })

  it('respects the target buffer’s capacity and an offset', () => {
    const plan = planOf('fan-out')
    const short = new Float32Array(2 * 16)
    expect(writeGlyphMatrices(plan.glyphs, 0, short)).toBe(2)
    const offsetTarget = new Float32Array(3 * 16)
    expect(writeGlyphMatrices(plan.glyphs, 0, offsetTarget, 16)).toBe(2)
    expect([...offsetTarget.slice(0, 16)]).toEqual(new Array(16).fill(0))
    const expected = glyphMatrixAt(plan.glyphs[0], 0)
    for (let element = 0; element < 16; element += 1) {
      expect(offsetTarget[16 + element]).toBeCloseTo(expected[element], 5)
    }
  })

  it('mutates nothing but the output buffer', () => {
    const plan = planOf('loop')
    const before = JSON.stringify(plan.glyphs)
    const target = new Float32Array(plan.count * 16)
    writeGlyphMatrices(plan.glyphs, 1000, target)
    expect(JSON.stringify(plan.glyphs)).toBe(before)
    // Writing again from a fresh buffer reproduces the same bytes.
    const again = new Float32Array(plan.count * 16)
    writeGlyphMatrices(plan.glyphs, 1000, again)
    expect([...again]).toEqual([...target])
  })
})

// ── style ───────────────────────────────────────────────────────────────────

describe('glyph scene plan — style (M3-T3)', () => {
  it('defaults every style field deterministically', () => {
    const style = buildGlyphScenePlan(fixture('fan-out').run).style
    expect(style.baseColor).toEqual(DEFAULT_GLYPH_BASE_COLOR)
    expect(style.emissiveIntensity).toBe(DEFAULT_GLYPH_EMISSIVE_INTENSITY)
    expect(style.kindScale).toEqual(DEFAULT_GLYPH_KIND_SCALE)
    expect(style.kindColors).toEqual(DEFAULT_GLYPH_KIND_COLORS)
    expect(style.orbitGap).toBe(DEFAULT_GLYPH_ORBIT_GAP)
    expect(style.ringGap).toBe(DEFAULT_GLYPH_RING_GAP)
    expect(style.perRing).toBe(DEFAULT_GLYPHS_PER_RING)
    expect(style.minOrbitHz).toBe(DEFAULT_MIN_ORBIT_HZ)
    expect(style.maxOrbitHz).toBe(DEFAULT_MAX_ORBIT_HZ)
    expect(style.detail).toBe(DEFAULT_GLYPH_DETAIL)
    expect(style.minTilt).toBe(DEFAULT_MIN_TILT)
    expect(style.maxTilt).toBe(DEFAULT_MAX_TILT)
  })

  it('reuses M2-T4’s edge kinds as the glyph kinds', () => {
    expect(GLYPH_KINDS).toEqual(EDGE_KINDS)
    expect([...GLYPH_KINDS]).toEqual(['spawn', 'handoff', 'message'])
  })

  it('honours overrides and sanitizes the ones that cannot be drawn', () => {
    const style = buildGlyphScenePlan(fixture('fan-out').run, {
      style: {
        baseColor: [1, 0.5, -1],
        emissiveIntensity: 2,
        sizeRatio: 0.5,
        orbitGap: 0.2,
        ringGap: 0.3,
        perRing: 2.7,
        minOrbitHz: 0.5,
        maxOrbitHz: 0.1,
        detail: 2.9,
        minTilt: 0.4,
        maxTilt: 0.2,
      },
    }).style
    expect(style.baseColor).toEqual([1, 0.5, DEFAULT_GLYPH_BASE_COLOR[2]])
    expect(style.emissiveIntensity).toBe(2)
    expect(style.sizeRatio).toBe(0.5)
    expect(style.orbitGap).toBe(0.2)
    expect(style.ringGap).toBe(0.3)
    expect(style.perRing).toBe(2)
    expect(style.detail).toBe(2)
    // A swapped orbit range is tolerated, so min ≤ max always holds.
    expect(style.minOrbitHz).toBe(0.1)
    expect(style.maxOrbitHz).toBe(0.5)
    expect(style.minTilt).toBe(0.2)
    expect(style.maxTilt).toBe(0.4)
  })

  it('never lets an override zero a glyph or a ring', () => {
    const style = buildGlyphScenePlan(fixture('fan-out').run, {
      style: {
        sizeRatio: 0,
        perRing: -4,
        detail: -1,
        kindScale: { spawn: 0 },
        kindColors: { message: [-1, 2, Number.NaN] },
      },
    }).style
    expect(style.sizeRatio).toBe(DEFAULT_GLYPH_SIZE_RATIO)
    expect(style.perRing).toBe(DEFAULT_GLYPHS_PER_RING)
    expect(style.detail).toBe(0)
    expect(style.kindScale.spawn).toBe(DEFAULT_GLYPH_KIND_SCALE.spawn)
    expect(style.kindColors.message).toEqual([
      DEFAULT_GLYPH_KIND_COLORS.message[0],
      2,
      DEFAULT_GLYPH_KIND_COLORS.message[2],
    ])
    // A non-finite override is not a number a matrix could hold.
    const nan = buildGlyphScenePlan(fixture('fan-out').run, {
      style: { ringGap: Number.NaN, minOrbitHz: Number.POSITIVE_INFINITY },
    }).style
    expect(nan.ringGap).toBe(DEFAULT_GLYPH_RING_GAP)
    expect(nan.minOrbitHz).toBe(DEFAULT_MIN_ORBIT_HZ)
    expect(nan.maxOrbitHz).toBe(DEFAULT_MAX_ORBIT_HZ)
  })

  it('hands out fresh style objects, not shared mutable state', () => {
    const first = buildGlyphScenePlan(fixture('fan-out').run).style
    const second = buildGlyphScenePlan(fixture('fan-out').run).style
    expect(first).not.toBe(second)
    first.baseColor[0] = 99
    first.kindScale.spawn = 99
    expect(second.baseColor[0]).toBe(DEFAULT_GLYPH_BASE_COLOR[0])
    expect(second.kindScale.spawn).toBe(DEFAULT_GLYPH_KIND_SCALE.spawn)
    expect(buildGlyphScenePlan(fixture('fan-out').run).style.baseColor[0]).toBe(
      DEFAULT_GLYPH_BASE_COLOR[0],
    )
  })

  it('lets a caller overlay glyphs on a reused layout, never re-settling', () => {
    const run = fixture('loop').run
    const { layout } = settleLayout(run)
    const plan = buildGlyphScenePlan(run, {
      layout,
      style: { perRing: 1, sizeRatio: 0.2 },
    })
    expect(plan.layout).toBe(layout)
    expect(plan.iterations).toBe(layout.iterations)
    // One call per ring: three rings for the three-call agents.
    expect(glyphsForAgent(plan, 'a_researcher').map((glyph) => glyph.ring)).toEqual([
      0, 1, 2,
    ])
  })
})

// ── degeneracy + failure ────────────────────────────────────────────────────

describe('glyph scene plan — degeneracy (M3-T3)', () => {
  it('draws nothing for a run with no tool calls, and costs nothing', () => {
    for (const model of [emptyRun(), actionlessRun()]) {
      const plan = buildGlyphScenePlan(model)
      expect(plan.count).toBe(0)
      expect(plan.glyphs).toEqual([])
      expect(plan.drawCalls).toBe(0)
      // The layer the plan describes still carries its layout.
      expect(plan.layout.nodes.length).toBe(model.agents.length)
    }
  })

  it('places a lone agent’s glyph on its own node, whatever the node is at', () => {
    const model = soloRun()
    const plan = buildGlyphScenePlan(model)
    expect(plan.count).toBe(1)
    expect(plan.glyphs[0].agentId).toBe('a_solo')
    expect(plan.glyphs[0].center).toEqual(plan.layout.nodes[0].position)
    // The orbit wraps its own node: outside the node, inside the run's bounds.
    expect(plan.glyphs[0].orbitRadius).toBeGreaterThan(nodeVisuals(plan, 'a_solo').size)
  })

  it('fails loudly when the layout has no position for a glyph’s caller', () => {
    const emptyLayout = settleLayout(emptyRun()).layout
    expect(() =>
      buildGlyphScenePlan(fixture('fan-out').run, { layout: emptyLayout }),
    ).toThrow(ScenePlanError)
    expect(() =>
      buildGlyphScenePlan(fixture('fan-out').run, { layout: emptyLayout }),
    ).toThrow(/no layout position for agent/)
  })

  it('fails loudly when the attribute map has no entry for a glyph’s caller', () => {
    expect(() =>
      buildGlyphScenePlan(fixture('fan-out').run, {
        attributeMap: mapTraceAttributes(emptyRun()),
      }),
    ).toThrow(ScenePlanError)
  })
})

// ── determinism + purity ────────────────────────────────────────────────────

describe('glyph scene plan — determinism (M3-T3)', () => {
  it('is byte-identical across calls (PRD §5)', () => {
    for (const entry of FIXTURES) {
      const first = JSON.stringify(buildGlyphScenePlan(entry.run))
      const second = JSON.stringify(buildGlyphScenePlan(entry.run))
      expect(second, entry.shape).toBe(first)
    }
  })

  it('is byte-identical whatever order the model’s arrays arrive in', () => {
    for (const entry of FIXTURES) {
      const straight = JSON.stringify(buildGlyphScenePlan(entry.run))
      const shuffled = JSON.stringify(buildGlyphScenePlan(scrambled(entry.run)))
      expect(shuffled, entry.shape).toBe(straight)
    }
  })

  it('never mutates the model it reads', () => {
    for (const entry of FIXTURES) {
      const before = JSON.stringify(entry.run)
      buildGlyphScenePlan(entry.run)
      expect(JSON.stringify(entry.run), entry.shape).toBe(before)
    }
  })

  it('owns its own numbers, so a layout re-use cannot rewrite a handed-out plan', () => {
    const run = fixture('fan-out').run
    const { layout } = settleLayout(run)
    const plan = buildGlyphScenePlan(run, { layout })
    const node = layout.nodes.find((entry) => entry.agentId === 'a_orchestrator')
    expect(node).toBeDefined()
    expect(plan.glyphs[0].center).not.toBe(node?.position)
    plan.glyphs[0].center.x = 1234
    expect(buildGlyphScenePlan(run, { layout }).glyphs[0].center.x).toBe(
      node?.position.x,
    )
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

/** A module's source, with its comments stripped so prose cannot trip a scan. */
function sourceOf(relative: string): string {
  return readFileSync(resolve(findRepoRoot(process.cwd()), relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

describe('glyph scene plan — purity (M3-T3)', () => {
  const source = sourceOf('src/scene/glyphs.ts')

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

  it('composes the M2 passes and the M3-T1/T2 helpers, not a second implementation', () => {
    expect(source).toMatch(/\bsettleLayout\b/)
    expect(source).toMatch(/\bmapTraceAttributes\b/)
    expect(source).toMatch(/\bisSettled\b/)
    // The kind comes from M2-T4; the plane's perpendicular from M3-T2; the
    // instance transform from M3-T1.
    expect(source).toMatch(/\bclassifyAction\b/)
    expect(source).toMatch(/\bperpendicularOf\b/)
    expect(source).toMatch(/\bcomposeNodeMatrix\b/)
  })

  it('authors no coordinates — every glyph orbits a settled position', () => {
    expect(findHandAuthoredCoordinates(source)).toEqual([])
  })

  it('builds one instanced mesh for the whole population, with the orbit rule shared', () => {
    const layer = sourceOf('src/scene/GlyphLayer.tsx')
    // Exactly one instanced mesh, and no per-glyph element anywhere.
    expect(layer.match(/<instancedMesh/g)).toHaveLength(1)
    expect(layer).not.toMatch(/<mesh\s/)
    expect(layer).not.toMatch(/\.map\(\s*\(?\s*glyph/)
    // The motion comes from the pure rule, not from arithmetic in the renderer.
    expect(layer).toMatch(/\bwriteGlyphMatrices\b/)
  })

  it('exposes its style and plan surfaces as typed data', () => {
    expectTypeOf<GlyphSceneStyle['perRing']>().toEqualTypeOf<number>()
    expectTypeOf<GlyphScenePlan['glyphs']>().toEqualTypeOf<GlyphInstance[]>()
    const styleSurface: Partial<GlyphSceneStyle> = { perRing: 4 }
    expect(styleSurface.perRing).toBe(4)
  })
})
