/**
 * Cross-fixture invariant harness for the M2 spatial layout engine (M2-T5).
 *
 * M2-T1..M2-T4 each landed one piece of the layout engine and tested *itself*
 * against the four reference fixtures. This module is the **shared gate** that
 * ties them together: given a normalized {@link TraceModel} and the layout /
 * attribute / edge outputs derived from it, it reports every invariant the M2
 * exit criteria pin — as *data*, never as pixels.
 *
 * ## Why a module and not just assertions inside a test file
 *
 * The M2 machine gate (BUILD_PLAN) reads: *"determinism pinned (two runs
 * deep-equal); no hand-authored coordinates anywhere in `src/`"*, and the exit
 * criteria add *"every node position and visual attribute derives from trace
 * data"*. Expressing those rules once, in a pure, reusable module means:
 *
 * 1. the four reference fixtures are checked against the **same** rules —
 *    M2-T5's whole point: an invariant proven on one fixture is proven on all
 *    of them;
 * 2. later milestones **reuse** them instead of re-deriving them (M3's
 *    draw-call gate and M5's scale proof both need "every position/attribute
 *    derives from the trace" to still hold);
 * 3. a failure names its rule (`code`) and its subject (`detail`), so a broken
 *    layout points at the broken thing rather than at a mystery `toBe` diff.
 *
 * Each `check*` function returns an array of {@link InvariantViolation} — an
 * empty array means "the invariants hold" — rather than throwing, so a caller
 * (a test, or a future dev overlay) decides what to do with them.
 * {@link assertInvariants} is the throwing convenience.
 *
 * ## The rules, by layer
 *
 * - **Layout** ({@link checkLayoutInvariants}) — one node per agent in canonical
 *   order; finite, distinct positions; the layout is pinned to the run's `seed`
 *   and reports a non-negative integer iteration count; bounds enclose the
 *   cloud and `radius` is the farthest node; and the link list **is**
 *   `deriveLayoutLinks(model)` (the topology derives from the trace, it is
 *   never authored).
 * - **Attributes** ({@link checkAttributeInvariants}) — one node per agent;
 *   every activity figure re-derives from the model's own counts; every
 *   intensity lies in `[0, 1]` and maps monotonically into the configured
 *   output range; arcs mirror the layout's links; the recorded spans are the
 *   true spans; and a channel with no spread is neutral.
 * - **Edges** ({@link checkEdgeInvariants}) — `edges` partitions cleanly into
 *   `byKind`; each edge's weight / message ids / actions / timestamps re-derive
 *   from the messages it aggregates; the spawn lineage is acyclic with real
 *   parents, `childIds`/`fanOut`/`maxFanOut`/`rootIds` consistent; and every
 *   agent's derived `role` re-derives from the documented rule.
 *
 * `{@link findHandAuthoredCoordinates}` is the data-layer half of the machine
 * gate: a pure scanner that flags a hand-placed coordinate (a `new Vector3(…)`,
 * a `position: [1.2, …]` literal, a non-zero `{ x, y, z }` triple) in a
 * module's source, so a test can assert the pure half of `src/` carries none.
 *
 * Pure and deterministic (PRD §5): no three.js, no DOM, no clock, no
 * `Math.random`, no mutation of any input. jsdom-safe. **Nothing about the look
 * is asserted** — jsdom has no GPU; the look is human-reviewed (M5-T5).
 */

import type { AgentId, AgentRole } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  DEFAULT_MAX_ARC_WIDTH,
  DEFAULT_MAX_EMISSIVE,
  DEFAULT_MAX_NODE_SIZE,
  DEFAULT_MIN_ARC_WIDTH,
  DEFAULT_MIN_EMISSIVE,
  DEFAULT_MIN_NODE_SIZE,
  NEUTRAL_INTENSITY,
  mapTraceAttributes,
} from './attributes.ts'
import type { TraceAttributes } from './attributes.ts'
import { EDGE_KINDS, classifyAction, deriveEdgeModel } from './edges.ts'
import type { EdgeKind, EdgeModel } from './edges.ts'
import { MIN_DISTANCE, deriveLayoutLinks } from './forceLayout.ts'
import type { ForceLayout, Vec3 } from './forceLayout.ts'
import { settleLayout } from './settlement.ts'
import type { SettlementOptions } from './settlement.ts'

