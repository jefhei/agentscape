/**
 * The spatial-insight criterion, stated as a comparison (M5-T4).
 *
 * PRD §7's primary metric is a *claim about reader effort*: the scene must
 * surface at least two structural facts **faster than a timeline does**. A cron
 * run cannot put a stopwatch on a human, and jsdom cannot show the scene at all,
 * so this module makes the claim in the only form that can be gated: for each
 * fact it states **what the reader must actually read** on each side.
 *
 * - **The timeline path** is the raw export as a linear stream. To answer a
 *   structural question there, a reader must read every message row, hold one
 *   counter per key while aggregating, and only then compare. There is no
 *   shortcut: a fan-out is only visible as a *set* of rows sharing a sender, a
 *   loop only as a *repeated direction* across time, and dominance only as a
 *   total. Stopping early produces a guess, not the answer.
 * - **The spatial path** is the drawn scene the M2/M3 layers build from the same
 *   trace. The answer is already encoded in a mark: node radius and glow carry
 *   activity (M2-T3, M3-T4), arc width carries volume, arc animation carries the
 *   net direction (M3-T2). So the reader reads **one mark** and does no
 *   aggregation — the mapping did it.
 *
 * ## The rule (pinned, and why the threshold is 4)
 *
 * A fact is `spatial-faster` when the transcript path must read at least
 * {@link CRITERION_MIN_ROW_RATIO} rows per scene mark. Four is the smallest
 * ratio that is a *difference in kind* rather than a slightly nicer read: below
 * it the stream is short enough that scanning it is not the bottleneck, and the
 * honest verdict is `too-small`. That gives the criterion a negative control —
 * the three-message dead-branch fixture must NOT qualify — so a passing report
 * cannot be an artefact of always saying yes.
 *
 * `not-drawn` is the third verdict and it is the important one: the run may carry
 * a fact (cost) that v1 has **no channel for**. The criterion counts only
 * `spatial-faster`, so a fact the scene does not draw can never pad the result.
 *
 * ## Purity (PRD §5)
 *
 * Pure: no React, no DOM, no three.js, no clock. It reads
 * {@link buildStructuralFacts}'s output and formats strings; the same run always
 * yields a byte-identical report.
 */

import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import type {
  InsightKind,
  StructuralFact,
  StructuralFactOptions,
  StructuralFacts,
} from './facts.ts'
import { buildStructuralFacts } from './facts.ts'

// ── Public vocabulary ───────────────────────────────────────────────────────

/** How many facts must be surfaced faster for the criterion to hold (PRD §7). */
export const CRITERION_MIN_FACTS = 2

/**
 * Rows per scene mark a fact must cost on the timeline side before the saving
 * counts as *faster* rather than *nicer*. See the module comment for why 4.
 */
export const CRITERION_MIN_ROW_RATIO = 4

/** The two ways to answer a structural question. */
export const ACCESS_CHANNELS = ['timeline', 'spatial'] as const

/** One of {@link ACCESS_CHANNELS}. */
export type AccessChannel = (typeof ACCESS_CHANNELS)[number]

/** The criterion's verdict for one fact. */
export const FACT_VERDICTS = ['spatial-faster', 'too-small', 'not-drawn'] as const

/** One of {@link FACT_VERDICTS}. */
export type FactVerdict = (typeof FACT_VERDICTS)[number]

/** What one side of the comparison costs the reader. */
export interface AccessPath {
  channel: AccessChannel
  /** What the reader reads, in words (`the message rows`, `one node's arc fan`). */
  channelName: string
  /**
   * Trace rows that must be read to answer the question. On the timeline side
   * this is the message count; on the spatial side it is `0` — the answer is not
   * in the stream any more.
   */
  rowsToScan: number
  /** Distinct keys (senders, pairs, agents) held while aggregating. */
  keysToHold: number
  /** Whether the reader must aggregate before the answer exists. */
  requiresAggregation: boolean
  /** Scene marks that carry the answer; `0` when the run has no such channel. */
  marksToRead: number
}

