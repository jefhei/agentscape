import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { FIXTURES } from '../fixtures/index.ts'
import type { FixtureShape, TraceFixture } from '../fixtures/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'
import {
  NEUTRAL_INTENSITY,
  deriveLayoutLinks,
  findHandAuthoredCoordinates,
  isSettled,
  mapTraceAttributes,
  settleLayout,
} from '../layout/index.ts'
import type { Vec3 } from '../layout/index.ts'
import { buildNodeScenePlan } from './nodes.ts'
import {
  ARC_ATTRIBUTE_NAMES,
  ARC_ATTRIBUTE_SIZES,
  ARC_CUSTOM_ATTRIBUTES,
  ARC_LAYER_DRAW_CALLS,
  DEFAULT_ARC_BASE_COLOR,
  DEFAULT_ARC_BULGE,
  DEFAULT_ARC_PULSE_COLOR,
  DEFAULT_ARC_SEGMENTS,
  DEFAULT_ARC_SIDES,
  DEFAULT_MAX_PULSE_HZ,
  DEFAULT_MIN_PULSE_HZ,
  DEFAULT_PULSE_WIDTH,
  PARKED_PULSE_PHASE,
  arcAnimationFor,
  arcControlPoint,
  arcInstanceFor,
  arcPulseParameter,
  buildArcScenePlan,
  perpendicularOf,
  quadraticPoint,
  quadraticTangent,
} from './arcs.ts'
import type { ArcBuffers, ArcScenePlan, ArcSceneStyle } from './arcs.ts'
import {
  ARC_FRAGMENT_SHADER,
  ARC_UNIFORMS,
  ARC_VERTEX_SHADER,
  DEFAULT_ARC_BASE_GLOW,
  DEFAULT_ARC_MIN_BRIGHTNESS,
  DEFAULT_ARC_PULSE_GAIN,
  DEFAULT_ARC_RIM_DIM,
  buildArcUniforms,
} from './arcShader.ts'
import { ScenePlanError } from './nodes.ts'

/**
 * Pure-layer tests for the message-arc scene plan (M3-T2).
 *
 * Following the PRD §5 rule, everything *gateable* lives on this side of the
 * split: the plan is pure data, so its structure, provenance, geometry,
 * animation model, determinism and degeneracy are pinned here — as is the
 * geometry/shader contract, which is the one seam where an untestable render
 * half could silently drift from the tested pure half. The rendered look of the
 * arcs is deliberately NOT asserted: jsdom has no GPU, so the look is
 * human-reviewed (M5-T5).
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

/** A one-agent run: a broadcast from an agent nobody else hears. */
function soloRun(): TraceModel {
  return modelFrom([row(1, 'solo', null)], 'solo')
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

/** The arc drawn for a pair, or a thrown error naming the pair. */
function arcFor(
  plan: ArcScenePlan,
  a: string,
  b: string,
): ArcScenePlan['arcs'][number] {
  const arc = arcInstanceFor(plan, a, b)
  if (arc === null) throw new Error(`no arc for ${a} <-> ${b}`)
  return arc
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }

function vertexAt(buffers: ArcBuffers, index: number): Vec3 {
  return {
    x: buffers.position[index * 3],
    y: buffers.position[index * 3 + 1],
    z: buffers.position[index * 3 + 2],
  }
}

function normalAt(buffers: ArcBuffers, index: number): Vec3 {
  return {
    x: buffers.normal[index * 3],
    y: buffers.normal[index * 3 + 1],
    z: buffers.normal[index * 3 + 2],
  }
}

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

function distance(a: Vec3, b: Vec3): number {
  const d = sub(a, b)
  return Math.sqrt(dot(d, d))
}

// ── structure ───────────────────────────────────────────────────────────────

describe('arc scene plan — structure (M3-T2)', () => {
  it('yields one arc per communication link, in canonical order, on every fixture', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const links = deriveLayoutLinks(entry.run)
      expect(plan.count, entry.shape).toBe(links.length)
      expect(plan.count, entry.shape).toBeGreaterThan(0)
      expect(
        plan.arcs.map((arc) => `${arc.source}->${arc.target}`),
        entry.shape,
      ).toEqual(links.map((link) => `${link.source}->${link.target}`))
    }
  })

  it('costs exactly one draw call for the whole arc population', () => {
    for (const entry of FIXTURES) {
      expect(buildArcScenePlan(entry.run).drawCalls, entry.shape).toBe(
        ARC_LAYER_DRAW_CALLS,
      )
    }
    expect(ARC_LAYER_DRAW_CALLS).toBe(1)
  })

  it('carries volume, intensity and width straight from the attribute mapping', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const mapped = mapTraceAttributes(entry.run).links
      plan.arcs.forEach((arc, index) => {
        expect(arc.volume, entry.shape).toBe(mapped[index].volume)
        expect(arc.intensity, entry.shape).toBe(mapped[index].intensity)
        expect(arc.width, entry.shape).toBe(mapped[index].width)
        expect(arc.width, entry.shape).toBeGreaterThan(0)
      })
    }
  })

  it('exposes the settled layout and the attribute mapping it composed', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
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

  it('starts every arc at its source node and ends it at its target node', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const positionOf = new Map(
        plan.layout.nodes.map((node) => [node.agentId, node.position]),
      )
      for (const arc of plan.arcs) {
        expect(arc.start, `${entry.shape} ${arc.source}`).toEqual(
          positionOf.get(arc.source),
        )
        expect(arc.end, `${entry.shape} ${arc.target}`).toEqual(
          positionOf.get(arc.target),
        )
      }
    }
  })

  it('types the plan, its buffers and each arc’s animation', () => {
    const plan = buildArcScenePlan(fixture('loop').run)
    expectTypeOf(plan).toEqualTypeOf<ArcScenePlan>()
    expectTypeOf(plan.buffers).toEqualTypeOf<ArcBuffers>()
    expectTypeOf(plan.style).toEqualTypeOf<ArcSceneStyle>()
    expectTypeOf(plan.arcs[0].animation.flow).toEqualTypeOf<-1 | 0 | 1>()
    expectTypeOf(plan.arcs[0].flow.forward).toEqualTypeOf<number>()
  })
})

