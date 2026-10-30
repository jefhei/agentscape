/**
 * The real `debian2_bot` fleet run — the node-importable half (M5-T3 → M5-T4).
 *
 * The snapshot's loader lives next door in `fleetExport.ts`, which reads the
 * committed JSON with Vite's `?raw` import: that makes it a *bundler* module, so
 * it cannot be imported by a probe running under `node --experimental-strip-types`
 * (the M5-T2 profiling script is one, and M5-T4's criterion report is another).
 *
 * So the split is by dependency, not by topic: everything that is a pure function
 * of rows lives here — the provenance constants, the export summary, and
 * {@link buildFleetRun}, which is the **only** way the real run is built (adapter
 * M1-T4 → normalizer M1-T5, so the dogfood cannot drift from what a user's own
 * export takes). `fleetExport.ts` adds the `?raw` bytes and the module-level
 * `FLEET_RUN` singleton on top, and re-exports this file, so the public surface is
 * unchanged.
 */

import type { AgentMessageRow } from '../../adapter/index.ts'
import { decodePayload, parseAgentMessagesExport } from '../../adapter/index.ts'
import { normalizeTrace } from '../../model/index.ts'
import type { TraceModel } from '../../model/index.ts'

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
  rows: readonly AgentMessageRow[],
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

  return {
    rows: rows.length,
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
export function buildFleetRun(rows: readonly AgentMessageRow[]): TraceModel {
  return normalizeTrace(
    parseAgentMessagesExport(rows, {
      label: FLEET_RUN_LABEL,
    }),
  )
}
