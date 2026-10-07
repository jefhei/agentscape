/**
 * Deterministic synthetic trace fixtures (M1-T6).
 *
 * Four hand-built runs, one per structural shape the product is about — the
 * shapes the PRD names: a **fan-out**, a **loop** (a sub-agent pair that keeps
 * going), a **dead branch** (a worker that takes work and never answers) and a
 * **handoff chain** (a linear relay). Downstream tasks lay these out (M2),
 * render them (M3) and use them as the reference runs for the "3D earns its
 * keep" comparison (M5).
 *
 * Two rules shape this module:
 *
 * 1. **They are real exports, not hand-built `Run`s.** Each fixture is a
 *    synthetic `agent_messages` row list (the ONE v1 ingest format) fed
 *    through the real two-stage pipeline — `parseAgentMessagesExport` (M1-T4)
 *    then `normalizeTrace` (M1-T5) — so a fixture exercises exactly the path a
 *    recorded export takes and cannot drift from it. Nothing is hand-placed:
 *    the shape lives entirely in the message graph, which is what the derived
 *    edge model (M2-T4) will read. Every `Agent.role` is therefore `'unknown'`
 *    and every `Agent.parentId` is `null` here, exactly as the adapter leaves
 *    them today.
 * 2. **They are deterministic, down to the byte.** Every id, timestamp and
 *    body is a constant and every timestamp is measured from one fixed epoch
 *    ({@link FIXTURE_EPOCH_MS}) — no clock, no randomness — so building the
 *    same fixture twice yields byte-identical rows and a byte-identical
 *    `TraceModel`. That is the property PRD §5 (and the layout's
 *    reproducibility) rests on. The run `seed` is left content-derived, never
 *    authored.
 *
 * Pure by construction — no DOM, no three.js, no clock — so it is safe to
 * import from anywhere and fully testable in jsdom.
 */

import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'

// ── Public shapes ───────────────────────────────────────────────────────────

/** The four structural shapes M1-T6 pins, one fixture each. */
export type FixtureShape = 'fan-out' | 'loop' | 'dead-branch' | 'handoff-chain'

/** The shapes in their stable, documented order (the registry iterates this). */
export const FIXTURE_SHAPES: readonly FixtureShape[] = [
  'fan-out',
  'loop',
  'dead-branch',
  'handoff-chain',
]

/**
 * A synthetic run and the export it was built from. `rows` is the raw,
 * deterministic `agent_messages` export; `run` is what the real ingest path
 * produces from it (`normalizeTrace(parseAgentMessagesExport(rows))`).
 */
export interface TraceFixture {
  shape: FixtureShape
  /** Short human label, e.g. `Fan-out`. */
  title: string
  /** What structural fact this run is built to expose. */
  description: string
  /** The synthetic export, in canonical ascending-id order. */
  rows: readonly AgentMessageRow[]
  /** The normalized run the real pipeline produces from `rows`. */
  run: TraceModel
}

/**
 * Fixed epoch every fixture is timed from: `2026-10-01T09:00:00.000Z`. Using a
 * constant (rather than `Date.now()`) is what makes the fixtures byte-stable;
 * a test asserts each run starts here, which is the no-clock guarantee.
 */
export const FIXTURE_EPOCH_MS = Date.parse('2026-10-01T09:00:00.000Z')

const MINUTE = 60_000

/** ISO-8601 UTC string at a fixed offset from the fixture epoch. */
function isoAt(offsetMs: number): string {
  return new Date(FIXTURE_EPOCH_MS + offsetMs).toISOString()
}

// ── Row definition → concrete export ────────────────────────────────────────

/** One synthetic `agent_messages` row, before it is rendered to raw JSON. */
interface MessageDef {
  id: number
  from: string
  /** Receiving agent, or `null` for a broadcast. */
  to: string | null
  /** Milliseconds after {@link FIXTURE_EPOCH_MS}. */
  atOffsetMs: number
  subject: string
  /** Structured body; omitted rows get `body: null` (a bare message). */
  payload?: Record<string, unknown>
  /** Delivery state; defaults to `unread`. */
  status?: 'unread' | 'read'
}