/** Tolerance for float comparisons that should be exact-but-for-rounding. */
const EPSILON = 1e-9

// ── Violations ──────────────────────────────────────────────────────────────

/**
 * One broken invariant: a stable `code` (safe to assert on) plus a
 * human-readable `detail` naming the offending subject.
 */
export interface InvariantViolation {
  code: string
  detail: string
}

/** Thrown by {@link assertInvariants} when a check reports violations. */
export class InvariantError extends Error {
  /** The violations that caused the throw, in report order. */
  readonly violations: InvariantViolation[]

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `M2 invariants violated (${violations.length}): ` +
        violations.map((v) => `${v.code} — ${v.detail}`).join('; '),
    )
    this.name = 'InvariantError'
    this.violations = [...violations]
  }
}

/**
 * Throw an {@link InvariantError} when `violations` is non-empty; a no-op for
 * an empty report. The throwing convenience over the `check*` functions.
 */
export function assertInvariants(violations: readonly InvariantViolation[]): void {
  if (violations.length > 0) throw new InvariantError(violations)
}

function push(out: InvariantViolation[], code: string, detail: string): void {
  out.push({ code, detail })
}

/** Euclidean distance between two points. */
function dist3(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

/** Min/max of a non-empty list, or `{0,0}` when empty (mirrors the mapper). */
function spanOf(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 }
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

/** The canonical (id-sorted) agent ids of a model. */
function canonicalAgentIds(model: TraceModel): AgentId[] {
  return model.agents.map((agent) => agent.id).sort(compareModelIds)
}

/**
 * Record `expected`-vs-`actual` ordering violations for a per-agent array,
 * covering count, canonical order and uniqueness in one place — the three
 * structural rules every layer's per-agent list must satisfy.
 */
function checkIndexById(
  out: InvariantViolation[],
  layer: string,
  expected: readonly AgentId[],
  actual: readonly AgentId[],
): void {
  if (actual.length !== expected.length) {
    push(
      out,
      `${layer}-count`,
      `expected ${expected.length} entries, got ${actual.length}`,
    )
  }
  if (actual.length === expected.length) {
    for (let i = 0; i < actual.length; i += 1) {
      if (actual[i] !== expected[i]) {
        push(
          out,
          `${layer}-canonical`,
          `entry ${i} is ${actual[i]}, expected ${expected[i]}`,
        )
        break
      }
    }
  }
  if (new Set(actual).size !== actual.length) {
    push(out, `${layer}-unique`, 'duplicate agent ids')
  }
}

// ── Layout invariants ───────────────────────────────────────────────────────

/** Optional overrides for {@link checkLayoutInvariants}. */
export interface LayoutInvariantOptions {
  /** The seed the layout should be pinned to; defaults to the model's own. */
  seed?: number
}

/** The first pair of nodes closer than `MIN_DISTANCE`, or `null`. */
function firstCoincidentPair(layout: ForceLayout): [AgentId, AgentId] | null {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      if (dist3(layout.nodes[i].position, layout.nodes[j].position) < MIN_DISTANCE) {
        return [layout.nodes[i].agentId, layout.nodes[j].agentId]
      }
    }
  }
  return null
}

/**
 * Check a {@link ForceLayout} against the model it was derived from. Covers
 * structure (one node per agent, canonical order, uniqueness), geometry
 * (finite, distinct positions; bounds enclose the cloud and `radius` is the
 * farthest node), provenance (the seed and the link topology both derive from
 * the trace) and the degenerate case (a 0/1-agent run never relaxes).
 */