/** One fact, judged on both sides. */
export interface FactComparison {
  kind: InsightKind
  /** The question a reader asks (the criterion's candidate fact). */
  question: string
  /** The answer, as the fact derived it. */
  answer: string
  /** The agents the answer points at (the rail's focus targets), canonical order. */
  agentIds: AgentId[]
  /** Whether the run carries the data at all. */
  supported: boolean
  /** The transcript path. */
  timeline: AccessPath
  /** The scene path. */
  spatial: AccessPath
  /** `timeline.rowsToScan / spatial.marksToRead`, or `null` with no mark. */
  rowRatio: number | null
  /** The criterion's verdict for this fact. */
  verdict: FactVerdict
  /** The comparison in one sentence, with the numbers in it. */
  claim: string
  /** Why the fact is not drawn, or why the run is too small; else `null`. */
  reason: string | null
}

/** One run, judged against the criterion. */
export interface InsightReport {
  /** The run's id. */
  runId: string
  /** The run's label (as the HUD prints it). */
  label: string
  /** The facts behind the report. */
  facts: StructuralFacts
  /** Every fact, in {@link INSIGHT_KINDS} order, judged on both sides. */
  comparisons: FactComparison[]
  /** The kinds the scene surfaces faster than the transcript. */
  demonstrated: InsightKind[]
  /** The kinds the run cannot answer (no data, or no drawn channel). */
  unavailable: InsightKind[]
  /** `demonstrated.length >= CRITERION_MIN_FACTS`. */
  met: boolean
  /** The headline: `2 of 4 structural facts read off the scene faster than the transcript.` */
  verdictLine: string
  /** Honest limits of this run's encodings, for a report or a doc. */
  caveats: string[]
}

// ── The encodings, per kind ─────────────────────────────────────────────────

/**
 * The drawn channel that carries each fact, and the key a reader must hold while
 * aggregating the transcript instead. Named here in one place so the comparison
 * and the prose in `report.ts` cannot drift apart.
 */
interface EncodingSpec {
  /** The scene mark that carries the answer. */
  mark: string
  /** How the transcript must be aggregated. */
  aggregation: string
}

const ENCODINGS: Record<InsightKind, EncodingSpec> = {
  'fan-out': {
    mark: "one node's incident arc fan, with the net direction animating away (M3-T2)",
    aggregation: 'grouped by sender, counting distinct recipients',
  },
  loop: {
    mark: 'the heaviest two-way arc, drawn from both ends with no net flow to animate (M3-T2)',
    aggregation: 'folded into one counter pair per channel, then compared for symmetry',
  },
  imbalance: {
    mark: 'node radius and glow (activity, M2-T3/M3-T4) and arc width (volume)',
    aggregation: 'totalled per agent and per channel, then compared',
  },
  cost: {
    mark: 'nothing — v1 draws no cost channel (PRD §4.2 keeps a cost heat overlay post-MVP)',
    aggregation:
      'summed per agent from the export’s cost column, which v1 does not carry',
  },
}

/** Agents that address at least one other agent (the senders a reader groups by). */
function sendersOf(facts: StructuralFacts): number {
  return facts.fans.filter((fan) => fan.reach > 0).length
}

/** The keys a transcript reader holds per fact kind. */
function keysFor(fact: StructuralFact, facts: StructuralFacts): number {
  switch (fact.kind) {
    case 'fan-out':
      return sendersOf(facts)
    case 'loop':
      return facts.pairCount
    case 'imbalance':
      return fact.evidence.basis === 'channel' ? facts.pairCount : sendersOf(facts)
    case 'cost':
      return facts.fans.length
  }
}

// ── The comparison ──────────────────────────────────────────────────────────

