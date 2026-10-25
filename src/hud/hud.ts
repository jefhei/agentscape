/**
 * Run summary / HUD model (M4-T6) — the pure half of the overlay.
 *
 * The HUD answers the first question anyone asks of a trace they did not record:
 * *what am I looking at?* — its name, how many agents and messages it holds, how
 * long it ran, and what it cost. That is a *reading of the run's own facts*, so
 * it belongs here in the pure layer, where the shapes are typed and vitest pins
 * every number, and `ui/RunHud.tsx` is the thin consumer that prints them.
 *
 * ## Three overlays, three different questions
 *
 * The M4 surfaces deliberately do not repeat each other:
 *
 * - the **transport** (`src/playback/`) answers *where in time are we* — elapsed
 *   position, events fired, agents live at this instant;
 * - the **filter bar** (`src/filter/`) answers *what is visible* — what survives
 *   the current lens;
 * - the **HUD** answers *what is this run* — the whole trace's fixed totals,
 *   which do not move when the playhead moves or a lens narrows the scene.
 *
 * So the summary is a function of the run **alone**: no playhead, no filter, no
 * camera. If the HUD showed a filtered count it would lie about the trace, and
 * the filter bar already prints that number.
 *
 * ## Absent data is reported, never zeroed
 *
 * v1 ingests one format — a Supabase `agent_messages` export — and that export
 * carries no token or cost columns (`src/adapter/agentMessages.ts` sets them to
 * `0`). A run that cost nothing and an export that never recorded spend are
 * *different facts*, and printing `$0.00` for both would quietly misreport a
 * fleet run as free. So each of those figures carries a `recorded` flag: when
 * the export has no figures the fact prints {@link MISSING_FIGURE} and the
 * summary carries an {@link RunSummary.attributionNote} saying so.
 *
 * ## The numbers must agree with the run, or this fails loudly
 *
 * `RunMeta` is precomputed by normalization (M1-T5) from exactly these rules.
 * This module re-derives the counts and totals from the arrays and **checks the
 * two agree** — a summary whose headline contradicts the run it precedes is a
 * defect, not a rounding note (the same stance `inspect.ts` takes on
 * attribution). A disagreement throws {@link HudError}.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no React, no DOM, no three.js, no clock, no
 * `Math.random`, no mutation of the model. Formatting is *reused*, not
 * re-implemented: durations come from `playback/playback.ts`, token and cost
 * figures from `inspect/inspect.ts`, so the HUD, the transport and the inspector
 * cannot drift into three different spellings of the same number.
 */

import type { TraceSource } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { formatDuration } from '../playback/playback.ts'
import { formatCost, formatTokens } from '../inspect/inspect.ts'

// ── Public vocabulary ───────────────────────────────────────────────────────

/** Thrown when the run's own facts contradict the summary they would produce. */
export class HudError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HudError'
  }
}

/**
 * The figure printed for a metric the export did not record. An em dash, not a
 * zero: "no data" and "zero" are different facts and a HUD must not conflate
 * them.
 */
export const MISSING_FIGURE = '—'

/** The facts the HUD prints, in print order. */
export const HUD_FACT_IDS = Object.freeze([
  'agents',
  'messages',
  'toolCalls',
  'duration',
  'tokens',
  'cost',
] as const)

/** One of {@link HUD_FACT_IDS}. */
export type HudFactId = (typeof HUD_FACT_IDS)[number]

/**
 * One figure on the HUD: what it is, how it reads, and whether the trace
 * actually recorded it. The component renders these verbatim and decides
 * nothing — not the order, not the format, not what "missing" looks like.
 */
export interface HudFact {
  id: HudFactId
  /** The row's label, e.g. `Agents`. */
  label: string
  /** The formatted figure: `6`, `4:00`, `12,480`, `$0.0042`, or {@link MISSING_FIGURE}. */
  value: string
  /** A short qualifier under the figure (`1 broadcast`, `not recorded`), or `null`. */
  detail: string | null
  /** Whether the trace recorded this figure. `false` only for absent tokens/cost. */
  recorded: boolean
}

/** The run's raw counts, as the HUD and any host probe read them. */
export interface RunSummaryCounts {
  agents: number
  messages: number
  /** Broadcasts (`Message.to === null`) — already included in `messages`. */
  broadcasts: number
  toolCalls: number
  /**
   * Events in the unified stream (`messages + tool calls + the run bracket`).
   * Carried for completeness and for probes; the HUD prints the five named
   * facts, and the transport already reports event progress.
   */
  events: number
}