export function checkLayoutInvariants(
  model: TraceModel,
  layout: ForceLayout,
  options: LayoutInvariantOptions = {},
): InvariantViolation[] {
  const out: InvariantViolation[] = []
  const expectedIds = canonicalAgentIds(model)
  checkIndexById(
    out,
    'layout-node',
    expectedIds,
    layout.nodes.map((node) => node.agentId),
  )

  for (const node of layout.nodes) {
    const { x, y, z } = node.position
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      push(out, 'layout-node-finite', `node ${node.agentId} has a non-finite position`)
    }
  }

  const coincident = firstCoincidentPair(layout)
  if (coincident !== null) {
    push(
      out,
      'layout-nodes-distinct',
      `nodes ${coincident[0]} and ${coincident[1]} coincide (repulsion should separate them)`,
    )
  }

  const seed = options.seed ?? model.seed
  if (layout.seed !== seed) {
    push(out, 'layout-seed', `layout seed is ${layout.seed}, expected ${seed}`)
  }

  if (!Number.isInteger(layout.iterations) || layout.iterations < 0) {
    push(
      out,
      'layout-iterations',
      `iterations ${layout.iterations} is not a non-negative integer`,
    )
  } else if (expectedIds.length < 2 && layout.iterations !== 0) {
    push(
      out,
      'layout-iterations-degenerate',
      `a ${expectedIds.length}-agent run relaxed ${layout.iterations} times (should be 0)`,
    )
  }

  if (!Number.isFinite(layout.energy) || layout.energy < 0) {
    push(out, 'layout-energy', `energy ${layout.energy} is not finite and non-negative`)
  }

  // Bounds must enclose every node; center is the midpoint; radius is farthest.
  const { min, max, center, radius } = layout.bounds
  for (const node of layout.nodes) {
    const { x, y, z } = node.position
    if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) {
      push(out, 'layout-bounds-enclose', `node ${node.agentId} lies outside the bounds`)
      break
    }
  }
  const midX = (min.x + max.x) / 2
  const midY = (min.y + max.y) / 2
  const midZ = (min.z + max.z) / 2
  if (
    Math.abs(center.x - midX) > EPSILON ||
    Math.abs(center.y - midY) > EPSILON ||
    Math.abs(center.z - midZ) > EPSILON
  ) {
    push(out, 'layout-bounds-center', 'bounds.center is not the midpoint of min/max')
  }
  let farthest = 0
  for (const node of layout.nodes) {
    farthest = Math.max(farthest, dist3(node.position, center))
  }
  if (Math.abs(radius - farthest) > EPSILON) {
    push(
      out,
      'layout-bounds-radius',
      `bounds.radius ${radius} is not the farthest node (${farthest})`,
    )
  }

  // The link topology must BE deriveLayoutLinks(model) — never authored.
  const expectedLinks = deriveLayoutLinks(model)
  if (JSON.stringify(layout.links) !== JSON.stringify(expectedLinks)) {
    push(
      out,
      'layout-links-derived',
      'layout links differ from deriveLayoutLinks(model)',
    )
  }

  const agentSet = new Set(expectedIds)
  const seenLinks = new Set<string>()
  for (const link of layout.links) {
    if (
      link.source === link.target ||
      !agentSet.has(link.source) ||
      !agentSet.has(link.target) ||
      !(link.weight >= 1)
    ) {
      push(
        out,
        'layout-link-valid',
        `link ${link.source} → ${link.target} (weight ${link.weight}) is invalid`,
      )
    }
    const key = `${link.source}\u0000${link.target}`
    if (seenLinks.has(key)) {
      push(out, 'layout-link-unique', `duplicate link ${link.source} → ${link.target}`)
    }
    seenLinks.add(key)
  }
  for (let i = 1; i < layout.links.length; i += 1) {
    const a = layout.links[i - 1]
    const b = layout.links[i]
    if (
      compareModelIds(a.source, b.source) > 0 ||
      (a.source === b.source && compareModelIds(a.target, b.target) > 0)
    ) {
      push(
        out,
        'layout-links-sorted',
        `layout links out of canonical order at index ${i}`,
      )
      break
    }
  }

  return out
}

