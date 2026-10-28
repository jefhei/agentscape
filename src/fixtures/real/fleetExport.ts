/**
 * The real `debian2_bot` fleet run — M5-T3, the dogfood.
 *
 * Every run AgentScape has rendered so far is synthetic: four minimal fixtures
 * (M1-T6) and one large generated scale run (M5-T1). Both are shaped by hand
 * (a fan-out, a loop, a ring of hubs), so neither can tell us whether the
 * product survives the trace reality produces. This module is one real
 * `agent_messages` export, captured from the pipeline's own coordination table
 * and committed as a snapshot:
 *
 *     src/fixtures/real/debian2-fleet.export.json   — 158 rows, verbatim but redacted
 *     scripts/capture-fleet-export.mjs              — the capture + redaction rules
 *
 * It follows the fixtures' one hard rule, and this is the point of the task: the
 * run is **not a hand-built `Run`**. The committed bytes are the *export*; the
 * run is what the real ingest path makes of them —
 * {@link parseAgentMessagesExport} (M1-T4) → {@link normalizeTrace} (M1-T5) — so
 * a dogfood run cannot drift from what a user's own export would produce.
 *
 * ## Why a snapshot rather than a fetch
 *
 * The app is 100% client-side with no backend (PRD §1), and the project's
 * determinism rule (PRD §5) means the same run must render the same shape for
 * everyone. A committed snapshot gives both, and it makes the real run available
 * to tests: `?trace=fleet` in {@link file://../trace/traceQuery.ts} mounts it, and
 * the scene assertions in `fleetExport.test.ts` lay it out for real. Refreshing
 * it is a deliberate act (`node scripts/capture-fleet-export.mjs`), not a
 * side effect of loading the page.
 *
 * ## What the real data says (measured, not assumed)
 *
 * - **10 agents, 158 messages, 118 tool calls, 5 broadcasts**, over **136 days**
 *   (2026-06-07 → 2026-10-21). Two agents do nearly all of the talking.
 * - **Identity fragmentation is real**: `hermes_bot`, `Host_hermes_bot`,
 *   `hermes_host2`, `herm_bot` and `rpi4_bot`/`Rpi4_bot` are the same hosts under
 *   different names, so the export renders six agents where the fleet has three.
 *   The scene shows this as a cluster of small, sparsely-connected nodes — a
 *   defect of the *data*, surfaced by the view, and NOT something the visualizer
 *   may paper over by merging names it cannot prove are one agent.
 * - **Traffic is strongly one-way**: 103 messages `hermes_bot → debian2_bot`
 *   against 33 the other way. That is the fan-out/imbalance shape the spatial
 *   view exists to show, and it is M5-T4's evidence.
 * - **The calendar is mostly empty**: the largest gap between messages is 23.6
 *   days, so scrubbing the run at a constant speed is mostly dead time. See
 *   `docs/fleet-run.md`; M5-T4/M5-T5 own what to do about it.
 */

import type { AgentMessageRow } from '../../adapter/index.ts'
import { decodePayload, parseAgentMessagesExport } from '../../adapter/index.ts'
import { normalizeTrace } from '../../model/index.ts'
import type { TraceModel } from '../../model/index.ts'
import rawExport from './debian2-fleet.export.json?raw'

/** The Supabase table this snapshot came from — the one format v1 ingests. */
export const FLEET_EXPORT_TABLE = 'agent_messages'

/** The agent identity that recorded the table (`debian2_bot`, this machine). */
export const FLEET_EXPORT_DATASET = 'debian2_bot'

/** The export's region, for provenance in a UI or a doc. */
export const FLEET_EXPORT_REGION = 'kgluqrkrxujjkcuwhuvo.supabase.co'

/** When the snapshot was captured (the table keeps growing; the file does not). */
export const FLEET_EXPORT_CAPTURED_AT = '2026-10-28'

/** The run's label — what the HUD and a probe see as the run's name. */
export const FLEET_RUN_LABEL = 'debian2_bot fleet — agent_messages export'

/**
 * The transformations the committed snapshot went through, in the order the
 * capture script applies them. Anything not listed here is byte-for-byte what
 * the table returned: the repo is public, the table is not.
 */
export const FLEET_EXPORT_REDACTIONS = [
  'credential values → [redacted] (the key itself never leaves the table)',
  'key-shaped text → [redacted-key]',
  'absolute home paths → ~ (no account name in a public repo)',
] as const