/** Round a ratio to two decimals (a printed number must be stable). */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Judge one fact on both sides.
 *
 * @param fact a fact derived by {@link buildStructuralFacts}.
 * @param facts the derivation it came from (for the run's own totals).
 * @param messageCount the transcript's row count — what a timeline reader scans.
 */
function compareFact(
  fact: StructuralFact,
  facts: StructuralFacts,
  messageCount: number,
): FactComparison {
  const spec = ENCODINGS[fact.kind]
  const timeline: AccessPath = {
    channel: 'timeline',
    channelName: `the ${messageCount} message rows, ${spec.aggregation}`,
    rowsToScan: messageCount,
    keysToHold: keysFor(fact, facts),
    requiresAggregation: true,
    marksToRead: 0,
  }

  // A fact the run cannot answer has no mark either: the scene cannot draw what
  // the trace never recorded.
  const drawn = fact.supported
  const spatial: AccessPath = {
    channel: 'spatial',
    channelName: spec.mark,
    rowsToScan: 0,
    keysToHold: 0,
    requiresAggregation: false,
    marksToRead: drawn ? 1 : 0,
  }

  const rowRatio =
    spatial.marksToRead === 0 ? null : round2(messageCount / spatial.marksToRead)

  let verdict: FactVerdict
  let reason: string | null = null
  if (!drawn) {
    verdict = 'not-drawn'
    reason = fact.reason
  } else if (messageCount >= CRITERION_MIN_ROW_RATIO * spatial.marksToRead) {
    verdict = 'spatial-faster'
  } else {
    verdict = 'too-small'
    reason =
      `the transcript is only ${messageCount} ${messageCount === 1 ? 'row' : 'rows'} long, ` +
      `below the ${CRITERION_MIN_ROW_RATIO} rows per mark a saving has to clear`
  }

  const claim =
    verdict === 'spatial-faster'
      ? `${messageCount} rows to aggregate on the timeline vs one mark in the scene ` +
        `(${rowRatio}× fewer reads): ${spatial.channelName}`
      : verdict === 'too-small'
        ? `${messageCount} rows is too short a stream for the saving to matter`
        : `no drawn channel carries it: ${spec.mark}`

  return {
    kind: fact.kind,
    question: fact.question,
    answer: fact.answer,
    agentIds: [...fact.agentIds],
    supported: fact.supported,
    timeline,
    spatial,
    rowRatio,
    verdict,
    claim,
    reason,
  }
}

/** Caveats that qualify a run's result, derived from what the run actually is. */
function caveatsOf(
  facts: StructuralFacts,
  comparisons: FactComparison[],
  met: boolean,
): string[] {
  const caveats: string[] = []

  if (!facts.hierarchyDerivable) {
    caveats.push(
      'No spawn edge derives from this run’s action vocabulary, so its fan-out is counted as message ' +
        'reach (distinct agents addressed), not as a derived parent/child hierarchy — M5-T3 finding 3.',
    )
  }
  const cost = comparisons.find((comparison) => comparison.kind === 'cost')
  if (cost !== undefined && cost.verdict === 'not-drawn') {
    caveats.push(
      'Cost concentration cannot be compared at all: the export records no cost figures and v1 draws ' +
        'no cost channel, so the fact is reported as unavailable rather than as a tie.',
    )
  }
  if (!met) {
    caveats.push(
      `Fewer than ${CRITERION_MIN_FACTS} facts clear the ${CRITERION_MIN_ROW_RATIO}× rows-per-mark ` +
        'bar on this run: it is too small (or too evenly shaped) to demonstrate the criterion.',
    )
  }

  return caveats
}

// ── The report ──────────────────────────────────────────────────────────────

/**
 * Evaluate PRD §7's criterion on one normalized run.
 *
 * Pure and deterministic. The report says what the run's own data supports: which
 * facts the scene surfaces faster than the transcript, which it cannot answer,
 * and the caveats that qualify the result. It does **not** claim a human
 * time-to-insight — that needs a person in front of the scene (M5-T5) — and a
 * report whose `met` is false is a real result, not a failure to fix here.
 *
 * @param model a normalized trace (M1-T5).
 * @param options detector thresholds + an optional pre-derived edge model.
 */
export function evaluateSpatialCriterion(
  model: TraceModel,
  options: StructuralFactOptions = {},
): InsightReport {
  const facts = buildStructuralFacts(model, options)
  const comparisons = facts.facts.map((fact) =>
    compareFact(fact, facts, model.messages.length),
  )
  const demonstrated = comparisons
    .filter((comparison) => comparison.verdict === 'spatial-faster')
    .map((comparison) => comparison.kind)
  const unavailable = comparisons
    .filter((comparison) => comparison.verdict === 'not-drawn')
    .map((comparison) => comparison.kind)
  const met = demonstrated.length >= CRITERION_MIN_FACTS

  return {
    runId: model.id,
    label: model.label,
    facts,
    comparisons,
    demonstrated,
    unavailable,
    met,
    verdictLine: met
      ? `${demonstrated.length} of ${comparisons.length} structural facts read off the scene faster than the transcript`
      : `criterion not met: ${demonstrated.length} of ${CRITERION_MIN_FACTS} facts read off the scene faster than the transcript`,
    caveats: caveatsOf(facts, comparisons, met),
  }
}

/** The comparison for `kind`, or `null` when the report has none (a lookup). */
export function comparisonOf(
  report: InsightReport,
  kind: InsightKind,
): FactComparison | null {
  for (const comparison of report.comparisons) {
    if (comparison.kind === kind) return comparison
  }
  return null
}