// ── Attribute invariants ────────────────────────────────────────────────────

/** Optional overrides for {@link checkAttributeInvariants}. Mirror the mapper. */
export interface AttributeInvariantOptions {
  minNodeSize?: number
  maxNodeSize?: number
  minEmissive?: number
  maxEmissive?: number
  minArcWidth?: number
  maxArcWidth?: number
}

/**
 * Check a {@link TraceAttributes} mapping against the model it was derived
 * from: node structure, activity that re-derives from the model's own counts,
 * intensities in `[0, 1]` mapped monotonically into the configured range, arcs
 * that mirror the layout's links, recorded spans that are the true spans, and
 * the neutral fallback for a channel with no spread.
 */
export function checkAttributeInvariants(
  model: TraceModel,
  attributes: TraceAttributes,
  options: AttributeInvariantOptions = {},
): InvariantViolation[] {
  const out: InvariantViolation[] = []
  const minNodeSize = options.minNodeSize ?? DEFAULT_MIN_NODE_SIZE
  const maxNodeSize = options.maxNodeSize ?? DEFAULT_MAX_NODE_SIZE
  const minEmissive = options.minEmissive ?? DEFAULT_MIN_EMISSIVE
  const maxEmissive = options.maxEmissive ?? DEFAULT_MAX_EMISSIVE
  const minArcWidth = options.minArcWidth ?? DEFAULT_MIN_ARC_WIDTH
  const maxArcWidth = options.maxArcWidth ?? DEFAULT_MAX_ARC_WIDTH

  const expectedIds = canonicalAgentIds(model)
  checkIndexById(
    out,
    'attr-node',
    expectedIds,
    attributes.nodes.map((node) => node.agentId),
  )

  const agentById = new Map(model.agents.map((agent) => [agent.id, agent]))
  const toolCallsByAgent = new Map<AgentId, number>()
  for (const call of model.toolCalls) {
    toolCallsByAgent.set(call.agentId, (toolCallsByAgent.get(call.agentId) ?? 0) + 1)
  }

  const totals: number[] = []
  for (const node of attributes.nodes) {
    const { activity } = node
    const agent = agentById.get(node.agentId)
    if (agent === undefined) {
      push(out, 'attr-node-unknown', `no model agent for node ${node.agentId}`)
      continue
    }
    if (activity.messagesSent !== agent.messagesSent) {
      push(
        out,
        'attr-activity-sent',
        `${node.agentId} sent ${activity.messagesSent}, model says ${agent.messagesSent}`,
      )
    }
    if (activity.messagesReceived !== agent.messagesReceived) {
      push(
        out,
        'attr-activity-received',
        `${node.agentId} received ${activity.messagesReceived}, model says ${agent.messagesReceived}`,
      )
    }
    const toolCalls = toolCallsByAgent.get(node.agentId) ?? 0
    if (activity.toolCalls !== toolCalls) {
      push(
        out,
        'attr-activity-toolcalls',
        `${node.agentId} has ${activity.toolCalls} tool calls, model says ${toolCalls}`,
      )
    }
    if (
      activity.total !==
      activity.messagesSent + activity.messagesReceived + activity.toolCalls
    ) {
      push(out, 'attr-activity-total', `${node.agentId} total does not sum its parts`)
    }
    totals.push(activity.total)

    if (!(node.intensity >= 0 && node.intensity <= 1)) {
      push(
        out,
        'attr-node-intensity-range',
        `${node.agentId} intensity ${node.intensity} ∉ [0, 1]`,
      )
    }
    if (node.size < minNodeSize - EPSILON || node.size > maxNodeSize + EPSILON) {
      push(out, 'attr-node-size-range', `${node.agentId} size ${node.size} ∉ range`)
    }
    if (
      node.emissive < minEmissive - EPSILON ||
      node.emissive > maxEmissive + EPSILON
    ) {
      push(
        out,
        'attr-emissive-range',
        `${node.agentId} emissive ${node.emissive} ∉ range`,
      )
    }
  }

  // More activity must never read smaller or dimmer.
  for (let i = 0; i < attributes.nodes.length; i += 1) {
    for (let j = i + 1; j < attributes.nodes.length; j += 1) {
      const a = attributes.nodes[i]
      const b = attributes.nodes[j]
      if (a.activity.total > b.activity.total && a.intensity < b.intensity) {
        push(
          out,
          'attr-node-monotone',
          `${a.agentId} is busier than ${b.agentId} but reads dimmer`,
        )
      }
    }
  }

  const activitySpan = spanOf(totals)
  if (
    attributes.activityRange.min !== activitySpan.min ||
    attributes.activityRange.max !== activitySpan.max
  ) {
    push(
      out,
      'attr-activity-range',
      `activityRange {${attributes.activityRange.min},${attributes.activityRange.max}} ` +
        `is not the true span {${activitySpan.min},${activitySpan.max}}`,
    )
  }
  if (activitySpan.max <= activitySpan.min) {
    for (const node of attributes.nodes) {
      if (Math.abs(node.intensity - NEUTRAL_INTENSITY) > EPSILON) {
        push(out, 'attr-neutral', `${node.agentId} has no spread but is not neutral`)
      }
    }
  }

  // Arcs mirror the layout's links; width is in range; volume span is true.
  const expectedLinks = deriveLayoutLinks(model)
  const projected = attributes.links.map((link) => ({
    source: link.source,
    target: link.target,
    volume: link.volume,
  }))
  const expectedProjected = expectedLinks.map((link) => ({
    source: link.source,
    target: link.target,
    volume: link.weight,
  }))
  if (JSON.stringify(projected) !== JSON.stringify(expectedProjected)) {
    push(out, 'attr-links-derived', 'arcs differ from deriveLayoutLinks(model)')
  }

  const volumes: number[] = []
  for (const link of attributes.links) {
    volumes.push(link.volume)
    if (!(link.intensity >= 0 && link.intensity <= 1)) {
      push(
        out,
        'attr-link-intensity-range',
        `${link.source} → ${link.target} intensity ${link.intensity} ∉ [0, 1]`,
      )
    }
    if (link.width < minArcWidth - EPSILON || link.width > maxArcWidth + EPSILON) {
      push(
        out,
        'attr-link-width-range',
        `${link.source} → ${link.target} width ∉ range`,
      )
    }
  }
  const volumeSpan = spanOf(volumes)
  if (
    attributes.volumeRange.min !== volumeSpan.min ||
    attributes.volumeRange.max !== volumeSpan.max
  ) {
    push(
      out,
      'attr-volume-range',
      `volumeRange {${attributes.volumeRange.min},${attributes.volumeRange.max}} ` +
        `is not the true span {${volumeSpan.min},${volumeSpan.max}}`,
    )
  }
  if (volumeSpan.max <= volumeSpan.min) {
    for (const link of attributes.links) {
      if (Math.abs(link.intensity - NEUTRAL_INTENSITY) > EPSILON) {
        push(
          out,
          'attr-neutral',
          `arc ${link.source} → ${link.target} has no spread but is not neutral`,
        )
      }
    }
  }

  return out
}

