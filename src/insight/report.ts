/**
 * The M5-T4 write-up: the criterion's evidence, rendered from the numbers.
 *
 * PRD §7's machine gate for this task is "the criterion's evidence committed to
 * `docs/`". Evidence that is typed by hand drifts from the code the moment either
 * changes, so the doc is **generated from the reports** — every count, ratio and
 * verdict below is interpolated from {@link InsightReport} objects that
 * `scripts/insight-report.mjs` produced by running the real pipeline. The prose
 * is fixed; the numbers are not.
 *
 * What the doc deliberately does *not* do:
 *
 * - it does not claim a human time-to-insight. The effort model in
 *   `src/insight/access.ts` counts rows read vs marks read, which is auditable;
 *   a stopwatch on a person is M5-T5's session, not a cron run's;
 * - it does not report a failing run as a success. If fewer than
 *   {@link CRITERION_MIN_FACTS} facts clear the bar on the reference runs, the
 *   verdict says so and invokes PRD §7's consequence (ship as a demo, not a
 *   tool) instead of rounding up.
 *
 * Pure: string building only, no clock (the caller passes `generatedAt`), no DOM.
 */

import type { InsightKind } from './facts.ts'
import type { FactComparison, FactVerdict, InsightReport } from './access.ts'
import { CRITERION_MIN_FACTS, CRITERION_MIN_ROW_RATIO } from './access.ts'

/** Everything the doc needs, gathered by the probe. */
export interface InsightReportInput {
  /** `YYYY-MM-DD`, supplied by the caller (this module owns no clock). */
  generatedAt: string
  /** One report per run, in the order they should be printed. */
  reports: InsightReport[]
  /** The runs the PRD criterion is judged on (the reference shapes). */
  referenceRunIds: string[]
  /** The exact command that produced the file. */
  command: string
  /** Extra per-run prose the probe derived, keyed by run id. */
  notes?: Record<string, string[]>
}

/** The human name of a fact kind, for headings and tables. */
const KIND_LABEL: Record<InsightKind, string> = {
  'fan-out': 'Fan-out',
  loop: 'Loop',
  imbalance: 'Imbalance',
  cost: 'Cost',
}

/** A markdown table cell: no pipes, no newlines. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

/** The verdict as it prints in the table. */
function verdictCell(comparison: FactComparison): string {
  const ratio = comparison.rowRatio === null ? '' : ` (${comparison.rowRatio}×)`
  return `${comparison.verdict}${comparison.verdict === 'spatial-faster' ? ratio : ''}`
}

/** `N rows · K keys · aggregate` — the transcript path as one cell. */
function timelineCell(comparison: FactComparison): string {
  const { timeline } = comparison
  const keys = `${timeline.keysToHold} ${timeline.keysToHold === 1 ? 'key' : 'keys'}`
  return `${timeline.rowsToScan} rows · ${keys} · aggregate`
}

/** `1 mark · <channel>` — the scene path as one cell. */
function spatialCell(comparison: FactComparison): string {
  const { spatial } = comparison
  return spatial.marksToRead === 0
    ? `no mark · ${spatial.channelName}`
    : `${spatial.marksToRead} mark · ${spatial.channelName}`
}

/** The kinds a report surfaced faster, in report order. */
function demonstratedLabels(report: InsightReport): string {
  return report.demonstrated.length === 0
    ? 'none'
    : report.demonstrated.map((kind) => KIND_LABEL[kind]).join(', ')
}

/** The verdict tally across kinds, e.g. `2 faster · 1 too small · 1 not drawn`. */
function tally(report: InsightReport): string {
  const counts = new Map<FactVerdict, number>()
  for (const comparison of report.comparisons) {
    counts.set(comparison.verdict, (counts.get(comparison.verdict) ?? 0) + 1)
  }
  const parts: string[] = []
  const faster = counts.get('spatial-faster') ?? 0
  const small = counts.get('too-small') ?? 0
  const drawn = counts.get('not-drawn') ?? 0
  if (faster > 0) parts.push(`${faster} faster`)
  if (small > 0) parts.push(`${small} too small`)
  if (drawn > 0) parts.push(`${drawn} not drawn`)
  return parts.join(' · ')
}

/**
 * Render the whole document.
 *
 * @param input the reports, their reference set and the command that made them.
 * @returns markdown, ready to write to `docs/spatial-insight.md`.
 */