/**
 * The export, exactly as committed. Frozen: a run built from it must not be able
 * to change what the next build sees.
 */
export const FLEET_EXPORT_ROWS: readonly AgentMessageRow[] = Object.freeze(
  JSON.parse(rawExport) as AgentMessageRow[],
)

/**
 * What an `agent_messages` export contains, derived from the rows alone.
 *
 * Deliberately independent of the adapter and the normalizer: this is the "what
 * did we capture" half, so a test can compare it against the run the pipeline
 * produces (and a mismatch is a real disagreement about the data, not a
 * self-consistency check).
 */
export interface FleetExportSummary {
  /** Message rows in the export. */
  rows: number
  /** Distinct agent names, both senders and recipients, in canonical order. */
  agents: readonly string[]
  /** Rows whose `to_agent` is NULL — a broadcast to every other agent. */
  broadcasts: number
  /** Rows whose body is a JSON object carrying an `action`. */
  actionBodies: number
  /** Rows whose body is not a JSON object (free text / unparseable). */
  plainBodies: number
  /** Rows the capture script redacted (a credential, or a home path). */
  redactedRows: number
  /** Distinct `action` values, most frequent first, then alphabetically. */
  actions: readonly { action: string; count: number }[]
  /** First message, epoch ms. */
  firstAt: number
  /** Last message, epoch ms. */
  lastAt: number
  /** `lastAt - firstAt`, ms. */
  spanMs: number
}

/** `Date.parse` that rejects an unusable timestamp instead of yielding NaN. */
function epochOf(row: AgentMessageRow): number {
  const at = Date.parse(row.created_at)
  if (!Number.isFinite(at)) {
    throw new Error(`agent_messages row ${row.id} has an unparseable created_at`)
  }
  return at
}

/**
 * Summarize an export. Pure: a function of the rows only, no clock, no ordering
 * assumptions (the extremes are `min`/`max`, not "first" and "last").
 */
export function summarizeFleetExport(
  rows: readonly AgentMessageRow[] = FLEET_EXPORT_ROWS,
): FleetExportSummary {
  const agents = new Set<string>()
  const actions = new Map<string, number>()
  let broadcasts = 0
  let actionBodies = 0
  let plainBodies = 0
  let redactedRows = 0
  let firstAt = Infinity
  let lastAt = -Infinity

  for (const row of rows) {
    agents.add(row.from_agent)
    if (row.to_agent !== null && row.to_agent !== undefined) agents.add(row.to_agent)
    else broadcasts += 1

    const at = epochOf(row)
    if (at < firstAt) firstAt = at
    if (at > lastAt) lastAt = at

    const body = row.body ?? ''
    if (body.includes('[redacted]') || body.includes('[redacted-key]')) {
      redactedRows += 1
    }

    const payload = decodePayload(body)
    const action = payload === null ? null : payload.action
    if (typeof action === 'string' && action !== '') {
      actionBodies += 1
      actions.set(action, (actions.get(action) ?? 0) + 1)
    } else {
      plainBodies += 1
    }
  }

  const ordered = rows.length
  return {
    rows: ordered,
    agents: [...agents].sort(),
    broadcasts,
    actionBodies,
    plainBodies,
    redactedRows,
    actions: [...actions.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || (a.action < b.action ? -1 : 1)),
    firstAt: rows.length === 0 ? 0 : firstAt,
    lastAt: rows.length === 0 ? 0 : lastAt,
    spanMs: rows.length === 0 ? 0 : lastAt - firstAt,
  }
}

/**
 * Build the real run from the export through the real ingest path.
 *
 * The adapter derives ids, counts and the layout seed from the rows (M1-T4), the
 * normalizer re-derives every count and pins the canonical order (M1-T5), so the
 * result is byte-identical on every call and independent of the row order.
 */
export function buildFleetRun(
  rows: readonly AgentMessageRow[] = FLEET_EXPORT_ROWS,
): TraceModel {
  return normalizeTrace(
    parseAgentMessagesExport(rows, {
      label: FLEET_RUN_LABEL,
    }),
  )
}

/**
 * The run the app mounts for `?trace=fleet`.
 *
 * Built once at module load: the snapshot cannot change while a tab is open, so
 * there is nothing to invalidate, and a remount reuses the same object — which is
 * what lets the scene plan memoize on the run's identity (M3-T6).
 */
export const FLEET_RUN: TraceModel = buildFleetRun()