// ── Edge invariants ─────────────────────────────────────────────────────────

/** Intra-instant edge-kind priority (mirrors `EDGE_RANK` in `./edges.ts`). */
function edgeRank(kind: EdgeKind): number {
  return EDGE_KINDS.indexOf(kind)
}

/**
 * Check a {@link EdgeModel} against the model it was derived from: the edge list
 * partitions into `byKind` with agreeing counts; edges are in canonical order;
 * every edge re-derives from the messages it aggregates (weight, ids, actions,
 * direction, timestamps, classification); and the spawn lineage is a coherent
 * forest — real, acyclic parents, consistent `childIds`/`fanOut`/`maxFanOut`/
 * `rootIds`, and a `role` that re-derives from the documented rule.
 */
export function checkEdgeInvariants(
  model: TraceModel,
  edgeModel: EdgeModel,
): InvariantViolation[] {
  const out: InvariantViolation[] = []
  const expectedIds = canonicalAgentIds(model)
  const agentSet = new Set(expectedIds)

  // ── Partition + counts ──
  for (const kind of EDGE_KINDS) {
    const group = edgeModel.byKind[kind]
    const filtered = edgeModel.edges.filter((edge) => edge.kind === kind)
    if (JSON.stringify(group) !== JSON.stringify(filtered)) {
      push(out, 'edge-partition', `byKind.${kind} differs from the filtered edge list`)
    }
    if (edgeModel.counts[kind] !== group.length) {
      push(
        out,
        'edge-count',
        `counts.${kind} is ${edgeModel.counts[kind]} but the group holds ${group.length}`,
      )
    }
  }
  const totalCount = EDGE_KINDS.reduce((sum, kind) => sum + edgeModel.counts[kind], 0)
  if (totalCount !== edgeModel.edges.length) {
    push(
      out,
      'edge-count-total',
      `counts sum to ${totalCount}, edges has ${edgeModel.edges.length}`,
    )
  }

  // ── Canonical order: kind rank, then source, then target ──
  for (let i = 1; i < edgeModel.edges.length; i += 1) {
    const a = edgeModel.edges[i - 1]
    const b = edgeModel.edges[i]
    const order =
      edgeRank(a.kind) - edgeRank(b.kind) ||
      compareModelIds(a.source, b.source) ||
      compareModelIds(a.target, b.target)
    if (order > 0) {
      push(out, 'edge-order', `edges out of canonical order at index ${i}`)
      break
    }
  }

  const messageById = new Map(model.messages.map((message) => [message.id, message]))

  // ── Each edge re-derives from its backing messages ──
  for (const edge of edgeModel.edges) {
    if (edge.weight !== edge.messageIds.length || edge.weight < 1) {
      push(
        out,
        'edge-weight',
        `edge ${edge.source} → ${edge.target} weight ${edge.weight} ≠ ${edge.messageIds.length} message ids`,
      )
    }
    if (new Set(edge.messageIds).size !== edge.messageIds.length) {
      push(
        out,
        'edge-message-ids-unique',
        `edge ${edge.source} → ${edge.target} repeats a message id`,
      )
    }
    if (edge.source === edge.target) {
      push(out, 'edge-self', `edge ${edge.source} → ${edge.target} is a self-edge`)
    }
    if (!agentSet.has(edge.source) || !agentSet.has(edge.target)) {
      push(
        out,
        'edge-endpoints',
        `edge ${edge.source} → ${edge.target} names an unknown agent`,
      )
    }

    let firstAt = Infinity
    let lastAt = -Infinity
    const actions = new Set<string>()
    let resolved = 0
    for (const id of edge.messageIds) {
      const message = messageById.get(id)
      if (message === undefined) {
        push(
          out,
          'edge-message-resolves',
          `edge ${edge.source} → ${edge.target} references unknown message ${id}`,
        )
        continue
      }
      resolved += 1
      const kind = classifyAction(message.action)
      if (kind !== edge.kind) {
        push(
          out,
          'edge-classification',
          `message ${message.id} classifies as ${kind} but the edge is ${edge.kind}`,
        )
      }
      if (
        message.from !== edge.source ||
        (message.to !== null && message.to !== edge.target)
      ) {
        push(
          out,
          'edge-backing-direction',
          `message ${message.id} does not run ${edge.source} → ${edge.target}`,
        )
      }
      if (message.at < firstAt) firstAt = message.at
      if (message.at > lastAt) lastAt = message.at
      if (message.action !== null) actions.add(message.action)
    }

    if (resolved > 0) {
      if (edge.firstAt !== firstAt) {
        push(
          out,
          'edge-first-at',
          `edge ${edge.source} → ${edge.target} firstAt ${edge.firstAt} ≠ ${firstAt}`,
        )
      }
      if (edge.lastAt !== lastAt) {
        push(
          out,
          'edge-last-at',
          `edge ${edge.source} → ${edge.target} lastAt ${edge.lastAt} ≠ ${lastAt}`,
        )
      }
      const expectedActions = [...actions].sort(compareModelIds)
      if (JSON.stringify(edge.actions) !== JSON.stringify(expectedActions)) {
        push(
          out,
          'edge-actions',
          `edge ${edge.source} → ${edge.target} actions do not match its backing messages`,
        )
      }
    }
  }

  // ── Lineage ──
  checkIndexById(
    out,
    'edge-agent',
    expectedIds,
    edgeModel.agents.map((lineage) => lineage.agentId),
  )

  const spawnChildren = new Map<AgentId, AgentId[]>()
  for (const edge of edgeModel.byKind.spawn) {
    const kids = spawnChildren.get(edge.source)
    if (kids === undefined) spawnChildren.set(edge.source, [edge.target])
    else kids.push(edge.target)
  }

  const parentOf = new Map<AgentId, AgentId>()
  for (const lineage of edgeModel.agents) {
    if (lineage.parentId !== null) parentOf.set(lineage.agentId, lineage.parentId)
  }

  for (const lineage of edgeModel.agents) {
    if (lineage.parentId !== null) {
      if (!agentSet.has(lineage.parentId) || lineage.parentId === lineage.agentId) {
        push(
          out,
          'edge-parent-real',
          `${lineage.agentId} has bogus parent ${lineage.parentId}`,
        )
      }
    }
    const expectedChildren = [...(spawnChildren.get(lineage.agentId) ?? [])].sort(
      compareModelIds,
    )
    if (JSON.stringify(lineage.childIds) !== JSON.stringify(expectedChildren)) {
      push(
        out,
        'edge-children',
        `${lineage.agentId} childIds do not match its spawn edges`,
      )
    }
    if (lineage.fanOut !== lineage.childIds.length) {
      push(
        out,
        'edge-fanout',
        `${lineage.agentId} fanOut ${lineage.fanOut} ≠ ${lineage.childIds.length} children`,
      )
    }
  }

  // Acyclic: following parentId from any agent must terminate.
  for (const start of parentOf.keys()) {
    const seen = new Set<AgentId>()
    let current: AgentId | undefined = start
    while (current !== undefined) {
      if (seen.has(current)) {
        push(out, 'edge-acyclic', `spawn cycle through agent ${current}`)
        break
      }
      seen.add(current)
      current = parentOf.get(current)
    }
  }

  const expectedRoots = edgeModel.agents
    .filter((lineage) => lineage.parentId === null)
    .map((lineage) => lineage.agentId)
  if (JSON.stringify(edgeModel.rootIds) !== JSON.stringify(expectedRoots)) {
    push(out, 'edge-roots', 'rootIds do not match the agents with no parent')
  }

  const maxFanOut = edgeModel.agents.reduce(
    (max, lineage) => Math.max(max, lineage.fanOut),
    0,
  )
  if (edgeModel.maxFanOut !== maxFanOut) {
    push(out, 'edge-max-fanout', `maxFanOut ${edgeModel.maxFanOut} ≠ ${maxFanOut}`)
  }

  // ── Role re-derives from the documented rule ──
  const messages = [...model.messages].sort(
    (a, b) => a.at - b.at || compareModelIds(a.id, b.id),
  )
  const origin: AgentId | null = messages.length > 0 ? messages[0].from : null
  const outDegree = new Map<AgentId, number>()
  const inDegree = new Map<AgentId, number>()
  for (const edge of edgeModel.edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }
  for (const lineage of edgeModel.agents) {
    const outgoing = outDegree.get(lineage.agentId) ?? 0
    const incoming = inDegree.get(lineage.agentId) ?? 0
    let role: AgentRole
    if (lineage.childIds.length > 0) role = 'coordinator'
    else if (lineage.parentId !== null) role = 'worker'
    else if (lineage.agentId === origin) role = 'coordinator'
    else if (outgoing > 0 || incoming > 0) role = 'worker'
    else role = 'unknown'
    if (lineage.role !== role) {
      push(
        out,
        'edge-role',
        `${lineage.agentId} role is ${lineage.role}, expected ${role}`,
      )
    }
  }

  return out
}