/** Render one definition to the export row the adapter consumes. */
function toRow(def: MessageDef): AgentMessageRow {
  return {
    id: def.id,
    from_agent: def.from,
    to_agent: def.to,
    subject: def.subject,
    body: def.payload === undefined ? null : JSON.stringify(def.payload),
    status: def.status ?? 'unread',
    created_at: isoAt(def.atOffsetMs),
  }
}

// ── The four runs ───────────────────────────────────────────────────────────

/**
 * **Fan-out** — one orchestrator assigns to five distinct workers and nothing
 * comes back. Six agents, five messages, widest out-degree in the fixture set:
 * the shape behind the PRD's "which parent spawned how many children?".
 */
const FAN_OUT: readonly MessageDef[] = [
  {
    id: 1001,
    from: 'orchestrator',
    to: 'worker_alpha',
    atOffsetMs: 0,
    subject: 'Assign task: alpha',
    payload: { action: 'assign_task', worker: 'alpha' },
  },
  {
    id: 1002,
    from: 'orchestrator',
    to: 'worker_beta',
    atOffsetMs: MINUTE,
    subject: 'Assign task: beta',
    payload: { action: 'assign_task', worker: 'beta' },
  },
  {
    id: 1003,
    from: 'orchestrator',
    to: 'worker_gamma',
    atOffsetMs: 2 * MINUTE,
    subject: 'Assign task: gamma',
    payload: { action: 'assign_task', worker: 'gamma' },
  },
  {
    id: 1004,
    from: 'orchestrator',
    to: 'worker_delta',
    atOffsetMs: 3 * MINUTE,
    subject: 'Assign task: delta',
    payload: { action: 'assign_task', worker: 'delta' },
  },
  {
    id: 1005,
    from: 'orchestrator',
    to: 'worker_epsilon',
    atOffsetMs: 4 * MINUTE,
    subject: 'Assign task: epsilon',
    payload: { action: 'assign_task', worker: 'epsilon' },
  },
]

/**
 * **Loop** — a researcher and a critic bounce drafts and revisions back and
 * forth, three full cycles after a kickoff. The repeating edge between the
 * same two nodes is the "is something running away?" shape (§7).
 */
const LOOP: readonly MessageDef[] = [
  {
    id: 2001,
    from: 'orchestrator',
    to: 'researcher',
    atOffsetMs: 0,
    subject: 'Start research loop',
    payload: { action: 'start_loop', topic: 'kernel_headroom' },
    status: 'read',
  },
  {
    id: 2002,
    from: 'researcher',
    to: 'critic',
    atOffsetMs: MINUTE,
    subject: 'Draft cycle 1',
    payload: { action: 'draft', cycle: 1 },
    status: 'read',
  },
  {
    id: 2003,
    from: 'critic',
    to: 'researcher',
    atOffsetMs: 2 * MINUTE,
    subject: 'Revise cycle 1',
    payload: { action: 'revise', cycle: 1, verdict: 'revise' },
    status: 'read',
  },
  {
    id: 2004,
    from: 'researcher',
    to: 'critic',
    atOffsetMs: 3 * MINUTE,
    subject: 'Draft cycle 2',
    payload: { action: 'draft', cycle: 2 },
    status: 'read',
  },
  {
    id: 2005,
    from: 'critic',
    to: 'researcher',
    atOffsetMs: 4 * MINUTE,
    subject: 'Revise cycle 2',
    payload: { action: 'revise', cycle: 2, verdict: 'revise' },
    status: 'read',
  },
  {
    id: 2006,
    from: 'researcher',
    to: 'critic',
    atOffsetMs: 5 * MINUTE,
    subject: 'Draft cycle 3',
    payload: { action: 'draft', cycle: 3 },
    status: 'read',
  },
  {
    id: 2007,
    from: 'critic',
    to: 'researcher',
    atOffsetMs: 6 * MINUTE,
    subject: 'Revise cycle 3',
    payload: { action: 'revise', cycle: 3, verdict: 'revise' },
  },
]

/**
 * **Dead branch** — the orchestrator fans out to two workers; one completes,
 * the other takes its assignment and is never heard from again. The terminal
 * leaf (`worker_dead`: receives one message, sends none) is the shape behind
 * "a branch that went quiet".
 */