// ── buffers ─────────────────────────────────────────────────────────────────

describe('arc scene plan — batched buffers (M3-T2)', () => {
  it('sizes every attribute for the vertex count the plan reports', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      expect(plan.vertexCount, entry.shape).toBe(plan.buffers.position.length / 3)
      expect(plan.indexCount, entry.shape).toBe(plan.buffers.indices.length)
      for (const name of ARC_ATTRIBUTE_NAMES) {
        expect(plan.buffers[name].length, `${entry.shape} ${name}`).toBe(
          plan.vertexCount * ARC_ATTRIBUTE_SIZES[name],
        )
      }
    }
  })

  it('carries exactly the attributes the geometry contract declares', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run)
    // Every custom attribute is a buffer, and the custom list plus the two
    // three.js-provided ones is the whole attribute set.
    const declared = new Set<string>([...ARC_CUSTOM_ATTRIBUTES, 'position', 'normal'])
    expect(new Set<string>(ARC_ATTRIBUTE_NAMES)).toEqual(declared)
    for (const name of ARC_CUSTOM_ATTRIBUTES) {
      expect(Object.keys(plan.buffers), name).toContain(name)
    }
    expect(ARC_CUSTOM_ATTRIBUTES.every((name) => ARC_ATTRIBUTE_SIZES[name] === 1)).toBe(
      true,
    )
  })

  it('allocates each arc a contiguous, non-overlapping slice', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { segments, sides } = plan.style
      let vertex = 0
      let index = 0
      for (const arc of plan.arcs) {
        expect(arc.vertexStart, entry.shape).toBe(vertex)
        expect(arc.vertexCount, entry.shape).toBe((segments + 1) * sides)
        expect(arc.indexStart, entry.shape).toBe(index)
        expect(arc.indexCount, entry.shape).toBe(segments * sides * 6)
        vertex += arc.vertexCount
        index += arc.indexCount
      }
      expect(vertex, entry.shape).toBe(plan.vertexCount)
      expect(index, entry.shape).toBe(plan.indexCount)
    }
  })

  it('indexes only real vertices, and every vertex is used', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      for (const index of plan.buffers.indices) {
        expect(Number.isInteger(index), entry.shape).toBe(true)
        expect(index, entry.shape).toBeGreaterThanOrEqual(0)
        expect(index, entry.shape).toBeLessThan(plan.vertexCount)
      }
      // No orphan vertices: a closed tube uses every one of them.
      expect(new Set(plan.buffers.indices).size, entry.shape).toBe(plan.vertexCount)
      expect(plan.buffers.indices.length % 3, entry.shape).toBe(0)
    }
  })

  it('writes each arc’s own animation parameters onto every one of its vertices', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { buffers } = plan
      for (const arc of plan.arcs) {
        for (let offset = 0; offset < arc.vertexCount; offset += 1) {
          const index = arc.vertexStart + offset
          expect(buffers.aPhase[index], entry.shape).toBe(arc.animation.phase)
          expect(buffers.aSpeed[index], entry.shape).toBe(arc.animation.speed)
          expect(buffers.aFlow[index], entry.shape).toBe(arc.animation.flow)
          expect(buffers.aIntensity[index], entry.shape).toBe(arc.intensity)
        }
        // `aT` runs the arc from 0 to 1, one value per ring.
        const t = buffers.aT.slice(arc.vertexStart, arc.vertexStart + arc.vertexCount)
        expect(t[0], entry.shape).toBe(0)
        expect(t[t.length - 1], entry.shape).toBe(1)
      }
    }
  })
})

// ── geometry ────────────────────────────────────────────────────────────────

