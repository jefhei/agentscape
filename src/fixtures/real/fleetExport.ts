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
 * ## This file is the Vite half only
 *
 * `import rawExport from './debian2-fleet.export.json?raw'` is a *bundler*
 * import, so this module cannot be loaded by a probe running under
 * `node --experimental-strip-types`. Everything that is a pure function of rows
 * therefore lives in `fleetRows.ts` (M5-T4 needed it from a node script) and is
 * re-exported here, so the public surface — and every consumer — is unchanged.
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
import type { TraceModel } from '../../model/index.ts'
import { buildFleetRun as buildRunFromRows } from './fleetRows.ts'
import type { FleetExportSummary } from './fleetRows.ts'
import { summarizeFleetExport as summarizeRows } from './fleetRows.ts'
import rawExport from './debian2-fleet.export.json?raw'

export {
  FLEET_EXPORT_CAPTURED_AT,
  FLEET_EXPORT_DATASET,
  FLEET_EXPORT_REDACTIONS,
  FLEET_EXPORT_REGION,
  FLEET_EXPORT_TABLE,
  FLEET_RUN_LABEL,
} from './fleetRows.ts'

export type { FleetExportSummary } from './fleetRows.ts'

/**
 * The export, exactly as committed. Frozen: a run built from it must not be able
 * to change what the next build sees.
 */
export const FLEET_EXPORT_ROWS: readonly AgentMessageRow[] = Object.freeze(
  JSON.parse(rawExport) as AgentMessageRow[],
)

/**
 * Summarize an export — the committed snapshot by default, or the rows a caller
 * supplies (a test, or a re-capture comparison).
 */
export function summarizeFleetExport(
  rows: readonly AgentMessageRow[] = FLEET_EXPORT_ROWS,
): FleetExportSummary {
  return summarizeRows(rows)
}

/**
 * Build the run from an export — the committed snapshot by default, or the rows a
 * caller supplies. Either way it goes through the real ingest path (adapter M1-T4
 * → normalizer M1-T5), which is the rule the dogfood exists to enforce.
 */
export function buildFleetRun(
  rows: readonly AgentMessageRow[] = FLEET_EXPORT_ROWS,
): TraceModel {
  return buildRunFromRows(rows)
}

/**
 * The run the app mounts for `?trace=fleet`.
 *
 * Built once at module load: the snapshot cannot change while a tab is open, so
 * there is nothing to invalidate, and a remount reuses the same object — which is
 * what lets the scene plan memoize on the run's identity (M3-T6).
 */
export const FLEET_RUN = buildFleetRun(FLEET_EXPORT_ROWS)