const DEAD_BRANCH: readonly MessageDef[] = [
  {
    id: 3001,
    from: 'orchestrator',
    to: 'worker_ok',
    atOffsetMs: 0,
    subject: 'Assign task: ok',
    payload: { action: 'assign_task', worker: 'ok' },
    status: 'read',
  },
  {
    id: 3002,
    from: 'worker_ok',
    to: 'orchestrator',
    atOffsetMs: MINUTE,
    subject: 'Task complete',
    payload: { action: 'task_complete', worker: 'ok', status: 'ok' },
  },
  {
    id: 3003,
    from: 'orchestrator',
    to: 'worker_dead',
    atOffsetMs: 2 * MINUTE,
    subject: 'Assign task: dead',
    payload: { action: 'assign_task', worker: 'dead' },
  },
]

/**
 * **Handoff chain** — a directed relay, `agent_a → agent_b → agent_c →
 * agent_d`, each link passing the baton to the next and nothing fanning out.
 * The linear-path shape (the counterpart to the fan-out).
 */
const HANDOFF_CHAIN: readonly MessageDef[] = [
  {
    id: 4001,
    from: 'agent_a',
    to: 'agent_b',
    atOffsetMs: 0,
    subject: 'Handoff a → b',
    payload: { action: 'handoff', from: 'agent_a', to: 'agent_b' },
    status: 'read',
  },
  {
    id: 4002,
    from: 'agent_b',
    to: 'agent_c',
    atOffsetMs: MINUTE,
    subject: 'Handoff b → c',
    payload: { action: 'handoff', from: 'agent_b', to: 'agent_c' },
    status: 'read',
  },
  {
    id: 4003,
    from: 'agent_c',
    to: 'agent_d',
    atOffsetMs: 2 * MINUTE,
    subject: 'Handoff c → d',
    payload: { action: 'handoff', from: 'agent_c', to: 'agent_d' },
  },
]

interface FixtureDefinition {
  shape: FixtureShape
  title: string
  description: string
  messages: readonly MessageDef[]
}

const DEFINITIONS: readonly FixtureDefinition[] = [
  {
    shape: 'fan-out',
    title: 'Fan-out',
    description:
      'One orchestrator assigns to five distinct workers, none of which reply — the widest out-degree in the fixture set.',
    messages: FAN_OUT,
  },
  {
    shape: 'loop',
    title: 'Loop',
    description:
      'A researcher and a critic bounce drafts and revisions back and forth for three cycles — a repeating edge between the same two nodes.',
    messages: LOOP,
  },
  {
    shape: 'dead-branch',
    title: 'Dead branch',
    description:
      'The orchestrator fans out to two workers; one completes, the other takes its assignment and never replies — a terminal leaf.',
    messages: DEAD_BRANCH,
  },
  {
    shape: 'handoff-chain',
    title: 'Handoff chain',
    description:
      'A directed relay agent_a → agent_b → agent_c → agent_d, each link handing the baton to the next.',
    messages: HANDOFF_CHAIN,
  },
]

const DEFINITION_BY_SHAPE = new Map(DEFINITIONS.map((def) => [def.shape, def]))

// ── The builder ─────────────────────────────────────────────────────────────

/**
 * Build one fixture: render its row definitions to a real `agent_messages`
 * export and run the real ingest path over it. Pure and deterministic — the
 * same `shape` always yields byte-identical rows and `run`. Returns a fresh
 * copy each call, so a caller may freely mutate the result.
 *
 * @throws Error when `shape` is not one of {@link FIXTURE_SHAPES} (defensive;
 *         the type already rules it out for TypeScript callers).
 */
export function buildFixture(shape: FixtureShape): TraceFixture {
  const definition = DEFINITION_BY_SHAPE.get(shape)
  if (definition === undefined) {
    throw new Error(`unknown fixture shape: ${String(shape)}`)
  }

  const rows = Object.freeze(definition.messages.map(toRow))

  return {
    shape: definition.shape,
    title: definition.title,
    description: definition.description,
    rows,
    run: normalizeTrace(
      parseAgentMessagesExport(rows, { label: `fixture: ${definition.title}` }),
    ),
  }
}

/**
 * The four fixtures, built once, in {@link FIXTURE_SHAPES} order. Treat these
 * as read-only shared instances; call {@link buildFixture} for a fresh copy to
 * mutate.
 */
export const FIXTURES: readonly TraceFixture[] = Object.freeze(
  FIXTURE_SHAPES.map(buildFixture),
)