export function renderInsightMarkdown(input: InsightReportInput): string {
  const reference = input.reports.filter((report) =>
    input.referenceRunIds.includes(report.runId),
  )
  const metReferences = reference.filter((report) => report.met)
  const criterionHolds =
    reference.length > 0 && metReferences.length === reference.length
  const lines: string[] = []

  lines.push('# AgentScape — the spatial-insight criterion, demonstrated (M5-T4)', '')
  lines.push(
    `Generated ${input.generatedAt} from the committed fixtures and the real \`debian2_bot\` export.`,
    '',
    '## The claim',
    '',
    'PRD §7 makes one metric load-bearing: **the scene must surface at least two structural facts ' +
      'faster than a timeline does** on the reference run, from the candidates — total fan-out per ' +
      'agent, an unbounded/looping sub-agent, message-volume imbalance, cost concentration. If it ' +
      'cannot be demonstrated, the project ships as a demo and is reported as such.',
    '',
    'A flat timeline answers *what happened, in order?* It cannot answer *what shape is this?* ' +
      'without the reader reconstructing the shape by eye: a fan-out is only visible as a set of ' +
      'rows that share a sender, a loop only as a repeated direction across time, and dominance ' +
      'only as a total nobody computed. The scene encodes those quantities directly — node radius ' +
      'and glow carry activity, arc width carries volume, arc animation carries the net direction — ' +
      'so the answer is read off a mark instead of aggregated out of a stream.',
    '',
    '## How the comparison is measured',
    '',
    'A human stopwatch is not available to an automated run, so the claim is measured as **reader ' +
      'work, counted**:',
    '',
    `- the **timeline path** must read every message row (a fan-out can hide in the last row), hold ` +
      'one counter per key while aggregating, and then compare;',
    '- the **scene path** reads **one mark**, because the mapping already did the aggregation;',
    `- a fact counts as \`spatial-faster\` when the transcript costs at least ${CRITERION_MIN_ROW_RATIO} ` +
      'rows per scene mark. Below that the stream is short enough that scanning it is not the ' +
      'bottleneck, and the honest verdict is `too-small`;',
    '- a fact the run cannot answer, or that v1 draws no channel for, is `not-drawn` and can never ' +
      'count towards the criterion.',
    '',
    `This is auditable but it is not a stopwatch: it bounds *what must be read*, not *how long a ` +
      'person takes*. The PRD’s `< 60 s` time-to-first-insight metric needs a person in front of the ' +
      'scene, and that is the human-held review loop (M5-T5) — no verdict for it is recorded here.',
    '',
    '## Result',
    '',
    `Criterion requires **${CRITERION_MIN_FACTS} facts** surfaced faster than the transcript.`,
    '',
    '| run | agents | messages | facts faster | verdict | tally |',
    '|---|---|---|---|---|---|',
  )

  for (const report of input.reports) {
    const isReference = input.referenceRunIds.includes(report.runId)
    lines.push(
      `| ${cell(report.label)}${isReference ? ' (reference)' : ''} | ${report.facts.fans.length} | ` +
        `${report.comparisons[0]?.timeline.rowsToScan ?? 0} | ${demonstratedLabels(report)} | ` +
        `${report.met ? '**met**' : 'not met'} | ${tally(report)} |`,
    )
  }
  lines.push('')

  if (criterionHolds) {
    lines.push(
      `**The criterion holds on ${metReferences.length} of ${reference.length} reference runs** ` +
        `(${metReferences.map((report) => report.label).join(', ')}): each surfaces at least ` +
        `${CRITERION_MIN_FACTS} of the four candidate facts with a single mark per fact.`,
      '',
    )
  } else if (reference.length === 0) {
    lines.push(
      '**No reference run was supplied**, so the criterion is not judged here — this is a report of ' +
        'the runs that were measured and nothing more.',
      '',
    )
  } else {
    lines.push(
      `**The criterion does NOT hold**: ${reference.length - metReferences.length} of ` +
        `${reference.length} reference runs surface fewer than ${CRITERION_MIN_FACTS} facts faster ` +
        'than a transcript. Per PRD §7 the project ships as a **demo**, not a tool, until that is fixed.',
      '',
    )
  }

  lines.push('## The comparison, run by run', '')

  for (const report of input.reports) {
    lines.push(`### ${report.label}`, '')
    lines.push(
      `\`${report.runId}\` · ${report.facts.fans.length} agents · ` +
        `${report.comparisons[0]?.timeline.rowsToScan ?? 0} message rows · ` +
        `${report.facts.pairCount} channels · ` +
        `${report.facts.edgeCounts.spawn} spawn / ${report.facts.edgeCounts.handoff} handoff / ` +
        `${report.facts.edgeCounts.message} message edges`,
      '',
      '| fact | verdict | timeline path | scene path | answer |',
      '|---|---|---|---|---|',
    )
    for (const comparison of report.comparisons) {
      lines.push(
        `| ${KIND_LABEL[comparison.kind]} | ${verdictCell(comparison)} | ` +
          `${cell(timelineCell(comparison))} | ${cell(spatialCell(comparison))} | ` +
          `${cell(comparison.answer)} |`,
      )
    }
    lines.push('')

    const reasons = report.comparisons.filter(
      (comparison) => comparison.reason !== null && comparison.verdict !== 'too-small',
    )
    const bullets: string[] = reasons.map(
      (comparison) => `${KIND_LABEL[comparison.kind]}: ${comparison.reason}`,
    )
    const small = report.comparisons.filter(
      (comparison) => comparison.verdict === 'too-small',
    )
    if (small.length > 0) {
      bullets.push(
        `${small.map((comparison) => KIND_LABEL[comparison.kind]).join(' and ')}: ` +
          `the transcript is only ${report.comparisons[0]?.timeline.rowsToScan ?? 0} rows — below the ` +
          `${CRITERION_MIN_ROW_RATIO} rows per mark a saving has to clear.`,
      )
    }
    const notes = input.notes?.[report.runId] ?? []
    bullets.push(...notes)
    for (const caveat of report.caveats) {
      if (caveat.startsWith('Fewer than')) bullets.push(caveat)
    }
    if (bullets.length > 0) {
      for (const bullet of bullets) lines.push(`- ${bullet}`)
      lines.push('')
    }
  }

  lines.push('## What each candidate turns into on screen', '')
  const byKind = new Map<InsightKind, InsightReport[]>()
  for (const report of input.reports) {
    for (const kind of report.demonstrated) {
      const list = byKind.get(kind) ?? []
      list.push(report)
      byKind.set(kind, list)
    }
  }
  for (const kind of ['fan-out', 'loop', 'imbalance', 'cost'] as InsightKind[]) {
    const reports = byKind.get(kind) ?? []
    const comparison = input.reports
      .map((report) => report.comparisons.find((entry) => entry.kind === kind))
      .find((entry) => entry !== undefined && entry.verdict === 'spatial-faster')
    if (comparison === undefined) {
      lines.push(`- **${KIND_LABEL[kind]}** — not demonstrated on any measured run.`)
      continue
    }
    lines.push(
      `- **${KIND_LABEL[kind]}** — ${comparison.spatial.channelName}. ` +
        `On the timeline: ${comparison.timeline.rowsToScan} rows and ` +
        `${comparison.timeline.keysToHold} ${comparison.timeline.keysToHold === 1 ? 'key' : 'keys'}, ` +
        'aggregated by hand. ' +
        `Demonstrated on ${reports.length} ${reports.length === 1 ? 'run' : 'runs'}.`,
    )
  }
  lines.push('')

  lines.push(
    '## The readout in the app',
    '',
    'The criterion is also visible in the product, not only in this document: the',
    'structural readout (`src/ui/InsightRail.tsx`) prints the same report beside the',
    'scene, one row per fact the run supports, and each row selects the agent the fact',
    'points at. A mount smoke test — **not** a look review — on the real fleet run:',
    '',
    '![The structural readout over the real fleet run](screenshots/insight-rail-fleet.png)',
    '',
    'It prints only what that run supports — the facts listed in its section above — and',
    'nothing it does not: no loop row, because the loop detector rejected the busiest',
    'channel there; no cost row, because nothing was recorded. The blown-out hub and the',
    'over-wide frame in that shot are the known M5-T3 look defects, not new ones — judging',
    'them is M5-T5’s job.',
    '',
    '## Limits of this evidence',
    '',
  )
  const caveats = new Set<string>()
  for (const report of input.reports) {
    // A run's own "too small" result is printed in that run's section; the limits
    // section aggregates only what holds across the measured set.
    for (const caveat of report.caveats) {
      if (!caveat.startsWith('Fewer than')) caveats.add(caveat)
    }
  }
  if (caveats.size === 0) {
    lines.push(
      '- None: every measured run answered all four candidates from a drawn channel.',
    )
  } else {
    for (const caveat of caveats) lines.push(`- ${caveat}`)
  }
  lines.push(
    '',
    '- The scene’s *look* is not judged here (jsdom has no GPU). Whether a human actually reads the ' +
      'structure faster is the human-held review loop, M5-T5.',
    '- The effort model counts what must be read; it does not model how easily a mark is read. A ' +
      'blown-out node or an over-wide frame (M5-T3 findings 1–2) can still cost a reader time, which ' +
      'is exactly what M5-T5 has to look at.',
    '',
    '## Reproduce',
    '',
    '```sh',
    input.command,
    '```',
    '',
  )

  return `${lines.join('\n')}`
}

/** One line per run, for a probe's console output. */
export function describeInsight(report: InsightReport): string {
  return (
    `${report.label.padEnd(34)} ${report.met ? 'met ' : 'MISS'} ` +
    `${report.demonstrated.length}/${report.comparisons.length} ` +
    `(${demonstratedLabels(report)})`
  )
}