// ── The whole pipeline ──────────────────────────────────────────────────────

/**
 * Check the entire M2 layer for one model, end to end: settle the layout, map
 * the visual attributes and derive the edge model, then run all three checks.
 * This is the M2 exit criteria in one call — "same trace → byte-identical
 * layout; layout settles without jitter; every node position and visual
 * attribute derives from trace data" — expressed as data.
 *
 * @param model a normalized trace (M1-T5).
 * @param options settlement options (iteration cap, cooling, tolerance, seed).
 */
export function checkSceneInvariants(
  model: TraceModel,
  options: SettlementOptions = {},
): InvariantViolation[] {
  const { layout } = settleLayout(model, options)
  return [
    ...checkLayoutInvariants(model, layout, { seed: options.seed }),
    ...checkAttributeInvariants(model, mapTraceAttributes(model)),
    ...checkEdgeInvariants(model, deriveEdgeModel(model)),
  ]
}

// ── Hand-authored coordinate scan (machine gate) ────────────────────────────

/** A 3D coordinate constructor: `new Vector3(…)`, `new Euler(…)`, … */
const COORDINATE_CTOR =
  /\bnew\s+(?:Vector2|Vector3|Vector4|Euler|Quaternion|Matrix4)\s*\(/g

/** A `position:`/`position =` field bound to a numeric array or `{ x: …`. */
const POSITION_LITERAL = /\bposition\s*[:=]\s*(?:\{\s*x\s*:\s*-?[\d.]|\[\s*-?[\d.])/g

/** A literal `{ x: …, y: …, z: … }` triple. */
const TRIPLE_LITERAL =
  /\{\s*x\s*:\s*(-?[\d.]+)\s*,\s*y\s*:\s*(-?[\d.]+)\s*,\s*z\s*:\s*(-?[\d.]+)\s*\}/g

/**
 * Scan a module's source text for a **hand-authored coordinate** — a hard-coded
 * position that did not come from the trace. This is the data-layer half of the
 * M2 machine gate ("no hand-authored coordinates anywhere in `src/`").
 *
 * Flags (after stripping comments, so the prose in a doc block cannot trip it):
 *
 * 1. a 3D coordinate constructor — `new Vector3(…)` and friends (the data layer
 *    has no business building three.js vectors);
 * 2. a `position:`/`position =` field bound to a numeric array or `{ x: …`
 *    object literal (`position: [1.2, 0, 3]`, `position: { x: 1 }`);
 * 3. a literal `{ x, y, z }` triple with **at least one non-zero** component —
 *    a symbolically-zero origin (`{ x: 0, y: 0, z: 0 }`) is a sentinel, not a
 *    placed node, so it is allowed; anything with a real coordinate is not.
 *
 * Returns the offending snippets (empty ⇒ clean). Pure: it reads only `source`.
 */
export function findHandAuthoredCoordinates(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const found: string[] = []
  for (const match of code.matchAll(COORDINATE_CTOR)) found.push(match[0])
  for (const match of code.matchAll(POSITION_LITERAL)) found.push(match[0])
  for (const match of code.matchAll(TRIPLE_LITERAL)) {
    const nonZero = match.slice(1, 4).some((value) => Number(value) !== 0)
    if (nonZero) found.push(match[0])
  }
  return found
}