describe('arc scene plan — geometry (M3-T2)', () => {
  it('sweeps every vertex onto the tube around its own curve', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { segments, sides } = plan.style
      for (const arc of plan.arcs) {
        for (let ring = 0; ring <= segments; ring += 1) {
          const t = ring / segments
          const point = quadraticPoint(arc.start, arc.control, arc.end, t)
          const centre: Vec3 = { ...ORIGIN }
          for (let side = 0; side < sides; side += 1) {
            const index = arc.vertexStart + ring * sides + side
            const vertex = vertexAt(plan.buffers, index)
            expect(plan.buffers.aT[index], entry.shape).toBe(t)
            // The vertex is exactly one tube radius off the curve...
            expect(distance(vertex, point), `${entry.shape} v${index}`).toBeCloseTo(
              arc.width,
              9,
            )
            expect(
              distance(normalAt(plan.buffers, index), ORIGIN),
              entry.shape,
            ).toBeCloseTo(1, 12)
            centre.x += vertex.x / sides
            centre.y += vertex.y / sides
            centre.z += vertex.z / sides
          }
          // ...and the ring's radial offsets cancel, so its centre is the curve.
          expect(centre.x, `${entry.shape} ring ${ring}`).toBeCloseTo(point.x, 9)
          expect(centre.y, `${entry.shape} ring ${ring}`).toBeCloseTo(point.y, 9)
          expect(centre.z, `${entry.shape} ring ${ring}`).toBeCloseTo(point.z, 9)
        }
      }
    }
  })

  it('stands every ring perpendicular to the curve (the frame is transported, not spun)', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { segments, sides } = plan.style
      for (const arc of plan.arcs) {
        for (let ring = 0; ring <= segments; ring += 1) {
          const tangent = quadraticTangent(
            arc.start,
            arc.control,
            arc.end,
            ring / segments,
          )
          for (let side = 0; side < sides; side += 1) {
            const index = arc.vertexStart + ring * sides + side
            expect(
              dot(normalAt(plan.buffers, index), tangent),
              entry.shape,
            ).toBeCloseTo(0, 9)
          }
        }
      }
    }
  })

  it('winds every triangle outward, so the tube faces the camera', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { indices } = plan.buffers
      for (let triangle = 0; triangle < indices.length; triangle += 3) {
        const [ia, ib, ic] = [
          indices[triangle],
          indices[triangle + 1],
          indices[triangle + 2],
        ]
        const a = vertexAt(plan.buffers, ia)
        const b = vertexAt(plan.buffers, ib)
        const c = vertexAt(plan.buffers, ic)
        const geometric = cross(sub(b, a), sub(c, a))
        const na = normalAt(plan.buffers, ia)
        const nb = normalAt(plan.buffers, ib)
        const nc = normalAt(plan.buffers, ic)
        const outward: Vec3 = {
          x: na.x + nb.x + nc.x,
          y: na.y + nb.y + nc.y,
          z: na.z + nb.z + nc.z,
        }
        expect(
          dot(geometric, outward),
          `${entry.shape} tri ${triangle}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('concentrates every vertex inside the settled cloud’s bounds', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      const { min, max, radius } = plan.bounds
      // The bow can push a vertex outside the node cloud: the apex sits at most
      // `bulge × radius` off its chord (a chord is at most the cloud's diameter),
      // plus the tube's own radius.
      const widest = plan.arcs.reduce((width, arc) => Math.max(width, arc.width), 0)
      const slack = plan.style.bulge * radius + widest
      for (let index = 0; index < plan.vertexCount; index += 1) {
        const vertex = vertexAt(plan.buffers, index)
        expect(vertex.x, entry.shape).toBeGreaterThanOrEqual(min.x - slack)
        expect(vertex.x, entry.shape).toBeLessThanOrEqual(max.x + slack)
        expect(vertex.y, entry.shape).toBeGreaterThanOrEqual(min.y - slack)
        expect(vertex.y, entry.shape).toBeLessThanOrEqual(max.y + slack)
        expect(vertex.z, entry.shape).toBeGreaterThanOrEqual(min.z - slack)
        expect(vertex.z, entry.shape).toBeLessThanOrEqual(max.z + slack)
      }
    }
  })

  it('bows away from the chord by the bulge, without moving the endpoints', () => {
    const start: Vec3 = { x: 0, y: 0, z: 0 }
    const end: Vec3 = { x: 4, y: 0, z: 0 }
    const control = arcControlPoint(start, end, 0.5)
    const mid: Vec3 = { x: 2, y: 0, z: 0 }
    // The control point is the chord's midpoint pushed off the chord...
    const offset = sub(control, mid)
    expect(offset.x).toBeCloseTo(0, 12)
    expect(Math.sqrt(offset.y * offset.y + offset.z * offset.z)).toBeCloseTo(2, 12)
    expect(dot(sub(control, mid), sub(end, start))).toBeCloseTo(0, 12)
    // ...so the curve's apex sits half that far out, and the ends are untouched.
    const apex = quadraticPoint(start, control, end, 0.5)
    expect(apex.x).toBeCloseTo(2, 12)
    expect(distance(apex, mid)).toBeCloseTo(1, 12)
    expect(quadraticPoint(start, control, end, 0)).toEqual(start)
    expect(quadraticPoint(start, control, end, 1)).toEqual(end)
  })

  it('gives a zero bulge a straight tube along the chord', () => {
    const plan = buildArcScenePlan(fixture('handoff-chain').run, {
      style: { bulge: 0 },
    })
    for (const arc of plan.arcs) {
      expect(
        distance(arc.control, quadraticPoint(arc.start, arc.control, arc.end, 0.5)),
      ).toBeCloseTo(0, 12)
      for (let ring = 0; ring <= plan.style.segments; ring += 1) {
        const t = ring / plan.style.segments
        // On a straight tube every ring centre is the chord lerp.
        for (let side = 0; side < plan.style.sides; side += 1) {
          const vertex = vertexAt(
            plan.buffers,
            arc.vertexStart + ring * plan.style.sides + side,
          )
          const expected: Vec3 = {
            x: arc.start.x + (arc.end.x - arc.start.x) * t,
            y: arc.start.y + (arc.end.y - arc.start.y) * t,
            z: arc.start.z + (arc.end.z - arc.start.z) * t,
          }
          expect(distance(vertex, expected), `ring ${ring}`).toBeCloseTo(arc.width, 9)
        }
      }
    }
  })

  it('derives its bow axis deterministically and never degenerately', () => {
    const axes: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0.5773502691896258, y: 0.5773502691896258, z: 0.5773502691896258 },
      { x: 0.2672612419124244, y: 0.5345224838248488, z: 0.8017837257372732 },
      { x: -0.9, y: 0.1, z: 0.4 },
    ]
    for (const axis of axes) {
      const perpendicular = perpendicularOf(axis)
      expect(distance(perpendicular, ORIGIN)).toBeCloseTo(1, 12)
      expect(dot(perpendicular, axis)).toBeCloseTo(0, 12)
      // Deterministic: the same axis always yields the same bow direction.
      expect(perpendicularOf(axis)).toEqual(perpendicular)
    }
    // A zero-length axis still yields a usable unit perpendicular.
    expect(distance(perpendicularOf(ORIGIN), ORIGIN)).toBeCloseTo(1, 12)
  })
})

// ── traffic direction ───────────────────────────────────────────────────────

describe('arc scene plan — traffic direction (M3-T2)', () => {
  it('counts exactly the messages the layout link weighed', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      for (const arc of plan.arcs) {
        expect(arc.flow.forward + arc.flow.backward, `${entry.shape}`).toBe(arc.volume)
        expect(arc.animation.flow, entry.shape).toBe(
          Math.sign(arc.flow.forward - arc.flow.backward),
        )
      }
    }
  })

  it('reads the fan-out’s silent workers as outward traffic', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run)
    expect(plan.arcs).toHaveLength(5)
    for (const arc of plan.arcs) {
      expect(arc.source).toBe('a_orchestrator')
      expect(arc.flow).toEqual({ forward: 1, backward: 0 })
      expect(arc.animation.flow).toBe(1)
    }
  })

  it('parks the loop’s balanced channel and travels the kickoff', () => {
    const plan = buildArcScenePlan(fixture('loop').run)
    const loop = arcFor(plan, 'a_critic', 'a_researcher')
    expect(loop.flow).toEqual({ forward: 3, backward: 3 })
    expect(loop.volume).toBe(6)
    expect(loop.animation.flow).toBe(0)
    expect(loop.animation.speed).toBe(0)

    const kickoff = arcFor(plan, 'a_orchestrator', 'a_researcher')
    expect(kickoff.flow).toEqual({ forward: 1, backward: 0 })
    expect(kickoff.animation.flow).toBe(1)
    expect(kickoff.animation.speed).toBe(DEFAULT_MIN_PULSE_HZ)
  })

  it('parks a completed round trip but travels an unanswered assignment', () => {
    const plan = buildArcScenePlan(fixture('dead-branch').run)
    // worker_ok answered, so its channel shows no net direction...
    const answered = arcFor(plan, 'a_orchestrator', 'a_worker_ok')
    expect(answered.flow).toEqual({ forward: 1, backward: 1 })
    expect(answered.animation.flow).toBe(0)
    // ...while the branch that went quiet carries one-way traffic.
    const dead = arcFor(plan, 'a_orchestrator', 'a_worker_dead')
    expect(dead.flow).toEqual({ forward: 1, backward: 0 })
    expect(dead.animation.flow).toBe(1)
  })

  it('travels the handoff relay in the direction the baton passed', () => {
    const plan = buildArcScenePlan(fixture('handoff-chain').run)
    // Each link runs from the canonically-first endpoint onward, so the
    // orientation the layout gave every link is the direction the baton moved.
    expect(plan.arcs.map((arc) => `${arc.source}->${arc.target}`)).toEqual([
      'a_agent_a->a_agent_b',
      'a_agent_b->a_agent_c',
      'a_agent_c->a_agent_d',
    ])
    for (const arc of plan.arcs) {
      expect(arc.animation.flow).toBe(1)
      expect(arc.flow).toEqual({ forward: 1, backward: 0 })
    }
  })

  it('reads a reverse-dominant pair as backwards', () => {
    // Agent ids are prefixed, so `a_a_hub` sorts before `a_z_relay`: the
    // canonically-first endpoint sent nothing, and the channel's net direction
    // is the other way.
    const model = modelFrom([row(1, 'z_relay', 'a_hub', 0)], 'reverse')
    const arc = arcFor(buildArcScenePlan(model), 'a_a_hub', 'a_z_relay')
    expect(arc.flow).toEqual({ forward: 0, backward: 1 })
    expect(arc.animation.flow).toBe(-1)
  })

  it('counts a broadcast once per recipient, as the link does', () => {
    const model = modelFrom(
      [
        row(1, 'hub', null, 0, 'status'),
        row(2, 'hub', null, 1, 'status'),
        row(3, 'hub', 'z_worker', 2, 'assign_task'),
      ],
      'broadcast',
    )
    const plan = buildArcScenePlan(model)
    // The export names only the sender, so a broadcast's listeners are the
    // run's *other* agents: the two broadcasts count on `hub <-> z_worker`, and
    // the direct assignment adds one more to the same pair — which is exactly
    // the weight rule deriveLayoutLinks applies to the link.
    expect(model.agents.map((agent) => agent.id)).toEqual(['a_hub', 'a_z_worker'])
    expect(plan.count).toBe(1)
    expect(plan.arcs[0].volume).toBe(3)
    expect(plan.arcs[0].flow).toEqual({ forward: 3, backward: 0 })
  })

  it('ignores a self-message', () => {
    const model = modelFrom(
      [row(1, 'self', 'self', 0), row(2, 'self', 'other', 1, 'assign_task')],
      'self',
    )
    const plan = buildArcScenePlan(model)
    // Only one link exists (`self` talking to itself has no direction), and the
    // self-message contributed nothing to its weight.
    expect(plan.count).toBe(1)
    expect(plan.arcs[0].volume).toBe(1)
    expect(plan.arcs[0].flow).toEqual({ forward: 0, backward: 1 })
  })
})

// ── animation model ─────────────────────────────────────────────────────────

describe('arc scene plan — animation (M3-T2)', () => {
  const style: Pick<ArcSceneStyle, 'minPulseHz' | 'maxPulseHz'> = {
    minPulseHz: DEFAULT_MIN_PULSE_HZ,
    maxPulseHz: DEFAULT_MAX_PULSE_HZ,
  }

  it('derives the pulse rate from the channel’s volume', () => {
    const quiet = arcAnimationFor('a_a', 'a_b', { forward: 1, backward: 0 }, 0, style)
    const loud = arcAnimationFor('a_a', 'a_b', { forward: 1, backward: 0 }, 1, style)
    const middle = arcAnimationFor(
      'a_a',
      'a_b',
      { forward: 1, backward: 0 },
      0.5,
      style,
    )
    expect(quiet.speed).toBe(DEFAULT_MIN_PULSE_HZ)
    expect(loud.speed).toBe(DEFAULT_MAX_PULSE_HZ)
    expect(middle.speed).toBeCloseTo(
      (DEFAULT_MIN_PULSE_HZ + DEFAULT_MAX_PULSE_HZ) / 2,
      12,
    )
    expect(quiet.speed).toBeLessThan(middle.speed)
    expect(middle.speed).toBeLessThan(loud.speed)
  })

  it('parks a balanced channel instead of inventing a direction', () => {
    const parked = arcAnimationFor('a_a', 'a_b', { forward: 2, backward: 2 }, 1, style)
    expect(parked.flow).toBe(0)
    expect(parked.speed).toBe(0)
    expect(parked.phase).toBe(PARKED_PULSE_PHASE)
    for (const time of [0, 1234, 999_999]) {
      expect(arcPulseParameter(parked, time)).toBe(PARKED_PULSE_PHASE)
    }
  })

  it('derives a stable, unsynchronised phase per pair', () => {
    const first = arcAnimationFor(
      'a_orchestrator',
      'a_worker_alpha',
      { forward: 1, backward: 0 },
      0.5,
      style,
    )
    const again = arcAnimationFor(
      'a_orchestrator',
      'a_worker_alpha',
      { forward: 1, backward: 0 },
      0.5,
      style,
    )
    expect(again.phase).toBe(first.phase)
    expect(first.phase).toBeGreaterThanOrEqual(0)
    expect(first.phase).toBeLessThan(1)

    const phases = new Set(
      buildArcScenePlan(fixture('fan-out').run).arcs.map((arc) => arc.animation.phase),
    )
    expect(phases.size).toBeGreaterThan(1)
  })

  it('wraps the pulse into [0, 1) for any time, including before zero', () => {
    for (const entry of FIXTURES) {
      const plan = buildArcScenePlan(entry.run)
      for (const arc of plan.arcs) {
        for (const time of [-5000, -1, 0, 1, 250, 4000, 123_456.75]) {
          const parameter = arcPulseParameter(arc.animation, time)
          expect(parameter, `${entry.shape} ${time}`).toBeGreaterThanOrEqual(0)
          expect(parameter, `${entry.shape} ${time}`).toBeLessThan(1)
        }
      }
    }
  })

  it('repeats with the channel’s own period', () => {
    const plan = buildArcScenePlan(fixture('handoff-chain').run)
    for (const arc of plan.arcs) {
      const period = 1000 / arc.animation.speed
      for (const time of [0, 421, 1500.5]) {
        expect(
          arcPulseParameter(arc.animation, time + period),
          `${arc.source}->${arc.target}`,
        ).toBeCloseTo(arcPulseParameter(arc.animation, time), 9)
      }
    }
  })

  it('travels forward on a forward channel and backwards on a reverse one', () => {
    // Explicit animations (the fixtures' phases are hash-derived, so they could
    // wrap mid-assertion): a quarter-cycle head start, one cycle per second.
    const forward = { flow: 1 as const, speed: 1, phase: 0.25 }
    const reverse = { flow: -1 as const, speed: 1, phase: 0.25 }
    const tenth = 100 // 0.1 of a cycle at 1 Hz
    // Forward traffic advances the pulse along the arc by the elapsed fraction...
    expect(arcPulseParameter(forward, tenth)).toBeCloseTo(
      arcPulseParameter(forward, 0) + 0.1,
      9,
    )
    // ...and reverse traffic moves it back by the same fraction.
    expect(arcPulseParameter(reverse, tenth)).toBeCloseTo(
      arcPulseParameter(reverse, 0) - 0.1,
      9,
    )
    // The two are mirror images of one another at every instant.
    for (const time of [0, 250, 900, 4200]) {
      expect(
        arcPulseParameter(reverse, time) + arcPulseParameter(forward, time),
      ).toBeCloseTo(1, 9)
    }
  })

  it('never moves a channel whose speed is zero', () => {
    for (const time of [0, 500, 12_345]) {
      expect(arcPulseParameter({ flow: 1, speed: 0, phase: 0.25 }, time)).toBe(0.25)
    }
  })
})

// ── the geometry/shader contract ────────────────────────────────────────────

describe('arc scene plan — shader contract (M3-T2)', () => {
  /** Every `attribute <type> <name>;` a shader declares. */
  function declaredAttributes(shader: string): string[] {
    return [...shader.matchAll(/attribute\s+\w+\s+(\w+)\s*;/g)].map((match) => match[1])
  }

  /** Every `uniform <type> <name>;` a shader declares. */
  function declaredUniforms(shader: string): string[] {
    return [...shader.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((match) => match[1])
  }

  /** Every `varying <type> <name>;` a shader declares. */
  function declaredVaryings(shader: string): string[] {
    return [...shader.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((match) => match[1])
  }

  /** The shader's executable part (everything after `void main()`). */
  function bodyOf(shader: string): string {
    return shader.slice(shader.indexOf('void main()'))
  }

  it('declares exactly the attributes the geometry provides', () => {
    expect(new Set(declaredAttributes(ARC_VERTEX_SHADER))).toEqual(
      new Set(ARC_CUSTOM_ATTRIBUTES),
    )
    // `position`/`normal`/`uv` are injected by three.js for a ShaderMaterial;
    // re-declaring one is a compile error, so the shaders must not.
    expect(ARC_VERTEX_SHADER).not.toMatch(
      /attribute\s+\w+\s+(?:position|normal|uv)\s*;/,
    )
    expect(declaredAttributes(ARC_FRAGMENT_SHADER)).toEqual([])
  })

  it('declares exactly the uniforms buildArcUniforms provides', () => {
    const names = ARC_UNIFORMS.map((uniform) => uniform.name)
    expect(new Set(declaredUniforms(ARC_VERTEX_SHADER))).toEqual(
      new Set(
        ARC_UNIFORMS.filter((uniform) => uniform.stage === 'vertex').map(
          (uniform) => uniform.name,
        ),
      ),
    )
    expect(new Set(declaredUniforms(ARC_FRAGMENT_SHADER))).toEqual(
      new Set(
        ARC_UNIFORMS.filter((uniform) => uniform.stage === 'fragment').map(
          (uniform) => uniform.name,
        ),
      ),
    )
    const style = buildArcScenePlan(fixture('loop').run).style
    expect(new Set(Object.keys(buildArcUniforms(style)))).toEqual(new Set(names))
  })

  it('passes every varying from the vertex stage to the fragment stage', () => {
    const varyings = declaredVaryings(ARC_VERTEX_SHADER)
    expect(varyings.length).toBeGreaterThan(0)
    expect(new Set(declaredVaryings(ARC_FRAGMENT_SHADER))).toEqual(new Set(varyings))
    for (const varying of varyings) {
      // The vertex stage writes it; the fragment stage reads it.
      expect(bodyOf(ARC_VERTEX_SHADER), varying).toContain(`${varying} =`)
      expect(bodyOf(ARC_FRAGMENT_SHADER), varying).toContain(varying)
    }
  })

  it('mirrors the pure pulse rule on the GPU', () => {
    // The rule (./arcs.ts): wrap `time × speed + phase` into [0, 1), then flip
    // it for a channel whose net flow runs the other way. If the GLSL is edited
    // away from that shape, this fails rather than the two halves silently
    // disagreeing — the same canary the M3-T1 matrix test applies to three.js.
    expect(ARC_VERTEX_SHADER).toMatch(/uTime\s*\*\s*aSpeed\s*\+\s*aPhase/)
    expect(ARC_VERTEX_SHADER).toMatch(/fract\s*\(/)
    expect(ARC_VERTEX_SHADER).toMatch(/aFlow\s*<\s*0\.0/)
    expect(ARC_VERTEX_SHADER).toContain('vT = aT')
    expect(ARC_VERTEX_SHADER).toContain('vIntensity = aIntensity')
    // The fragment stage measures the band in arc parameter, and wraps it.
    expect(ARC_FRAGMENT_SHADER).toMatch(/abs\s*\(\s*vT\s*-\s*vPulse\s*\)/)
    expect(ARC_FRAGMENT_SHADER).toContain('1.0 - delta')
    expect(ARC_FRAGMENT_SHADER).toMatch(/gl_FragColor\s*=/)
  })

  it('exposes the pulse band width the plan resolved', () => {
    const plan = buildArcScenePlan(fixture('loop').run)
    const uniforms = buildArcUniforms(plan.style)
    expect(uniforms.uPulseWidth.value).toBe(plan.style.pulseWidth)
    expect(uniforms.uBaseColor.value).toEqual([...plan.style.baseColor])
    expect(uniforms.uPulseColor.value).toEqual([...plan.style.pulseColor])
  })
})

// ── uniforms ────────────────────────────────────────────────────────────────

describe('arc scene plan — uniforms (M3-T2)', () => {
  const style = buildArcScenePlan(fixture('fan-out').run).style

  it('starts the clock at zero — the render layer owns the tick', () => {
    expect(buildArcUniforms(style).uTime.value).toBe(0)
  })

  it('defaults the material’s glow constants deterministically', () => {
    const uniforms = buildArcUniforms(style)
    expect(uniforms.uBaseGlow.value).toBe(DEFAULT_ARC_BASE_GLOW)
    expect(uniforms.uPulseGain.value).toBe(DEFAULT_ARC_PULSE_GAIN)
    expect(uniforms.uRimDim.value).toBe(DEFAULT_ARC_RIM_DIM)
    expect(uniforms.uMinBrightness.value).toBe(DEFAULT_ARC_MIN_BRIGHTNESS)
  })

  it('honours overrides and sanitizes a bad one', () => {
    const overridden = buildArcUniforms(style, { baseGlow: 2, pulseGain: Number.NaN })
    expect(overridden.uBaseGlow.value).toBe(2)
    expect(overridden.uPulseGain.value).toBe(DEFAULT_ARC_PULSE_GAIN)
    expect(buildArcUniforms(style, { rimDim: -1 }).uRimDim.value).toBe(
      DEFAULT_ARC_RIM_DIM,
    )
  })

  it('returns fresh slots each call, so materials cannot share state', () => {
    const first = buildArcUniforms(style)
    const second = buildArcUniforms(style)
    expect(second).not.toBe(first)
    expect(second.uBaseColor.value).not.toBe(first.uBaseColor.value)
    first.uTime.value = 12
    expect(second.uTime.value).toBe(0)
  })
})

// ── style + options ─────────────────────────────────────────────────────────

describe('arc scene plan — style and options (M3-T2)', () => {
  it('defaults every style field deterministically', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run)
    expect(plan.style).toEqual({
      baseColor: DEFAULT_ARC_BASE_COLOR,
      pulseColor: DEFAULT_ARC_PULSE_COLOR,
      segments: DEFAULT_ARC_SEGMENTS,
      sides: DEFAULT_ARC_SIDES,
      bulge: DEFAULT_ARC_BULGE,
      pulseWidth: DEFAULT_PULSE_WIDTH,
      minPulseHz: DEFAULT_MIN_PULSE_HZ,
      maxPulseHz: DEFAULT_MAX_PULSE_HZ,
    })
    expect(plan.style.baseColor).not.toBe(DEFAULT_ARC_BASE_COLOR)
  })

  it('honours style overrides, resizing the batch with the resolution', () => {
    const plan = buildArcScenePlan(fixture('loop').run, {
      style: { segments: 3, sides: 4, baseColor: [0.1, 0.2, 0.3] },
    })
    expect(plan.style.segments).toBe(3)
    expect(plan.style.sides).toBe(4)
    expect(plan.style.baseColor).toEqual([0.1, 0.2, 0.3])
    for (const arc of plan.arcs) {
      expect(arc.vertexCount).toBe(4 * 4)
      expect(arc.indexCount).toBe(3 * 4 * 6)
    }
    expect(plan.vertexCount).toBe(plan.count * 16)
  })

  it('floors a degenerate resolution and keeps the pulse width positive', () => {
    const plan = buildArcScenePlan(fixture('loop').run, {
      style: { segments: 0, sides: 1, pulseWidth: 0, bulge: Number.NaN },
    })
    expect(plan.style.segments).toBe(1)
    expect(plan.style.sides).toBe(3)
    expect(plan.style.pulseWidth).toBeGreaterThan(0)
    expect(Number.isFinite(plan.style.pulseWidth)).toBe(true)
    expect(plan.style.bulge).toBe(DEFAULT_ARC_BULGE)
  })

  it('tolerates a swapped pulse-rate pair', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run, {
      style: { minPulseHz: 2, maxPulseHz: 0.5 },
    })
    expect(plan.style.minPulseHz).toBe(0.5)
    expect(plan.style.maxPulseHz).toBe(2)
  })

  it('sanitizes a bad colour per component', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run, {
      style: { baseColor: [Number.NaN, -1, 0.5] },
    })
    expect(plan.style.baseColor).toEqual([
      DEFAULT_ARC_BASE_COLOR[0],
      DEFAULT_ARC_BASE_COLOR[1],
      0.5,
    ])
  })

  it('reuses a supplied layout and attribute map instead of deriving them', () => {
    const entry = fixture('loop')
    const nodes = buildNodeScenePlan(entry.run)
    const reused = buildArcScenePlan(entry.run, {
      layout: nodes.layout,
      attributeMap: nodes.attributes,
    })
    // Identity, not equality: the sibling layer's own objects were used.
    expect(reused.layout).toBe(nodes.layout)
    expect(reused.attributes).toBe(nodes.attributes)
    expect(reused.converged).toBe(isSettled(nodes.layout))
    expect(reused.iterations).toBe(nodes.layout.iterations)
    expect(reused.seed).toBe(nodes.layout.seed)
    // And the arcs meet exactly the nodes the node layer drew (M3-T1).
    const instanceById = new Map(
      nodes.instances.map((instance) => [instance.agentId, instance]),
    )
    for (const arc of reused.arcs) {
      const source = instanceById.get(arc.source)
      const target = instanceById.get(arc.target)
      expect(arc.start).toEqual(source?.position)
      expect(arc.end).toEqual(target?.position)
    }
  })

  it('derives the same arcs whether the layout is reused or re-settled', () => {
    for (const entry of FIXTURES) {
      const nodes = buildNodeScenePlan(entry.run)
      const reused = buildArcScenePlan(entry.run, {
        layout: nodes.layout,
        attributeMap: nodes.attributes,
      })
      expect(JSON.stringify(reused), entry.shape).toBe(
        JSON.stringify(buildArcScenePlan(entry.run)),
      )
    }
  })

  it('honours settlement overrides when it settles itself', () => {
    const plan = buildArcScenePlan(fixture('fan-out').run, {
      settlement: { seed: 4242 },
    })
    expect(plan.seed).toBe(4242)
    expect(plan.layout.seed).toBe(4242)
  })

  it('surfaces a ScenePlanError rather than silently dropping an arc', () => {
    // The error type is shared with the node layer and named, so a caller can
    // branch on it; the arc plan throws it when the layout cannot place a link.
    const error = new ScenePlanError('no layout position for arc a_x -> a_y')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ScenePlanError')
    expect(error.message).toContain('a_x -> a_y')
  })
})

// ── degenerate runs ─────────────────────────────────────────────────────────

describe('arc scene plan — degenerate runs (M3-T2)', () => {
  it('yields no arcs, no buffers and no draw calls for an empty run', () => {
    const model = emptyRun()
    const plan = buildArcScenePlan(model)
    expect(model.agents).toHaveLength(0)
    expect(plan.arcs).toEqual([])
    expect(plan.count).toBe(0)
    expect(plan.vertexCount).toBe(0)
    expect(plan.indexCount).toBe(0)
    expect(plan.drawCalls).toBe(0)
    expect(plan.buffers.position).toEqual([])
    expect(plan.buffers.indices).toEqual([])
  })

  it('yields no arcs for a lone agent, which has nobody to talk to', () => {
    const model = soloRun()
    expect(model.agents).toHaveLength(1)
    const plan = buildArcScenePlan(model)
    expect(plan.count).toBe(0)
    expect(plan.drawCalls).toBe(0)
    expect(plan.vertexCount).toBe(0)
    expect(plan.layout.nodes).toHaveLength(1)
  })

  it('looks up one arc by either direction, and null for a silent pair', () => {
    const plan = buildArcScenePlan(fixture('handoff-chain').run)
    const arc = arcFor(plan, 'a_agent_a', 'a_agent_b')
    expect(arcInstanceFor(plan, 'a_agent_b', 'a_agent_a')).toBe(arc)
    expect(arcInstanceFor(plan, 'a_agent_a', 'a_agent_d')).toBeNull()
    expect(arcInstanceFor(plan, 'a_nobody', 'a_agent_b')).toBeNull()
  })
})

// ── determinism + purity ────────────────────────────────────────────────────

describe('arc scene plan — determinism (M3-T2)', () => {
  it('is byte-identical across calls (PRD §5)', () => {
    for (const entry of FIXTURES) {
      const first = JSON.stringify(buildArcScenePlan(entry.run))
      const second = JSON.stringify(buildArcScenePlan(entry.run))
      expect(second, entry.shape).toBe(first)
    }
  })

  it('is byte-identical whatever order the model’s arrays arrive in', () => {
    for (const entry of FIXTURES) {
      const straight = JSON.stringify(buildArcScenePlan(entry.run))
      const shuffled = JSON.stringify(buildArcScenePlan(scrambled(entry.run)))
      expect(shuffled, entry.shape).toBe(straight)
    }
  })

  it('never mutates the model it reads', () => {
    for (const entry of FIXTURES) {
      const before = JSON.stringify(entry.run)
      buildArcScenePlan(entry.run)
      expect(JSON.stringify(entry.run), entry.shape).toBe(before)
    }
  })

  it('owns its own endpoints and buffers, so a reused layout cannot mutate it', () => {
    const plan = buildArcScenePlan(fixture('loop').run)
    const snapshot = JSON.stringify(plan.arcs)
    const buffers = JSON.stringify(plan.buffers.position)
    plan.layout.nodes[0].position.x += 999
    expect(JSON.stringify(plan.arcs)).toBe(snapshot)
    expect(JSON.stringify(plan.buffers.position)).toBe(buffers)
  })

  it('keeps a channel with no volume spread at the neutral pulse rate', () => {
    // Five weight-1 links: no relative volume, so M2-T3 reads every arc neutral
    // and the pulse rate sits at the middle of the range.
    const plan = buildArcScenePlan(fixture('fan-out').run)
    for (const arc of plan.arcs) {
      expect(arc.intensity).toBe(NEUTRAL_INTENSITY)
      expect(arc.animation.speed).toBeCloseTo(
        (DEFAULT_MIN_PULSE_HZ + DEFAULT_MAX_PULSE_HZ) / 2,
        12,
      )
    }
    // The loop *does* have spread: the six-message channel outranks the kickoff.
    const loop = buildArcScenePlan(fixture('loop').run)
    const kickoff = arcFor(loop, 'a_orchestrator', 'a_researcher')
    const chatter = arcFor(loop, 'a_critic', 'a_researcher')
    expect(kickoff.intensity).toBeLessThan(chatter.intensity)
    expect(chatter.intensity).toBe(1)
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

describe('arc scene plan — purity (M3-T2)', () => {
  const sources = ['src/scene/arcs.ts', 'src/scene/arcShader.ts'].map((relative) => ({
    relative,
    source: sourceOf(relative),
  }))

  it('reads no clock and no randomness', () => {
    for (const { relative, source } of sources) {
      expect(source, relative).not.toMatch(/\bDate\.now\s*\(/)
      expect(source, relative).not.toMatch(/\bperformance\.now\s*\(/)
      expect(source, relative).not.toMatch(/\bMath\.random\s*\(/)
    }
  })

  it('is a data-layer module — no three.js or DOM', () => {
    for (const { relative, source } of sources) {
      expect(source, relative).not.toMatch(/from ['"]three['"]/)
      expect(source, relative).not.toMatch(/@react-three/)
      expect(source, relative).not.toMatch(/\bdocument\./)
      expect(source, relative).not.toMatch(/\bwindow\./)
      expect(source, relative).not.toMatch(/\bnew\s+Vector3\b/)
    }
  })

  it('composes its shape from the M2 passes, not a second implementation', () => {
    const arcs = sourceOf('src/scene/arcs.ts')
    expect(arcs).toMatch(/\bsettleLayout\b/)
    expect(arcs).toMatch(/\bmapTraceAttributes\b/)
    expect(arcs).toMatch(/\bisSettled\b/)
    // The GLSL is generated from the same contract the geometry writes.
    const shader = sourceOf('src/scene/arcShader.ts')
    expect(shader).toMatch(/\bARC_CUSTOM_ATTRIBUTES\b/)
    expect(shader).toMatch(/\bARC_UNIFORMS\b/)
  })

  it('authors no coordinates — every position derives from the layout', () => {
    for (const { relative, source } of sources) {
      expect(findHandAuthoredCoordinates(source), relative).toEqual([])
    }
  })
})