/**
 * Everything the HUD prints for one run, derived once. A pure function of the
 * trace: the playhead, the filter and the camera are deliberately absent.
 */
export interface RunSummary {
  /** The run's id, as the contract derives it. */
  runId: string
  /** Human-readable run name (printed as the HUD's title). */
  label: string
  /** The ingest format the run came from — provenance, printed as a chip. */
  source: TraceSource
  counts: RunSummaryCounts
  /** `endedAt - startedAt`, ms (`0` for an empty run). */
  durationMs: number
  /** Recorded tokens across the run; `0` when the export carries none. */
  totalTokens: number
  /** Recorded spend (USD) across the run; `0` when the export carries none. */
  totalCostUsd: number
  /** Whether the export actually carried token figures (`totalTokens > 0`). */
  tokensRecorded: boolean
  /** Whether the export actually carried cost figures (`totalCostUsd > 0`). */
  costRecorded: boolean
  /** Nothing was recorded: no messages and no tool calls. */
  empty: boolean
  /** `6 agents · 5 messages · 5 tool calls · 4:00`. */
  headline: string
  /** Which figures the export omits, or `null` when it recorded both. */
  attributionNote: string | null
  /** The figures in {@link HUD_FACT_IDS} order. */
  facts: HudFact[]
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** The figures re-derived from the run's arrays (the truth the HUD prints). */
interface DerivedFacts {
  agents: number
  messages: number
  broadcasts: number
  toolCalls: number
  events: number
  durationMs: number
  totalTokens: number
  totalCostUsd: number
}

/**
 * One pass over the run's arrays: counts, broadcast subset, tokens, spend and
 * the span. This is the same arithmetic normalization uses (M1-T5) — that is the
 * point, because {@link assertMetaAgrees} compares the two.
 */
function deriveFacts(model: TraceModel): DerivedFacts {
  let broadcasts = 0
  let totalTokens = 0
  let messageCostUsd = 0
  let firstAt = Infinity
  let lastAt = -Infinity

  for (const message of model.messages) {
    if (message.to === null) broadcasts += 1
    totalTokens += message.tokens
    messageCostUsd += message.costUsd
    if (message.at < firstAt) firstAt = message.at
    if (message.at > lastAt) lastAt = message.at
  }

  let toolCallCostUsd = 0
  for (const call of model.toolCalls) {
    toolCallCostUsd += call.costUsd
    if (call.at < firstAt) firstAt = call.at
    if (call.at > lastAt) lastAt = call.at
  }

  for (const event of model.events) {
    if (event.at < firstAt) firstAt = event.at
    if (event.at > lastAt) lastAt = event.at
  }

  return {
    agents: model.agents.length,
    messages: model.messages.length,
    broadcasts,
    toolCalls: model.toolCalls.length,
    events: model.events.length,
    durationMs: firstAt === Infinity ? 0 : lastAt - firstAt,
    totalTokens,
    totalCostUsd: messageCostUsd + toolCallCostUsd,
  }
}

/** Relative tolerance when comparing re-derived figures with the model's meta. */
const META_EPSILON = 1e-9

/** Whether two amounts agree to within float noise. */
function sameAmount(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= META_EPSILON * scale
}

/**
 * Prove the HUD's figures agree with the run's own `RunMeta` (M1-T5). Both are
 * derived from the same rules, so a disagreement means one of them drifted — and
 * a HUD whose headline contradicts its run is worse than no HUD, so this throws
 * rather than printing it.
 */
function assertMetaAgrees(model: TraceModel, derived: DerivedFacts): void {
  const checks: ReadonlyArray<readonly [string, number, number]> = [
    ['agent count', model.meta.agentCount, derived.agents],
    ['message count', model.meta.messageCount, derived.messages],
    ['broadcast count', model.meta.broadcastCount, derived.broadcasts],
    ['tool call count', model.meta.toolCallCount, derived.toolCalls],
    ['event count', model.meta.eventCount, derived.events],
    ['duration', model.meta.durationMs, derived.durationMs],
    ['token total', model.meta.totalTokens, derived.totalTokens],
    ['cost total', model.meta.totalCostUsd, derived.totalCostUsd],
  ]
  for (const [name, declared, recomputed] of checks) {
    if (!sameAmount(declared, recomputed)) {
      throw new HudError(
        `run summary drift on ${name}: meta says ${declared}, the run has ${recomputed}`,
      )
    }
  }
}

// ── Formatting (shared rules, composed not re-invented) ─────────────────────

/** `1 agent` / `6 agents` — a count with its noun, pluralized. */
function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** The HUD's one-line headline. */
function headlineOf(counts: RunSummaryCounts, durationMs: number): string {
  return [
    countLabel(counts.agents, 'agent', 'agents'),
    countLabel(counts.messages, 'message', 'messages'),
    countLabel(counts.toolCalls, 'tool call', 'tool calls'),
    formatDuration(durationMs),
  ].join(' · ')
}

/**
 * What the HUD says about figures the export did not carry. `null` when both
 * are recorded — a note that says nothing is a line of noise. An empty run gets
 * no note either: it records nothing because there is nothing, which the empty
 * state already says.
 */
function attributionNoteOf(
  tokensRecorded: boolean,
  costRecorded: boolean,
  empty: boolean,
): string | null {
  if (empty || (tokensRecorded && costRecorded)) return null
  if (!tokensRecorded && !costRecorded) {
    return 'This export records no token or cost data.'
  }
  return tokensRecorded
    ? 'This export records no cost data.'
    : 'This export records no token counts.'
}

// ── The summary ─────────────────────────────────────────────────────────────

/**
 * Build the HUD's whole model for one normalized run.
 *
 * Pure and deterministic: the same run always yields a byte-identical summary,
 * and nothing is mutated.
 *
 * @param model a normalized trace (M1-T5).
 * @returns the summary, with its figures already formatted.
 * @throws HudError when the run's arrays contradict its own `RunMeta`, or when a
 *         token/cost total is not a finite number (a trace that cannot be
 *         totalled must not print a total).
 */
export function buildRunSummary(model: TraceModel): RunSummary {
  const derived = deriveFacts(model)

  // Finiteness first: a trace that cannot be totalled must not print a total, and
  // this message says so instead of blaming a drift against a NaN meta.
  if (!Number.isFinite(derived.totalTokens)) {
    throw new HudError('run summary: token total is not a finite number')
  }
  if (!Number.isFinite(derived.totalCostUsd)) {
    throw new HudError('run summary: cost total is not a finite number')
  }

  assertMetaAgrees(model, derived)

  const counts: RunSummaryCounts = {
    agents: derived.agents,
    messages: derived.messages,
    broadcasts: derived.broadcasts,
    toolCalls: derived.toolCalls,
    events: derived.events,
  }
  const tokensRecorded = derived.totalTokens > 0
  const costRecorded = derived.totalCostUsd > 0
  const empty = counts.messages === 0 && counts.toolCalls === 0

  const facts: HudFact[] = [
    {
      id: 'agents',
      label: 'Agents',
      value: String(counts.agents),
      detail: null,
      recorded: true,
    },
    {
      id: 'messages',
      label: 'Messages',
      value: String(counts.messages),
      // A broadcast is a message with no single recipient, which is exactly the
      // kind of structural detail a total hides — worth one qualifier.
      detail:
        counts.broadcasts === 0
          ? null
          : countLabel(counts.broadcasts, 'broadcast', 'broadcasts'),
      recorded: true,
    },
    {
      id: 'toolCalls',
      label: 'Tool calls',
      value: String(counts.toolCalls),
      detail: null,
      recorded: true,
    },
    {
      id: 'duration',
      label: 'Duration',
      value: formatDuration(derived.durationMs),
      detail: null,
      recorded: true,
    },
    {
      id: 'tokens',
      label: 'Tokens',
      value: tokensRecorded ? formatTokens(derived.totalTokens) : MISSING_FIGURE,
      detail: tokensRecorded ? null : 'not recorded',
      recorded: tokensRecorded,
    },
    {
      id: 'cost',
      label: 'Cost',
      value: costRecorded ? formatCost(derived.totalCostUsd) : MISSING_FIGURE,
      detail: costRecorded ? null : 'not recorded',
      recorded: costRecorded,
    },
  ]

  return {
    runId: model.id,
    label: model.label,
    source: model.source,
    counts,
    durationMs: derived.durationMs,
    totalTokens: derived.totalTokens,
    totalCostUsd: derived.totalCostUsd,
    tokensRecorded,
    costRecorded,
    empty,
    headline: headlineOf(counts, derived.durationMs),
    attributionNote: attributionNoteOf(tokensRecorded, costRecorded, empty),
    facts,
  }
}

/** The fact with `id`, or `null` when the summary has none (a defensive lookup). */
export function hudFact(summary: RunSummary, id: HudFactId): HudFact | null {
  for (const fact of summary.facts) {
    if (fact.id === id) return fact
  }
  return null
}
