/**
 * A large synthetic run for the scale probes (M5-T1).
 *
 * The four fixtures (M1-T6) are *semantic* — each one is built to expose a
 * structural fact (fan-out, loop, dead branch, handoff chain) and has a handful
 * of agents. The scale task needs the opposite: a run with **thousands of
 * agents** whose only interesting property is its size, so the scene build, the
 * draw-call budget and the level-of-detail ladders can be measured at the far
 * end of their range.
 *
 * It follows the fixtures' one hard rule: a synthetic run is **never a
 * hand-built `Run`**. This module writes an `agent_messages` row list and runs it
 * through the real pipeline ({@link parseAgentMessagesExport} → {@link
 * normalizeTrace}), so a scaled run cannot drift from what the adapter really
 * accepts — the shape lives entirely in the message graph, exactly as it does
 * for a recorded export.
 *
 * ## The topology, and why it is not a ring
 *
 * A pure ring gives every agent degree 2 and no hierarchy, which is a poor
 * stand-in for a fleet: real runs have hubs (an orchestrator that talks to many
 * workers) and a long tail of leaf workers. The builder therefore lays agents
 * out as a **shallow fan-out tree over a ring of hubs**:
 *
 * - every `FAN_OUT`-th agent is a hub; each hub addresses the next
 *   `FAN_OUT - 1` agents as its workers (spawn-ish `assign_task` messages), so
 *   the graph has hubs, leaves and per-agent fan-out — the structure the spatial
 *   view is supposed to make legible at any size;
 * - every agent also sends its own `report_status` messages to its hub, so hubs
 *   carry most of the traffic (the volume imbalance a real fleet shows).
 *
 * Both are *derived* from the agent index — no randomness and no clock — so the
 * same options always build a byte-identical run, which is what lets a scale test
 * assert determinism rather than merely tolerate it.
 */

import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'

/** Fixed epoch every scaled run is timed from — no clock, no `Date.now()`. */
export const SCALE_EPOCH_MS = Date.parse('2026-10-01T09:00:00.000Z')

/** Workers per hub, in agents. A hub fans out to this many leaves. */
export const FAN_OUT = 12

/** One millisecond between messages, so the run has a real span to scrub. */
const MESSAGE_INTERVAL_MS = 250

/** Options for {@link buildScaleRun}. */
export interface ScaleRunOptions {
  /** How many agents the run has — the scene's node count. */
  agents: number
  /**
   * Messages each worker sends to its hub, in addition to the hub's own
   * assignment messages. `1` (the default) keeps the run's size roughly linear
   * in the agent count; the scale probe raises it to put pressure on the arc
   * and glyph layers.
   */
  messagesPerAgent?: number
  /** Run label; defaults to a label naming the agent count. */
  label?: string
}

/** The synthetic export plus the normalized run — both, so a probe can inspect either. */
export interface ScaleRun {
  /** The `agent_messages` rows the run was built from. */
  rows: AgentMessageRow[]
  /** The normalized run the real ingest pipeline produced. */
  run: TraceModel
  /** Agents requested (the run's own `meta.agentCount` is the authority once built). */
  agents: number
}

/** Canonical agent id for index `index` — `agent_0000`, `agent_0001`, … */
export function scaleAgentId(index: number): string {
  return `agent_${String(index).padStart(4, '0')}`
}

/** The hub an agent belongs to: every `FAN_OUT`-th agent is itself a hub. */
export function scaleHubIndex(index: number): number {
  return index - (index % FAN_OUT)
}

/**
 * Build a scaled run: `agents` agents, each hub fanning out to its workers and
 * each worker reporting back. Deterministic — the row order, ids, timestamps and
 * payloads are all functions of the options.
 *
 * Pure: it writes a fresh row array and never touches a clock. A degenerate
 * request (`agents <= 0`) yields an empty run, which is a legitimate degenerate
 * scene rather than an error.
 *
 * @throws TraceParseError never for a well-formed request — the rows this
 *         builder emits are validated by the real adapter like any other export.
 */
export function buildScaleRun(options: ScaleRunOptions): ScaleRun {
  const agents = Math.max(0, Math.floor(options.agents))
  const messagesPerAgent = Math.max(1, Math.floor(options.messagesPerAgent ?? 1))
  const rows: AgentMessageRow[] = []
  let id = 1

  /** Append one row, timed by its own id so the run is strictly ordered. */
  const push = (
    from: string,
    to: string | null,
    action: string,
    payload: Record<string, unknown> = {},
  ): void => {
    rows.push({
      id,
      from_agent: from,
      to_agent: to,
      subject: action,
      body: JSON.stringify({ action, ...payload }),
      status: 'read',
      created_at: new Date(SCALE_EPOCH_MS + id * MESSAGE_INTERVAL_MS).toISOString(),
    })
    id += 1
  }

  for (let index = 0; index < agents; index += 1) {
    const self = scaleAgentId(index)
    const hub = scaleHubIndex(index)
    const isHub = hub === index

    if (isHub) {
      // The hub's coordination act: assign each of its workers a task. Fan-out
      // is the structure the PRD's criterion names first, so the synthetic run
      // has to contain it rather than a flat mesh.
      for (let worker = 1; worker < FAN_OUT && index + worker < agents; worker += 1) {
        push(self, scaleAgentId(index + worker), 'assign_task', { worker })
      }
    }

    // Every agent reports to its hub — hubs therefore receive FAN_OUT - 1
    // reports each, which is the volume imbalance a fleet shows.
    for (let report = 0; report < messagesPerAgent; report += 1) {
      push(self, hub === index ? scaleAgentId(0) : scaleAgentId(hub), 'report_status', {
        report,
      })
    }
  }

  const run = normalizeTrace(
    parseAgentMessagesExport(rows, {
      label: options.label ?? `scale:${agents} agents`,
    }),
  )

  return { rows, run, agents }
}
